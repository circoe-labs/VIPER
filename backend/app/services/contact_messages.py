"""Contact message state machine (Contact port Slice S3; handoff Tasks 11-12, decisions 20-29;
sequences rework D1, D3, D6).

The only application write path of `contact_messages`. One durable message per sequence and rank;
the editor addresses the ranks of the prospect's **current open** sequence (0 = Contact, n = Rn,
code `contact`/`r<n>`, `app.core.contact_steps`), from the Contact up to R<max> (« max
relances », Paramètres): a rank beyond the maximum is refused for anything that prepares a mail
(409 `rank_beyond_max`) — it can still be read, unscheduled or cancelled (the maximum may have
been lowered since). Statuses and transitions:

    (none)    -> draft       create: `save_message` without `expected_revision`
    draft     -> draft       edit: content saved, `revision` + 1 (a new subject or body clears the
                             AI provenance `generation_*`; a recipients-only edit keeps it)
    validated|scheduled -> draft
                             edit: `revision` + 1, validation and send moment cleared, remote
                             draft detached (decision 24) — audited `contact_message.unvalidated`
    (none)|draft|validated -> draft
                             `save_generated`: an AI draft (S5, decision 22) replaces subject and
                             body, records model and prompt version; `revision` + 1 on an existing
                             message, a validation is cleared (a scheduled message is refused)
    draft     -> validated   `validate`: explicit human validation of the current revision (23)
    validated -> scheduled   `schedule`: explicit future moment, never a default (14, 25)
    scheduled -> validated   `unschedule`: the validation stays current
    draft|validated|scheduled -> cancelled
                             `cancel` (a person) or `cancel_future_messages` (decision 29)
    cancelled -> draft       `reopen`: explicit re-creation of the step's message by a person,
                             content kept, `revision` + 1, to be validated again
    (none)|draft|validated|scheduled|cancelled -> sent
                             `mark_sent`: a person declares that the next step was really sent
                             (« Marquer comme envoyé », date editable, default now; source
                             `manual`); the dispatcher (S7) will mark its own sends (`worker`).
                             `sent` is immutable (21, trigger) and counts for the level (D1).
                             With the `rank` the person saw, a replay of the same declaration
                             (a double click, a retried request) answers the recorded send and
                             moves nothing; another rank than the next one is refused
    (none)    -> sent        `record_imported_send`: an import records the Contact (rank 0) of
                             a past cohort as sent at its date (source `import`, D3, Slice S2)

Cross-cutting rules:

- every change of an existing message carries the `expected_revision` the client read; another
  one answers 409 `revision_conflict` (the row is locked while checked). `revision` changes only
  with the content (and a reopening): validating or scheduling keeps it;
- only a person (`ActorType.HUMAN`) edits, validates, schedules, unschedules, cancels, reopens;
- a closed sequence — no open current sequence (no cohort, or the sequence closed: 409
  `no_open_sequence`), the out-of-campaign cohort S0 (409 `out_of_campaign`), a prospect state
  `response_received`/`appointment_obtained`/`ignored`/`disqualified` (409
  `prospect_sequence_closed`), or the durable opposition `do_not_contact` (409
  `prospect_do_not_contact`) — refuses creating, editing, validating, scheduling, reopening and
  marking sent; unscheduling and cancelling stay possible (they only reduce what may be sent).
  « Relance terminée » does not close it: the prospect stays contactable;
- a message claimed by the dispatcher (`dispatch_claim_id`) is not changed (409
  `dispatch_in_progress`) — the dispatcher resolves it (S7);
- defaults of a new message: `From` = `VIPER_DEFAULT_OUTBOUND_EMAIL` when set, `To` = the
  prospect's primary active e-mail;
- no step ordering: R1 may be prepared before the Contact mail is sent (as the reference).

Refusal codes (`ContactMessageError`, `{detail: {code, message, …}}`): 404 `message_not_found`,
409 `message_exists`, `revision_conflict`, `message_sent_immutable`, `message_cancelled`,
`invalid_transition` (with the current `status`), `dispatch_in_progress`,
`prospect_do_not_contact`, `prospect_sequence_closed`, `no_open_sequence`, `out_of_campaign`,
`rank_beyond_max` (with `max_follow_ups`), `rank_not_next` (with `next_rank`, `next_step`);
422 `message_incomplete` (with `fields`). Plus the shared ones: 404 `not_found` (prospect), 422
`invalid` (`to.1`, `from_email`, `scheduled_at` with reason `not_future`, `sent_at` with reason
`in_future` / `before_previous_send` / `time_zone`), 403 `human_actor_required`.

Audit: one event per changed message through the flush hook (`contact_message.created|updated`
or the semantic actions of `AuditAction`), subject = the prospect; content and addresses are
masked (`app.core.audit_policy`). No separate message journal: the audit log already records
who, when, which transition and which revision (one failure, one record). Operations flush; the
caller owns the transaction.
"""

