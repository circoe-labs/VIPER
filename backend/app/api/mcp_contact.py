"""The contact draft tools of `/mcp`: an assistant writes or rewrites the mail of one step of a
prospect's sequence — and it stays a draft (HANDOFF §9, phase 2).

- `viper_generate_contact_draft`: the AI draft of the step, through the same preparation, generator
  and save as « Générer avec l'IA » (`POST /api/prospects/{id}/messages/{step}/generate`);
- `viper_update_contact_draft`: create the step's message or change a draft's content, through the
  same save as the editor (`PUT /api/prospects/{id}/messages/{step}`), revision checked.

Both need the capability `contact.draft` (checked by `app.api.mcp.require` before the handler; a
worker never has it by default) and call the services with `allow_agent=True`: the agent stays the
actor (audit « Agent · … · pour <person> »), and the service refuses it anything but a new message
or a `draft` (409 `agent_draft_only`). Validation, scheduling, sending, cancelling and reopening are
not exposed. The answers are the REST output models (`MessageResultOut`, `GenerationResultOut`).
Contract: `doc/architecture/mcp-server.md` §3.11.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from app.api.routes import contact_messages as message_routes
from app.core.actor import ActorContext
from app.core.config import Settings
from app.core.contact_steps import STEP_CODE_PATTERN, parse_step
from app.models.contact_messages import EMAIL_MAX_LENGTH, SUBJECT_MAX_LENGTH
from app.services import contact_mail_generation as generation
from app.services import contact_messages as service
from app.services.contact_messages import GeneratedContent, MessageEdit
from app.services.errors import InvalidFieldError
from app.services.mail_generation.openai_client import (
    MailGenerator,
    missing_settings,
    not_configured,
)
from app.services.mail_generation.prompt import MAX_INSTRUCTION_LENGTH, PROMPT_VERSION
from app.services.prospect_score import ScoreConfig

CAPABILITY = "contact.draft"


@dataclass(frozen=True, slots=True)
class DraftContext:
    session: Session
    # The calling agent (`ActorType.AGENT`): the actor the services record.
    actor: ActorContext
    # The app's `State` (settings, OpenAI transport): what the REST routes read from `request`.
    state: Any


type Handler = Callable[[DraftContext, dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True, slots=True)
class DraftTool:
    name: str
    description: str
    input_schema: dict[str, Any]
    handler: Handler
    # Advisory for the host (MCP `ToolAnnotations`): a draft write, never destructive.
    open_world: bool
    capability: str = CAPABILITY

    def definition(self) -> dict[str, Any]:
        """The `tools/list` entry."""
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
            "annotations": {
                "readOnlyHint": False,
                "destructiveHint": False,
                "idempotentHint": False,
                "openWorldHint": self.open_world,
            },
        }


def mail_generator(state: Any) -> MailGenerator | None:
    """The generator `viper_generate_contact_draft` calls — the REST route's (tests replace it)."""
    return message_routes.mail_generator_for(state)


# --- argument parsing (the JSON Schema is advisory: a client may send anything) ----------------


def _prospect_id(args: dict[str, Any]) -> uuid.UUID:
    try:
        return uuid.UUID(str(args.get("prospect_id")))
    except (TypeError, ValueError) as error:
        raise InvalidFieldError("prospect_id", "Expected a UUID.", "format") from error


def _rank(args: dict[str, Any]) -> int:
    step = args.get("step")
    rank = parse_step(step) if isinstance(step, str) else None
    if rank is None:
        raise InvalidFieldError("step", "Expected `contact`, `r1`, `r2`…", "format")
    return rank


def _body[M: BaseModel](model: type[M], args: dict[str, Any]) -> M:
    """The REST body model, from the arguments other than the target (same limits, same
    `extra="forbid"`: a status, a validation or a send moment is never accepted)."""
    fields = {key: value for key, value in args.items() if key not in ("prospect_id", "step")}
    try:
        return model.model_validate(fields)
    except ValidationError as error:
        first = error.errors()[0]
        field = ".".join(str(part) for part in first["loc"]) or "arguments"
        raise InvalidFieldError(field, first["msg"], "invalid") from error


def _json(model: BaseModel) -> dict[str, Any]:
    dumped: dict[str, Any] = model.model_dump(mode="json")
    return dumped


# --- handlers ----------------------------------------------------------------------------------


def _update_draft(ctx: DraftContext, args: dict[str, Any]) -> dict[str, Any]:
    prospect_id, rank = _prospect_id(args), _rank(args)
    body = _body(message_routes.MessageContentIn, args)
    settings: Settings = ctx.state.settings
    result = service.save_message(
        ctx.session,
        ctx.actor,
        prospect_id,
        rank,
        MessageEdit(
            expected_revision=body.expected_revision,
            from_email=body.from_email,
            subject=body.subject,
            body_text=body.body_text,
            to=body.to,
            cc=body.cc,
            bcc=body.bcc,
            provided=frozenset(body.model_fields_set),
        ),
        default_from=settings.default_outbound_email,
        allow_agent=True,
    )
    return _json(message_routes.result_out(result))


