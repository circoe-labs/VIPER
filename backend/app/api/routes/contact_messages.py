"""Contact messages API (`/api/prospects/{id}/messages`, Contact port Slice S3; handoff Task 12).

Thin routes over `app.services.contact_messages` (the state machine, its rules and refusal
codes). The steps are the ranks of the prospect's current open sequence (sequences rework D6),
named `contact` (0), `r1`, `r2` … `r<max>` (« max relances », sequences rework S3).
No route writes a status directly; « Marquer comme envoyé » is the explicit human declaration of
a real send (the dispatcher, S7, marks its own).

- `GET  …/messages`                  every step from Contact to R<max> of the current sequence
                                     (plus a message kept beyond a lowered maximum), the defaults of
                                     a new message, the level and whether the sequence is closed
                                     (no cohort, S0, state, opposition);
- `POST …/messages/mark-sent`        the next step was really sent (`sent_at`, default now): the
                                     step's message becomes the send, or a send record is created;
                                     `rank` required (a replay answers the recorded send), the seen
                                     `sequence_id` checked (409 `sequence_changed`);
- `GET  …/messages/{step}`           one step's message (null when never created);
- `PUT  …/messages/{step}`           create (no `expected_revision`, 201) or edit the content (200);
- `POST …/messages/{step}/validate|schedule|unschedule|cancel|reopen` with `expected_revision`;
- `POST …/messages/{step}/generate`   the AI draft of the step (S5): always a draft, to review.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Path, Request, Response, status
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints
from sqlalchemy.orm import Session, sessionmaker

from app.api.dependencies import CurrentActor, SessionDep, SettingsDep
from app.api.errors import business_errors
from app.core.actor import ActorContext
from app.core.config import Settings
from app.core.contact_steps import STEP_CODE_PATTERN, parse_step, step_code, step_label
from app.db.session import unit_of_work
from app.models import ContactMessage
from app.models.contact_messages import EMAIL_MAX_LENGTH, SUBJECT_MAX_LENGTH
from app.models.enums import (
    ContactMessageStatus,
    ContactTrackingStatus,
    SendSource,
)
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
# `contact`, `r1` … `r99`; a rank beyond « max relances » is refused by the service.
StepPath = Annotated[
    str, Path(pattern=STEP_CODE_PATTERN, description="`contact`, `r1`, `r2`… (up to R<max>)")
]


def rank_of(step: str) -> int:
    rank = parse_step(step)
    assert rank is not None  # the path pattern checked it
    return rank


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


class MarkSentIn(StrictModel):
    # The step the person saw as next (0 = Contact, n = Rn), required: a replay of an already
    # recorded rank answers that send (200, `changed: false`) instead of recording another one;
    # another unsent rank than the next is refused (409 `rank_not_next`).
    rank: Annotated[int, Field(ge=0)]
    # The open sequence the person saw (the UI always sends it): another one — the cohort changed
    # meanwhile — is refused (409 `sequence_changed`).
    sequence_id: uuid.UUID | None = None
    # When the mail left (ISO 8601 with a time zone); omitted: now. Never in the future, never
    # before the sequence's previous send.
    sent_at: AwareDatetime | None = None


class MessageOut(BaseModel):
    id: uuid.UUID
    prospect_id: uuid.UUID
    sequence_id: uuid.UUID
    # 0 = Contact, n = Rn; `step` its code (`contact`, `r3`), `step_label` « Contact », « R3 ».
    rank: int
    step: str
    step_label: str
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
    sent_source: SendSource | None
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
    # The open current sequence the steps belong to; null without one (no cohort, or closed).
    sequence_id: uuid.UUID | None
    out_of_campaign: bool
    # Closed: no message may be created, edited, validated, scheduled, reopened or marked sent.
    closed: bool
    # « Max relances »: the steps go from Contact (0) to R<max>.
    max_follow_ups: int
    # Real sends of the current sequence, the step to send next (null when finished or without
    # cohort), « Relance terminée », the level label (« R2 », « Relance terminée ») and key.
    sent_count: int
    next_rank: int | None
    next_step: str | None
    finished: bool
    level_label: str | None
    level: str | None


class DefaultsOut(BaseModel):
    from_email: str | None
    to: list[str]
    # The AI drafting is configured (`VIPER_OPENAI_API_KEY` and `VIPER_OPENAI_MODEL`).
    generation_available: bool


class StepOut(BaseModel):
    rank: int
    step: str
    label: str
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
        sequence_id=message.sequence_id,
        rank=message.rank,
        step=message.step,
        step_label=step_label(message.rank),
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
        sent_source=message.sent_source,
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
    progress = read.place.progress
    return MessagesOut(
        sequence=SequenceOut(
            prospect_id=context.prospect_id,
            state=context.state,
            do_not_contact=context.do_not_contact,
            sequence_id=context.sequence_id,
            out_of_campaign=context.out_of_campaign,
            closed=context.closed,
            max_follow_ups=context.max_follow_ups,
            sent_count=progress.sent_count,
            next_rank=progress.next_rank,
            next_step=step_code(progress.next_rank) if progress.next_rank is not None else None,
            finished=progress.finished,
            level_label=progress.level_label,
            level=progress.level,
        ),
        defaults=DefaultsOut(
            from_email=read.defaults.from_email,
            to=read.defaults.to,
            generation_available=settings.generation_available,
        ),
        steps=[
            StepOut(
                rank=item.rank,
                step=item.step,
                label=item.label,
                message=message_out(item.message) if item.message else None,
            )
            for item in read.messages
        ],
    )


@router.post("/mark-sent")
def mark_sent(
    prospect_id: uuid.UUID,
    body: MarkSentIn,
    response: Response,
    session: SessionDep,
    actor: CurrentActor,
) -> MessageResultOut:
    """« Marquer comme envoyé » (D3): the next step of the open sequence was really sent — its
    message becomes the send (200), or a send record without text is created (201). The level
    moves by one (D1). A replay of `rank` answers the recorded send (200, `changed: false`); a
    `sequence_id` other than the open one is refused (409 `sequence_changed`)."""
    with business_errors():
        result = service.mark_sent(
            session,
            actor,
            prospect_id,
            rank=body.rank,
            sent_at=body.sent_at,
            now=datetime.now(UTC),
            sequence_id=body.sequence_id,
        )
    if result.created:
        response.status_code = status.HTTP_201_CREATED
    return result_out(result)


@router.get("/{step}")
def get_message(prospect_id: uuid.UUID, step: StepPath, session: SessionDep) -> StepMessageOut:
    with business_errors():
        message = service.get_message(session, prospect_id, rank_of(step))
    return StepMessageOut(message=message_out(message) if message else None)


@router.put("/{step}")
def save_message(
    prospect_id: uuid.UUID,
    step: StepPath,
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
            session,
            actor,
            prospect_id,
            rank_of(step),
            edit,
            default_from=settings.default_outbound_email,
        )
    if result.created:
        response.status_code = status.HTTP_201_CREATED
    return result_out(result)


@router.post("/{step}/validate")
def validate(
    prospect_id: uuid.UUID,
    step: StepPath,
    body: RevisionIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MessageResultOut:
    with business_errors():
        result = service.validate(
            session, actor, prospect_id, rank_of(step), body.expected_revision
        )
    return result_out(result)


@router.post("/{step}/schedule")
def schedule(
    prospect_id: uuid.UUID,
    step: StepPath,
    body: ScheduleIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MessageResultOut:
    with business_errors():
        result = service.schedule(
            session,
            actor,
            prospect_id,
            rank_of(step),
            body.expected_revision,
            body.scheduled_at,
            now=datetime.now(UTC),
        )
    return result_out(result)


@router.post("/{step}/unschedule")
def unschedule(
    prospect_id: uuid.UUID,
    step: StepPath,
    body: RevisionIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MessageResultOut:
    with business_errors():
        result = service.unschedule(
            session, actor, prospect_id, rank_of(step), body.expected_revision
        )
    return result_out(result)


@router.post("/{step}/cancel")
def cancel(
    prospect_id: uuid.UUID,
    step: StepPath,
    body: RevisionIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MessageResultOut:
    with business_errors():
        result = service.cancel(session, actor, prospect_id, rank_of(step), body.expected_revision)
    return result_out(result)


@router.post("/{step}/reopen")
def reopen(
    prospect_id: uuid.UUID,
    step: StepPath,
    body: RevisionIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MessageResultOut:
    with business_errors():
        result = service.reopen(session, actor, prospect_id, rank_of(step), body.expected_revision)
    return result_out(result)


@router.post("/{step}/generate")
def generate(
    prospect_id: uuid.UUID,
    step: StepPath,
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
            rank_of(step),
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
        mail = generation.draft(generator, prompt, prospect_id=prospect_id, rank=rank_of(step))
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
    step: str,
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
                rank_of(step),
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