import logging
import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import cast

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.core.contact_steps import CONTACT_RANK, DEFAULT_MAX_FOLLOW_UPS, step_code, step_label
from app.models import ContactMessage, ContactSequence, Email
from app.models.enums import (
    ContactabilityStatus,
    ContactMessageStatus,
    ContactTrackingStatus,
    SendSource,
)
from app.services import app_settings, audit, contact_sequences
from app.services.audit import AuditAction
from app.services.contact_channels import normalize_email_address
from app.services.contact_message_cancellation import (
    CANCELLABLE,
    Cancellation,
    cancel_message,
    cancel_unsent_messages,
    state_cancel_reason,
)
from app.services.contact_workflow import SEQUENCE_CLOSING_STATES
from app.services.errors import (
    ActorNotAllowedError,
    ContactMessageError,
    DomainError,
    InvalidFieldError,
    translated_violations,
    violated_constraint,
)
from app.services.prospects import get_prospect

logger = logging.getLogger(__name__)

M = ContactMessageStatus
# Carry the human validation of the current revision.
VALIDATED = (M.VALIDATED, M.SCHEDULED)
MANUAL_CANCEL_REASON = "manual"
MAX_RECIPIENTS = 50
UNIQUE_STEP = "uq_contact_messages_sequence_id_rank"


# --- inputs and results ------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class MessageEdit:
    """Content of `save_message`. A field left `None` keeps its value (or the default of a new
    message); `from_email` is applied when named in `provided`, so it can be cleared."""

    expected_revision: int | None = None
    from_email: str | None = None
    subject: str | None = None
    body_text: str | None = None
    to: Sequence[str] | None = None
    cc: Sequence[str] | None = None
    bcc: Sequence[str] | None = None
    provided: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class MessageResult:
    message: ContactMessage
    created: bool = False
    # Content or status changed by this call (an identical save changes nothing, unvalidates
    # nothing).
    changed: bool = True
    # A validation was lost by this edit (validated/scheduled -> draft).
    unvalidated: bool = False


@dataclass(frozen=True, slots=True)
class SequenceContext:
    """The prospect facts every write checks."""

    prospect_id: uuid.UUID
    state: ContactTrackingStatus | None
    do_not_contact: bool
    # The open current sequence the editor works on; None without one.
    sequence_id: uuid.UUID | None = None
    out_of_campaign: bool = False
    # « Max relances »: the editor opens the ranks 0 … max.
    max_follow_ups: int = DEFAULT_MAX_FOLLOW_UPS

    @property
    def closed(self) -> bool:
        return (
            self.do_not_contact
            or self.state in SEQUENCE_CLOSING_STATES
            or self.sequence_id is None
            or self.out_of_campaign
        )


@dataclass(frozen=True, slots=True)
class MessageDefaults:
    from_email: str | None
    to: list[str]


@dataclass(frozen=True, slots=True)
class StepMessage:
    rank: int
    message: ContactMessage | None

    @property
    def step(self) -> str:
        return step_code(self.rank)

    @property
    def label(self) -> str:
        return step_label(self.rank)


@dataclass(frozen=True, slots=True)
class ProspectMessages:
    """The editor's read model: every rank of the open sequence from the Contact to R<max>, in
    order (`message` None = never created), plus a message kept beyond the maximum (lowered
    since); the prospect's place (level, next rank) for the editor."""

    context: SequenceContext
    defaults: MessageDefaults
    place: contact_sequences.ProspectSequence
    messages: list[StepMessage] = field(default_factory=list)


# --- refusals ----------------------------------------------------------------------------------


def _refusal(
    code: str, http_status: HTTPStatus, message: str, **details: object
) -> ContactMessageError:
    return ContactMessageError(code, http_status, message, **details)


def _conflict() -> ContactMessageError:
    return _refusal(
        "revision_conflict",
        HTTPStatus.CONFLICT,
        "The message changed since it was read: reload it before going on.",
    )


def _invalid_transition(message: ContactMessage, action: str) -> ContactMessageError:
    return _refusal(
        "invalid_transition",
        HTTPStatus.CONFLICT,
        f"Cannot {action} a message in status {message.status.value}.",
        status=message.status.value,
    )


