"""Contact messages API (`/api/prospects/{id}/messages`, Contact port Slice S3; handoff Task 12).

Thin routes over `app.services.contact_messages` (the state machine, its rules and refusal
codes). No route writes a status directly and none marks a message `sent`: that is the
dispatcher's internal operation (S7).

- `GET  …/messages`                  the three steps (always Contact, R1, R2), the defaults of a
                                     new message and whether the sequence is closed;
- `GET  …/messages/{step}`           one step's message (null when never created);
- `PUT  …/messages/{step}`           create (no `expected_revision`, 201) or edit the content (200);
- `POST …/messages/{step}/validate|schedule|unschedule|cancel|reopen` with `expected_revision`;
- `POST …/messages/{step}/generate`   the AI draft of the step (S5): always a draft, to review.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response, status
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy.orm import Session, sessionmaker

from app.api.dependencies import CurrentActor, SessionDep, SettingsDep
from app.api.errors import business_errors
from app.core.actor import ActorContext
from app.core.config import Settings
from app.db.session import unit_of_work
from app.models import ContactMessage
from app.models.contact_messages import EMAIL_MAX_LENGTH, SUBJECT_MAX_LENGTH
from app.models.enums import ContactMessageStatus, ContactMessageStep, ContactTrackingStatus
from app.services import audit
from app.services import contact_mail_generation as generation
from app.services import contact_messages as service
from app.services.contact_messages import (
    MAX_RECIPIENTS,
    GeneratedContent,
    MessageEdit,
    MessageResult,
)
from app.services.mail_generation.openai_client import (
    GeneratedMail,
    MailGenerator,
    OpenAIMailGenerator,
    config_from_settings,
    missing_settings,
    not_configured,
)
from app.services.mail_generation.prompt import MAX_INSTRUCTION_LENGTH, PROMPT_VERSION

router = APIRouter(prefix="/prospects/{prospect_id}/messages", tags=["contact"])

Address = Annotated[str, StringConstraints(max_length=EMAIL_MAX_LENGTH)]
Addresses = Annotated[list[Address], Field(max_length=MAX_RECIPIENTS)]
BODY_MAX_LENGTH = 100_000
Revision = Annotated[int, Field(ge=1)]


class StrictModel(BaseModel):
    # A status, a validation or a send moment is never part of a content save.
    model_config = ConfigDict(extra="forbid")


class MessageContentIn(StrictModel):
    """Omitted fields keep their value (or the default of a new message); `from_email: null`
    clears the sender."""

    # Omitted/null: create the step's message. Else: the revision the client read.
    expected_revision: Revision | None = None
    from_email: Address | None = None
    subject: Annotated[str, StringConstraints(max_length=SUBJECT_MAX_LENGTH)] | None = None
    body_text: Annotated[str, StringConstraints(max_length=BODY_MAX_LENGTH)] | None = None
    to: Addresses | None = None
    cc: Addresses | None = None
    bcc: Addresses | None = None


class RevisionIn(StrictModel):
    expected_revision: Revision


class ScheduleIn(RevisionIn):
    # ISO 8601 with a time zone offset; strictly in the future.
    scheduled_at: AwareDatetime


class MessageOut(BaseModel):
    id: uuid.UUID
    prospect_id: uuid.UUID
    step: ContactMessageStep
    status: ContactMessageStatus
    from_email: str | None
    to: list[str]
    cc: list[str]
    bcc: list[str]
    subject: str
    body_text: str
    revision: int
    validated_revision: int | None
    validated_at: datetime | None
    validated_by: str | None
    scheduled_at: datetime | None
    sent_at: datetime | None
    cancelled_at: datetime | None
    cancel_reason: str | None
    generation_model: str | None
    generation_prompt_version: str | None
    generated_at: datetime | None
    has_remote_draft: bool
    last_error_code: str | None
    last_error_at: datetime | None
    created_at: datetime
    updated_at: datetime


class SequenceOut(BaseModel):
    prospect_id: uuid.UUID
    # The prospect's Contact state; null without a tracking.
    state: ContactTrackingStatus | None
    do_not_contact: bool
    # Closed: no message may be created, edited, validated, scheduled or reopened.
    closed: bool


class DefaultsOut(BaseModel):
    from_email: str | None
    to: list[str]
    # The AI drafting is configured (`VIPER_OPENAI_API_KEY` and `VIPER_OPENAI_MODEL`).
    generation_available: bool


class StepOut(BaseModel):
    step: ContactMessageStep
    message: MessageOut | None


class MessagesOut(BaseModel):
    sequence: SequenceOut
    defaults: DefaultsOut
    steps: list[StepOut]


class GenerateIn(StrictModel):
    # Omitted/null: the step has no message yet. Else the revision the client read.
    expected_revision: Revision | None = None
    # The person's short instruction (« consigne ») for this version.
    instruction: Annotated[str, StringConstraints(max_length=MAX_INSTRUCTION_LENGTH)] | None = None
    # Confirms that the saved subject/body are replaced (required when the step has a text).
    replace: bool = False


class GenerationOut(BaseModel):
    model: str
    prompt_version: str


class StepMessageOut(BaseModel):
    message: MessageOut | None


class MessageResultOut(BaseModel):
    message: MessageOut
    created: bool
    changed: bool
    unvalidated: bool


class GenerationResultOut(MessageResultOut):
    generation: GenerationOut


def get_mail_generator(settings: SettingsDep) -> MailGenerator | None:
    """The OpenAI adapter, or None when the drafting is not configured (tests override this)."""
    config = config_from_settings(settings)
    if config is None:
        return None
    return OpenAIMailGenerator(config, booking_url=settings.contact_booking_url)


MailGeneratorDep = Annotated[MailGenerator | None, Depends(get_mail_generator)]


def message_out(message: ContactMessage) -> MessageOut:
    return MessageOut(
        id=message.id,
        prospect_id=message.prospect_id,
        step=message.step,
        status=message.status,
        from_email=message.from_email,
        to=list(message.to_recipients),
        cc=list(message.cc_recipients),
        bcc=list(message.bcc_recipients),
        subject=message.subject,
        body_text=message.body_text,
        revision=message.revision,
        validated_revision=message.validated_revision,
        validated_at=message.validated_at,
        validated_by=message.validated_by_display,
        scheduled_at=message.scheduled_at,
        sent_at=message.sent_at,
        cancelled_at=message.cancelled_at,
        cancel_reason=message.cancel_reason,
        generation_model=message.generation_model,
        generation_prompt_version=message.generation_prompt_version,
        generated_at=message.generated_at,
        has_remote_draft=message.remote_draft_id is not None,
        last_error_code=message.last_error_code,
        last_error_at=message.last_error_at,
        created_at=message.created_at,
        updated_at=message.updated_at,
    )


def result_out(result: MessageResult) -> MessageResultOut:
    return MessageResultOut(
        message=message_out(result.message),
        created=result.created,
        changed=result.changed,
        unvalidated=result.unvalidated,
    )


@router.get("")
def list_messages(
    prospect_id: uuid.UUID, session: SessionDep, settings: SettingsDep
) -> MessagesOut:
    with business_errors():
        read = service.prospect_messages(session, prospect_id, settings.default_outbound_email)
    context = read.context
    return MessagesOut(
        sequence=SequenceOut(
            prospect_id=context.prospect_id,
            state=context.state,
            do_not_contact=context.do_not_contact,
            closed=context.closed,
        ),
        defaults=DefaultsOut(
            from_email=read.defaults.from_email,
            to=read.defaults.to,
            generation_available=settings.generation_available,
        ),
        steps=[
            StepOut(step=step, message=message_out(message) if message else None)
            for step, message in read.messages.items()
        ],
    )


@router.get("/{step}")
def get_message(
    prospect_id: uuid.UUID, step: ContactMessageStep, session: SessionDep
) -> StepMessageOut:
    with business_errors():
        message = service.get_message(session, prospect_id, step)
    return StepMessageOut(message=message_out(message) if message else None)


@router.put("/{step}")
def save_message(
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
    body: MessageContentIn,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    actor: CurrentActor,
) -> MessageResultOut:
    """Create (201) or edit (200). Editing a validated or scheduled message sends it back to
    draft (`unvalidated: true`); an identical save changes nothing (`changed: false`)."""
    edit = MessageEdit(
        expected_revision=body.expected_revision,
        from_email=body.from_email,
        subject=body.subject,
        body_text=body.body_text,
        to=body.to,
        cc=body.cc,
        bcc=body.bcc,
        provided=frozenset(body.model_fields_set),
    )
    with business_errors():
        result = service.save_message(
            session, actor, prospect_id, step, edit, default_from=settings.default_outbound_email
        )
    if result.created:
        response.status_code = status.HTTP_201_CREATED
    return result_out(result)


@router.post("/{step}/validate")
def validate(
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
    body: RevisionIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MessageResultOut:
    with business_errors():
        result = service.validate(session, actor, prospect_id, step, body.expected_revision)
    return result_out(result)


@router.post("/{step}/schedule")
def schedule(
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
    body: ScheduleIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MessageResultOut:
    with business_errors():
        result = service.schedule(
            session,
            actor,
            prospect_id,
            step,
            body.expected_revision,
            body.scheduled_at,
            now=datetime.now(UTC),
        )
    return result_out(result)


@router.post("/{step}/unschedule")
def unschedule(
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
    body: RevisionIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MessageResultOut:
    with business_errors():
        result = service.unschedule(session, actor, prospect_id, step, body.expected_revision)
    return result_out(result)


@router.post("/{step}/cancel")
def cancel(
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
    body: RevisionIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MessageResultOut:
    with business_errors():
        result = service.cancel(session, actor, prospect_id, step, body.expected_revision)
    return result_out(result)


@router.post("/{step}/reopen")
def reopen(
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
    body: RevisionIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MessageResultOut:
    with business_errors():
        result = service.reopen(session, actor, prospect_id, step, body.expected_revision)
    return result_out(result)


@router.post("/{step}/generate")
def generate(
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
    body: GenerateIn,
    request: Request,
    response: Response,
    session: SessionDep,
    settings: SettingsDep,
    actor: CurrentActor,
    generator: MailGeneratorDep,
) -> GenerationResultOut:
    """The AI draft of the step (decision 22): subject and body written by the AI, always a
    `draft` to review and validate — 201 when it creates the step's message, else 200; a validated
    message goes back to draft (`unvalidated: true`).
    A failed or unconfigured AI answers its `ai_*` code and changes nothing."""
    with business_errors():
        prompt = generation.prepare(
            session,
            actor,
            prospect_id,
            step,
            generation.GenerationRequest(
                expected_revision=body.expected_revision,
                instruction=body.instruction,
                replace=body.replace,
            ),
            booking_url=settings.contact_booking_url,
        )
        if generator is None:
            raise not_configured(missing_settings(settings))
    audit_binding = audit.binding(session)
    # The AI call can last a minute: the request's transaction (which may hold the session row
    # lock of the auth's last-seen update) ends here, and the write below runs in its own unit of
    # work, which checks every rule again. `session` is not used after this commit.
    session.commit()
    with business_errors():
        mail = generation.draft(generator, prompt, prospect_id=prospect_id, step=step)
    result = _save_generated(request, settings, actor, audit_binding, prospect_id, step, body, mail)
    if result.created:
        response.status_code = status.HTTP_201_CREATED
    return result


def _save_generated(
    request: Request,
    settings: Settings,
    actor: ActorContext,
    audit_binding: tuple[ActorContext, audit.AuditContext] | None,
    prospect_id: uuid.UUID,
    step: ContactMessageStep,
    body: GenerateIn,
    mail: GeneratedMail,
) -> GenerationResultOut:
    session_factory: sessionmaker[Session] = request.app.state.session_factory
    with unit_of_work(session_factory) as write:
        # Same actor and request id as the request's binding (one save, one history entry).
        audit.bind(write, actor, audit_binding[1] if audit_binding else None)
        with business_errors():
            result = service.save_generated(
                write,
                actor,
                prospect_id,
                step,
                GeneratedContent(
                    subject=mail.subject,
                    body_text=mail.body,
                    model=mail.model,
                    prompt_version=PROMPT_VERSION,
                ),
                body.expected_revision,
                default_from=settings.default_outbound_email,
            )
        out = result_out(result)
    return GenerationResultOut(
        **out.model_dump(),
        generation=GenerationOut(model=mail.model, prompt_version=PROMPT_VERSION),
    )