def _generate_draft(ctx: DraftContext, args: dict[str, Any]) -> dict[str, Any]:
    prospect_id, rank = _prospect_id(args), _rank(args)
    body = _body(message_routes.GenerateIn, args)
    settings: Settings = ctx.state.settings
    # Every refusal (closed sequence, revision, a validated/scheduled step, text without
    # `replace`) comes before the AI call.
    prompt = generation.prepare(
        ctx.session,
        ctx.actor,
        prospect_id,
        rank,
        generation.GenerationRequest(
            expected_revision=body.expected_revision,
            instruction=body.instruction,
            replace=body.replace,
        ),
        booking_url=settings.contact_booking_url,
        score_config=ScoreConfig.from_settings(settings),
        limits=generation.ContextLimits.from_settings(settings),
        initial_prompt=settings.contact_initial_prompt,
        allow_agent=True,
    )
    generator = mail_generator(ctx.state)
    if generator is None:
        raise not_configured(missing_settings(settings))
    # Unlike the REST route, the call runs inside the MCP request's transaction (one savepoint
    # per tool call): a failed AI call writes nothing, and the save below checks every rule again.
    mail = generation.draft(generator, prompt, prospect_id=prospect_id, rank=rank)
    result = service.save_generated(
        ctx.session,
        ctx.actor,
        prospect_id,
        rank,
        GeneratedContent(
            subject=mail.subject,
            body_text=mail.body,
            model=mail.model,
            prompt_version=PROMPT_VERSION,
        ),
        body.expected_revision,
        default_from=settings.default_outbound_email,
        allow_agent=True,
    )
    out = message_routes.result_out(result)
    return _json(
        message_routes.GenerationResultOut(
            **out.model_dump(),
            generation=message_routes.GenerationOut(
                model=mail.model, prompt_version=PROMPT_VERSION
            ),
        )
    )


# --- catalogue ---------------------------------------------------------------------------------

_TARGET: dict[str, Any] = {
    "prospect_id": {"type": "string", "format": "uuid"},
    "step": {
        "type": "string",
        "pattern": STEP_CODE_PATTERN,
        "description": "`contact` (first mail), `r1`, `r2`… up to the sequence's « max relances ».",
    },
    "expected_revision": {
        "type": "integer",
        "minimum": 1,
        "description": (
            "The `revision` read with viper_get_prospect_messages. Omit it only when the step has "
            "no message yet."
        ),
    },
}
_ADDRESSES: dict[str, Any] = {
    "type": "array",
    "items": {"type": "string", "maxLength": EMAIL_MAX_LENGTH},
    "maxItems": service.MAX_RECIPIENTS,
}

TOOLS: tuple[DraftTool, ...] = (
    DraftTool(
        name="viper_generate_contact_draft",
        description=(
            "Have VIPER's mail AI write the draft of one step (Contact, R1…) of a prospect's "
            "sequence, from the prospect's record and an optional `instruction`. The result is "
            "always a draft a person reviews, validates and schedules in VIPER; nothing is sent. "
            "Pass `replace: true` to overwrite a draft that already has a text. A validated, "
            "scheduled, cancelled or sent message is refused (`agent_draft_only`)."
        ),
        input_schema={
            "type": "object",
            "properties": {
                **_TARGET,
                "instruction": {"type": "string", "maxLength": MAX_INSTRUCTION_LENGTH},
                "replace": {"type": "boolean"},
            },
            "required": ["prospect_id", "step"],
            "additionalProperties": False,
        },
        handler=_generate_draft,
        open_world=True,
    ),
    DraftTool(
        name="viper_update_contact_draft",
        description=(
            "Create the draft of one step (Contact, R1…) of a prospect's sequence, or change a "
            "draft's subject, body, sender or recipients. Omitted fields keep their value. The "
            "message stays a draft a person validates and schedules in VIPER; nothing is sent. "
            "A validated, scheduled, cancelled or sent message is refused (`agent_draft_only`); "
            "a stale `expected_revision` answers `revision_conflict` — read the messages again."
        ),
        input_schema={
            "type": "object",
            "properties": {
                **_TARGET,
                "subject": {"type": "string", "maxLength": SUBJECT_MAX_LENGTH},
                "body_text": {"type": "string", "maxLength": message_routes.BODY_MAX_LENGTH},
                "from_email": {
                    "type": ["string", "null"],
                    "maxLength": EMAIL_MAX_LENGTH,
                },
                "to": _ADDRESSES,
                "cc": _ADDRESSES,
                "bcc": _ADDRESSES,
            },
            "required": ["prospect_id", "step"],
            "additionalProperties": False,
        },
        handler=_update_draft,
        open_world=False,
    ),
)

BY_NAME: dict[str, DraftTool] = {tool.name: tool for tool in TOOLS}