def _require_human(actor: ActorContext) -> None:
    # The validation records who validated: a person without an id is no identified person.
    if actor.type is not ActorType.HUMAN or not actor.id:
        raise ActorNotAllowedError("A Contact message is handled by a person.")


def _require_open(context: SequenceContext) -> None:
    if context.do_not_contact:
        raise _refusal(
            "prospect_do_not_contact",
            HTTPStatus.CONFLICT,
            "The prospect must not be contacted: no message is possible.",
        )
    if context.state in SEQUENCE_CLOSING_STATES:
        raise _refusal(
            "prospect_sequence_closed",
            HTTPStatus.CONFLICT,
            "The prospect's state closed the sequence: no message is possible.",
        )
    if context.sequence_id is None:
        raise _refusal(
            "no_open_sequence",
            HTTPStatus.CONFLICT,
            "The prospect has no open sequence: put it in a cohort first.",
        )
    if context.out_of_campaign:
        raise _refusal(
            "out_of_campaign",
            HTTPStatus.CONFLICT,
            "The prospect is in S0 (out of campaign): no message is possible.",
        )


def _require_rank(context: SequenceContext, rank: int) -> None:
    """A mail is prepared for the Contact up to R<max> only (« max relances »)."""
    if rank > context.max_follow_ups:
        raise _refusal(
            "rank_beyond_max",
            HTTPStatus.CONFLICT,
            f"The sequence stops at R{context.max_follow_ups} (« max relances »).",
            max_follow_ups=context.max_follow_ups,
        )


def _require_not_sent(message: ContactMessage) -> None:
    if message.status is M.SENT:
        raise _refusal(
            "message_sent_immutable", HTTPStatus.CONFLICT, "A sent message cannot be changed."
        )


def _require_revision(message: ContactMessage, expected: int) -> None:
    if expected != message.revision:
        raise _conflict()


def _require_not_claimed(message: ContactMessage) -> None:
    if message.dispatch_claim_id is not None:
        raise _refusal(
            "dispatch_in_progress", HTTPStatus.CONFLICT, "The message is being sent: it is locked."
        )


# --- reads -------------------------------------------------------------------------------------


def sequence_context(session: Session, prospect_id: uuid.UUID) -> SequenceContext:
    """Raises `NotFoundError` for an unknown prospect.

    Read without a lock: a state change committed concurrently (another tab closing the
    sequence) can pass unseen by a message write in flight. The impact is bounded: that state
    change cancels every unsent message in its own transaction, which waits for the message row
    lock (and then cancels it too). The one gap is a *creation* racing the change: the new row is
    invisible to that cancellation, so a draft may remain — it cannot be validated, scheduled or
    edited afterwards (the sequence is closed), only read or cancelled."""
    prospect = get_prospect(session, prospect_id)
    tracking = prospect.contact_tracking
    sequence = contact_sequences.current_sequence(session, prospect.id)
    open_sequence = sequence if sequence is not None and sequence.is_open else None
    return SequenceContext(
        prospect_id=prospect.id,
        state=tracking.status if tracking else None,
        do_not_contact=prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT,
        sequence_id=open_sequence.id if open_sequence else None,
        out_of_campaign=open_sequence.cohort.out_of_campaign if open_sequence else False,
        max_follow_ups=app_settings.max_follow_ups(session),
    )


def message_defaults(
    session: Session, prospect_id: uuid.UUID, default_from: str | None
) -> MessageDefaults:
    """`From` from the configuration, `To` = the primary e-mail (always active)."""
    primary = session.scalar(
        select(Email.address).where(Email.prospect_id == prospect_id, Email.is_primary)
    )
    return MessageDefaults(from_email=default_from, to=[primary] if primary else [])


def _messages(session: Session, context: SequenceContext) -> dict[int, ContactMessage]:
    """The current open sequence's messages, by rank."""
    if context.sequence_id is None:
        return {}
    rows = session.scalars(
        select(ContactMessage).where(ContactMessage.sequence_id == context.sequence_id)
    )
    return {row.rank: row for row in rows}


def prospect_messages(
    session: Session, prospect_id: uuid.UUID, default_from: str | None
) -> ProspectMessages:
    context = sequence_context(session, prospect_id)
    existing = _messages(session, context)
    ranks = sorted(set(range(context.max_follow_ups + 1)) | set(existing))
    return ProspectMessages(
        context=context,
        defaults=message_defaults(session, prospect_id, default_from),
        place=contact_sequences.prospect_sequence(
            session, prospect_id, max_follow_ups=context.max_follow_ups
        ),
        messages=[StepMessage(rank, existing.get(rank)) for rank in ranks],
    )


def get_message(session: Session, prospect_id: uuid.UUID, rank: int) -> ContactMessage | None:
    """The rank's message in the open sequence (None when never created, or no open sequence)."""
    context = sequence_context(session, prospect_id)
    return _messages(session, context).get(rank)


def _locked_rank(session: Session, context: SequenceContext, rank: int) -> ContactMessage | None:
    """The rank's message in the open sequence, row-locked and re-read, so the checks and the
    write are one."""
    if context.sequence_id is None:
        return None
    return session.scalar(
        select(ContactMessage)
        .where(ContactMessage.sequence_id == context.sequence_id, ContactMessage.rank == rank)
        .with_for_update()
        .execution_options(populate_existing=True)
    )


def _required(session: Session, context: SequenceContext, rank: int) -> ContactMessage:
    message = _locked_rank(session, context, rank)
    if message is None:
        raise _refusal("message_not_found", HTTPStatus.NOT_FOUND, "No message for this step yet.")
    return message


# --- content -----------------------------------------------------------------------------------


CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f]")
# At most a year ahead: a later moment is a typo (a wrong year), not a plan.
MAX_SCHEDULE_AHEAD = timedelta(days=366)


def _no_control_characters(field: str, value: str) -> None:
    """A CR/LF (or another control character) in a header would let a value add headers."""
    if CONTROL_CHARACTERS.search(value):
        raise InvalidFieldError(field, "Control characters are not allowed.", "control_character")


def _recipients(name: str, values: Sequence[str]) -> list[str]:
    """Normalized addresses (lowercase, deduplicated, blanks dropped); an invalid one is refused,
    never silently ignored."""
    if len(values) > MAX_RECIPIENTS:
        raise InvalidFieldError(name, f"At most {MAX_RECIPIENTS} addresses.", "too_many")
    out: list[str] = []
    for position, raw in enumerate(values):
        if not raw.strip():
            continue
        _no_control_characters(f"{name}.{position}", raw)
        address = normalize_email_address(f"{name}.{position}", raw)
        if address not in out:
            out.append(address)
    return out


def _from(value: str | None) -> str | None:
    if value is None or not value.strip():
        return None
    _no_control_characters("from_email", value)
    return normalize_email_address("from_email", value)


def _content(edit: MessageEdit, base: dict[str, object]) -> dict[str, object]:
    """The message content after `edit` over `base` (current or default values)."""
    content = dict(base)
    if "from_email" in edit.provided:
        content["from_email"] = _from(edit.from_email)
    if edit.subject is not None:
        _no_control_characters("subject", edit.subject)
        content["subject"] = edit.subject
    if edit.body_text is not None:
        content["body_text"] = edit.body_text
    for name, values in (("to", edit.to), ("cc", edit.cc), ("bcc", edit.bcc)):
        if values is not None:
            content[f"{name}_recipients"] = _recipients(name, values)
    # One address receives the mail once: kept in the first list (to > cc > bcc).
    seen: set[str] = set()
    for key in ("to_recipients", "cc_recipients", "bcc_recipients"):
        addresses = [address for address in cast(list[str], content[key]) if address not in seen]
        seen.update(addresses)
        content[key] = addresses
    return content


CONTENT_FIELDS = (
    "from_email",
    "subject",
    "body_text",
    "to_recipients",
    "cc_recipients",
    "bcc_recipients",
)


def _current_content(message: ContactMessage) -> dict[str, object]:
    return {name: getattr(message, name) for name in CONTENT_FIELDS}


def _missing_for_validation(message: ContactMessage) -> list[str]:
    missing = []
    if not message.from_email:
        missing.append("from_email")
    if not message.to_recipients:
        missing.append("to")
    if not message.subject.strip():
        missing.append("subject")
    if not message.body_text.strip():
        missing.append("body_text")
    return missing


def _clear_validation(message: ContactMessage) -> None:
    message.validated_revision = None
    message.validated_at = None
    message.validated_by_actor_id = None
    message.validated_by_display = None
    message.scheduled_at = None
    # The remote draft was the validated revision's; S6 queues its deletion.
    message.remote_provider = None
    message.remote_draft_id = None


def _clear_generation(message: ContactMessage) -> None:
    message.generation_model = None
    message.generation_prompt_version = None
    message.generated_at = None


def _log(action: str, message: ContactMessage, actor: ActorContext) -> None:
    # Identifiers and codes only: never an address, a subject or a body.
    logger.info(
        "contact_message.%s message=%s prospect=%s rank=%s status=%s revision=%s actor=%s",
        action,
        message.id,
        message.prospect_id,
        message.rank,
        message.status.value,
        message.revision,
        actor.type.value,
    )


# --- writes ------------------------------------------------------------------------------------


def _create(
    session: Session,
    actor: ActorContext,
    context: SequenceContext,
    rank: int,
    content: dict[str, object],
) -> MessageResult:
    assert context.sequence_id is not None  # `_require_open` ran before
    message = ContactMessage(
        prospect_id=context.prospect_id,
        sequence_id=context.sequence_id,
        rank=rank,
        **content,
    )
    audit.annotate(session, actor, message)

    def duplicate(error: IntegrityError) -> DomainError | None:
        # A concurrent creation of the same step raced past the lookup.
        return _message_exists() if violated_constraint(error) == UNIQUE_STEP else None

    with translated_violations(session, duplicate):
        session.add(message)
    session.refresh(message)
    _log("created", message, actor)
    return MessageResult(message, created=True)


def _message_exists() -> ContactMessageError:
    return _refusal(
        "message_exists",
        HTTPStatus.CONFLICT,
        "This step already has a message: reload it before going on.",
    )


def save_message(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    rank: int,
    edit: MessageEdit,
    *,
    default_from: str | None = None,
) -> MessageResult:
    """Create the rank's message (no `expected_revision`: defaults completed by `edit`, status
    `draft`) or edit its content (with the current `expected_revision`)."""
    _require_human(actor)
    context = sequence_context(session, prospect_id)
    message = _locked_rank(session, context, rank)
    if message is None:
        if edit.expected_revision is not None:
            raise _refusal(
                "message_not_found", HTTPStatus.NOT_FOUND, "No message for this step yet."
            )
        _require_open(context)
        _require_rank(context, rank)
        defaults = message_defaults(session, prospect_id, default_from)
        base: dict[str, object] = {
            "from_email": defaults.from_email,
            "subject": "",
            "body_text": "",
            "to_recipients": defaults.to,
            "cc_recipients": [],
            "bcc_recipients": [],
        }
        return _create(session, actor, context, rank, _content(edit, base))
    _require_not_sent(message)
    if edit.expected_revision is None:
        raise _message_exists()
    _require_revision(message, edit.expected_revision)
    if message.status is M.CANCELLED:
        raise _refusal(
            "message_cancelled",
            HTTPStatus.CONFLICT,
            "The message is cancelled: reopen it before editing.",
        )
    content = _content(edit, _current_content(message))
    if content == _current_content(message):
        return MessageResult(message, changed=False)
    _require_open(context)
    _require_rank(context, rank)
    _require_not_claimed(message)
    unvalidated = message.status in VALIDATED
    audit.annotate(
        session, actor, message, AuditAction.CONTACT_MESSAGE_UNVALIDATED if unvalidated else None
    )
    if (content["subject"], content["body_text"]) != (message.subject, message.body_text):
        # A person rewrote the text: it is no longer the AI's (decision S5 QA). The audit event
        # of this edit keeps the provenance (the generation fields' before values).
        _clear_generation(message)
    for name, value in content.items():
        setattr(message, name, value)
    message.revision += 1
    message.status = M.DRAFT
    _clear_validation(message)
    session.flush()
    _log("unvalidated" if unvalidated else "edited", message, actor)
    return MessageResult(message, unvalidated=unvalidated)


@dataclass(frozen=True, slots=True)
class GeneratedContent:
    """A validated AI draft (`app.services.contact_mail_generation`)."""

    subject: str
    body_text: str
    model: str
    prompt_version: str


def require_generation_target(
    context: SequenceContext,
    rank: int,
    message: ContactMessage | None,
    expected_revision: int | None,
) -> None:
    """The refusals of an AI drafting, the same before the (long) AI call and again in the write
    transaction: open sequence, a rank up to R<max>, a known step revision, not sent / cancelled /
    being sent, and not scheduled — a scheduled message is unscheduled by a person first, never
    silently."""
    _require_open(context)
    _require_rank(context, rank)
    if message is None:
        if expected_revision is not None:
            raise _refusal(
                "message_not_found", HTTPStatus.NOT_FOUND, "No message for this step yet."
            )
        return
    _require_not_sent(message)
    if message.status is M.CANCELLED:
        raise _refusal(
            "message_cancelled",
            HTTPStatus.CONFLICT,
            "The message is cancelled: reopen it before drafting it again.",
        )
    _require_not_claimed(message)
    if expected_revision is None:
        raise _message_exists()
    _require_revision(message, expected_revision)
    if message.status is M.SCHEDULED:
        raise _invalid_transition(message, "draft with the AI")


def save_generated(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    rank: int,
    content: GeneratedContent,
    expected_revision: int | None,
    *,
    default_from: str | None = None,
    now: datetime | None = None,
) -> MessageResult:
    """Write an AI draft (decision 22): the subject and body replace the step's text, the result is
    always a `draft` (a validated message loses its validation, decision 24), the model and prompt
    version are recorded; addresses are kept (or the defaults of a new message). Audited
    `contact_message.generated`; the prospect's state never changes."""
    _require_human(actor)
    context = sequence_context(session, prospect_id)
    message = _locked_rank(session, context, rank)
    require_generation_target(context, rank, message, expected_revision)
    _no_control_characters("subject", content.subject)
    generation: dict[str, object] = {
        "subject": content.subject,
        "body_text": content.body_text,
        "generation_model": content.model,
        "generation_prompt_version": content.prompt_version,
        "generated_at": now or datetime.now(UTC),
    }
    if message is None:
        defaults = message_defaults(session, prospect_id, default_from)
        assert context.sequence_id is not None  # `require_generation_target` checked it
        message = ContactMessage(
            prospect_id=prospect_id,
            sequence_id=context.sequence_id,
            rank=rank,
            from_email=defaults.from_email,
            to_recipients=defaults.to,
            cc_recipients=[],
            bcc_recipients=[],
            **generation,
        )
        audit.annotate(session, actor, message, AuditAction.CONTACT_MESSAGE_GENERATED)

        def duplicate(error: IntegrityError) -> DomainError | None:
            return _message_exists() if violated_constraint(error) == UNIQUE_STEP else None

        with translated_violations(session, duplicate):
            session.add(message)
        session.refresh(message)
        _log("generated", message, actor)
        return MessageResult(message, created=True)
    unvalidated = message.status in VALIDATED
    audit.annotate(session, actor, message, AuditAction.CONTACT_MESSAGE_GENERATED)
    for name, value in generation.items():
        setattr(message, name, value)
    message.revision += 1
    message.status = M.DRAFT
    _clear_validation(message)
    session.flush()
    _log("generated", message, actor)
    return MessageResult(message, unvalidated=unvalidated)


def _transition_target(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    rank: int,
    expected_revision: int,
) -> tuple[SequenceContext, ContactMessage]:
    _require_human(actor)
    context = sequence_context(session, prospect_id)
    message = _required(session, context, rank)
    _require_not_sent(message)
    _require_revision(message, expected_revision)
    return context, message


def validate(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    rank: int,
    expected_revision: int,
    *,
    now: datetime | None = None,
) -> MessageResult:
    """Human validation of the current revision (draft -> validated). An incomplete message
    (from, to, subject, body) answers 422 `message_incomplete` with the missing `fields`."""
    context, message = _transition_target(session, actor, prospect_id, rank, expected_revision)
    if message.status is not M.DRAFT:
        raise _invalid_transition(message, "validate")
    _require_open(context)
    _require_rank(context, rank)
    missing = _missing_for_validation(message)
    if missing:
        raise _refusal(
            "message_incomplete",
            HTTPStatus.UNPROCESSABLE_CONTENT,
            f"Incomplete message: {', '.join(missing)}.",
            fields=missing,
        )
    audit.annotate(session, actor, message, AuditAction.CONTACT_MESSAGE_VALIDATED)
    message.status = M.VALIDATED
    message.validated_revision = message.revision
    message.validated_at = now or datetime.now(UTC)
    message.validated_by_actor_id = actor.id
    message.validated_by_display = actor.display
    session.flush()
    _log("validated", message, actor)
    return MessageResult(message)


def schedule(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    rank: int,
    expected_revision: int,
    scheduled_at: datetime,
    *,
    now: datetime | None = None,
) -> MessageResult:
    """validated -> scheduled at an explicit, strictly future moment (never a default time, and
    unrelated to the next-action week: decision 14). A new schedule resets the dispatch
    diagnostics of a previous one."""
    context, message = _transition_target(session, actor, prospect_id, rank, expected_revision)
    if message.status is not M.VALIDATED:
        raise _invalid_transition(message, "schedule")
    _require_open(context)
    _require_rank(context, rank)
    if scheduled_at.tzinfo is None:
        raise InvalidFieldError("scheduled_at", "A time zone is required.", "time_zone")
    current = now or datetime.now(UTC)
    if scheduled_at > current + MAX_SCHEDULE_AHEAD:
        raise InvalidFieldError("scheduled_at", "At most one year ahead.", "too_far")
    if scheduled_at <= current:
        raise InvalidFieldError(
            "scheduled_at", "The send moment must be in the future.", "not_future"
        )
    audit.annotate(session, actor, message, AuditAction.CONTACT_MESSAGE_SCHEDULED)
    message.status = M.SCHEDULED
    message.scheduled_at = scheduled_at
    message.dispatch_attempts = 0
    message.last_error_code = None
    message.last_error_at = None
    session.flush()
    _log("scheduled", message, actor)
    return MessageResult(message)


def unschedule(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    rank: int,
    expected_revision: int,
) -> MessageResult:
    """scheduled -> validated; the validation stays current. Allowed on a closed sequence."""
    _, message = _transition_target(session, actor, prospect_id, rank, expected_revision)
    if message.status is not M.SCHEDULED:
        raise _invalid_transition(message, "unschedule")
    _require_not_claimed(message)
    audit.annotate(session, actor, message, AuditAction.CONTACT_MESSAGE_UNSCHEDULED)
    message.status = M.VALIDATED
    message.scheduled_at = None
    session.flush()
    _log("unscheduled", message, actor)
    return MessageResult(message)


def cancel(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    rank: int,
    expected_revision: int,
    *,
    now: datetime | None = None,
) -> MessageResult:
    """A person cancels an unsent step (draft/validated/scheduled -> cancelled). Allowed on a
    closed sequence."""
    _, message = _transition_target(session, actor, prospect_id, rank, expected_revision)
    if message.status not in CANCELLABLE:
        raise _invalid_transition(message, "cancel")
    _require_not_claimed(message)
    audit.annotate(
        session, actor, message, AuditAction.CONTACT_MESSAGE_CANCELLED, reason=MANUAL_CANCEL_REASON
    )
    cancel_message(message, MANUAL_CANCEL_REASON, now or datetime.now(UTC))
    session.flush()
    _log("cancelled", message, actor)
    return MessageResult(message)


def reopen(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    rank: int,
    expected_revision: int,
) -> MessageResult:
    """cancelled -> draft while the sequence is open: content kept, `revision` + 1, validation to
    be given again."""
    context, message = _transition_target(session, actor, prospect_id, rank, expected_revision)
    if message.status is not M.CANCELLED:
        raise _invalid_transition(message, "reopen")
    _require_open(context)
    _require_rank(context, rank)
    audit.annotate(session, actor, message, AuditAction.CONTACT_MESSAGE_REOPENED)
    message.status = M.DRAFT
    message.revision += 1
    message.cancelled_at = None
    message.cancel_reason = None
    _clear_validation(message)
    session.flush()
    _log("reopened", message, actor)
    return MessageResult(message)


def _next_send(session: Session, context: SequenceContext) -> tuple[int, datetime | None]:
    """The first rank of the open sequence not sent yet, and the latest send moment. The sequence
    row is locked first, so two « Marquer comme envoyé » of the same prospect serialize, and
    re-read: a change of cohort committed since `context` was read closed it (409
    `no_open_sequence`, never a send in a closed sequence)."""
    locked = session.execute(
        select(ContactSequence.closed_at, ContactSequence.is_current)
        .where(ContactSequence.id == context.sequence_id)
        .with_for_update()
    ).one_or_none()
    if locked is None or locked.closed_at is not None or not locked.is_current:
        raise _refusal(
            "no_open_sequence",
            HTTPStatus.CONFLICT,
            "The prospect's sequence was closed meanwhile: reload it.",
        )
    sent = session.execute(
        select(ContactMessage.rank, ContactMessage.sent_at).where(
            ContactMessage.sequence_id == context.sequence_id,
            ContactMessage.status == M.SENT,
        )
    ).all()
    ranks = {rank for rank, _ in sent}
    rank = next(candidate for candidate in range(len(ranks) + 1) if candidate not in ranks)
    latest = max((moment for _, moment in sent if moment is not None), default=None)
    return rank, latest


def mark_sent(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    *,
    rank: int | None = None,
    sent_at: datetime | None = None,
    now: datetime | None = None,
    sequence_id: uuid.UUID | None = None,
) -> MessageResult:
    """« Marquer comme envoyé » (D3): a person declares that the next step of the open sequence
    (the first rank not sent yet: Contact, then R1, R2…) was really sent at `sent_at` (default
    now; not in the future, not before the previous send). The step's unsent message becomes that
    send (its text kept: draft, validated, scheduled or cancelled alike); without one, a send
    record without text is created — both are the same send: status `sent`, source `manual`,
    audited `contact_message.sent`. The level moves by one (D1); « Relance terminée » does not
    prevent it (the prospect stays contactable), the planning then has nothing due.

    `rank` (recommended): the step the person saw as next. When that rank is already sent in the
    open sequence, the declaration is a replay (double click, retried request): the recorded send
    is answered with `changed: False` and nothing moves; another unsent rank than the next one is
    refused (409 `rank_not_next`, with the `next_rank`). Without `rank`, every call records the
    next step (internal callers only: the API requires it).

    `sequence_id` (the API's UI sends it): the open sequence the person saw. Another one — the
    cohort changed in another tab since — is refused (409 `sequence_changed`, with the current
    `sequence_id`), so a stale screen never records a send on a new sequence."""
    _require_human(actor)
    context = sequence_context(session, prospect_id)
    _require_open(context)
    if sequence_id is not None and sequence_id != context.sequence_id:
        raise _refusal(
            "sequence_changed",
            HTTPStatus.CONFLICT,
            "The prospect's sequence changed since it was read: reload it.",
            sequence_id=str(context.sequence_id),
        )
    current = now or datetime.now(UTC)
    moment = sent_at or current
    if moment.tzinfo is None:
        raise InvalidFieldError("sent_at", "A time zone is required.", "time_zone")
    if moment > current:
        raise InvalidFieldError("sent_at", "A send moment cannot be in the future.", "in_future")
    next_rank, previous = _next_send(session, context)
    if rank is not None and rank != next_rank:
        recorded = _locked_rank(session, context, rank)
        if recorded is not None and recorded.status is M.SENT:
            return MessageResult(recorded, changed=False)
        raise _refusal(
            "rank_not_next",
            HTTPStatus.CONFLICT,
            f"The next step to mark as sent is {step_label(next_rank)}: reload the sequence.",
            next_rank=next_rank,
            next_step=step_code(next_rank),
        )
    rank = next_rank
    if previous is not None and moment < previous:
        raise InvalidFieldError(
            "sent_at", "A send cannot precede the previous send.", "before_previous_send"
        )
    message = _locked_rank(session, context, rank)
    if message is None:
        assert context.sequence_id is not None  # `_require_open` checked it
        message = ContactMessage(
            prospect_id=prospect_id,
            sequence_id=context.sequence_id,
            rank=rank,
            status=M.SENT,
            sent_at=moment,
            sent_source=SendSource.MANUAL,
        )
        audit.annotate(session, actor, message, AuditAction.CONTACT_MESSAGE_SENT)

        def duplicate(error: IntegrityError) -> DomainError | None:
            return _message_exists() if violated_constraint(error) == UNIQUE_STEP else None

        with translated_violations(session, duplicate):
            session.add(message)
        session.refresh(message)
        _log("sent", message, actor)
        return MessageResult(message, created=True)
    _require_not_claimed(message)
    audit.annotate(session, actor, message, AuditAction.CONTACT_MESSAGE_SENT)
    message.status = M.SENT
    message.sent_at = moment
    message.sent_source = SendSource.MANUAL
    message.cancelled_at = None
    message.cancel_reason = None
    session.flush()
    _log("sent", message, actor)
    return MessageResult(message)


def record_imported_send(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, *, sent_at: datetime
) -> ContactMessage:
    """An import records the Contact (rank 0) of the prospect's open sequence as sent at its
    cohort's past date (D3): a send record without text, source `import`, audited
    `contact_message.sent`. Only for the import actor (403 otherwise) and only while nothing
    exists at rank 0 (409 `message_exists`); the open-sequence refusals of every write apply."""
    if actor.type is not ActorType.IMPORT:
        raise ActorNotAllowedError("Only an import records an imported send.")
    if sent_at.tzinfo is None:
        raise InvalidFieldError("sent_at", "A time zone is required.", "time_zone")
    context = sequence_context(session, prospect_id)
    _require_open(context)
    assert context.sequence_id is not None  # `_require_open` checked it
    if _locked_rank(session, context, CONTACT_RANK) is not None:
        raise _message_exists()
    message = ContactMessage(
        prospect_id=prospect_id,
        sequence_id=context.sequence_id,
        rank=CONTACT_RANK,
        status=M.SENT,
        sent_at=sent_at,
        sent_source=SendSource.IMPORT,
    )
    audit.annotate(session, actor, message, AuditAction.CONTACT_MESSAGE_SENT)
    session.add(message)
    session.flush()
    _log("sent", message, actor)
    return message


def cancel_future_messages(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    state: ContactTrackingStatus,
    *,
    now: datetime | None = None,
) -> Cancellation:
    """Decision 29: cancel the prospect's unsent messages after a sequence-closing state
    (`contact_message_cancellation`, reason `prospect_state:<state>`)."""
    return cancel_unsent_messages(session, actor, prospect_id, state_cancel_reason(state), now=now)
