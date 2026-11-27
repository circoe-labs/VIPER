"""What happened to a send moment that did not end in a send: the one owner of the
`contact_messages.missed_*` trace and of the sent-items doubt (a leaf module: models only).

**Trace.** A scheduled message that leaves the schedule without having been sent keeps
`missed_scheduled_at` (the moment that had been chosen), `missed_reason` (a code) and `missed_at`
(when it happened), so the screens can say it instead of letting the schedule vanish.
`missed_reason` is a dispatcher code (`dispatch_overdue`, `send_draft_not_found`,
`send_not_confirmed`…) or one of `BY_PERSON` (someone took the send back on purpose).

**Doubt.** `sent_doubt_reason` / `sent_doubt_at` say the mail **may have left** (unknown outcome,
or a draft that is gone: perhaps sent by hand from Infomaniak). It is durable: an edit, an AI
redraft, a restored version, an unschedule, a cancellation, a reopening or a change of contact
week keeps it. Only a person who says they looked in the sent items clears it (`clear_doubt`: a
confirmed schedule, deletion, new draft, release or « pas parti »), or a recorded send.

**Unconfirmed.** A message of a former sequence still **claimed** by the dispatcher has no recorded
doubt yet, but may leave or have left: no confirmation covers it. Nothing of the prospect is
scheduled or sent until it is settled (`unconfirmed_elsewhere`, `blocked_by_earlier`).
"""

from datetime import datetime

from sqlalchemy import ColumnElement, exists, or_, select
from sqlalchemy.orm import Session, aliased, object_session

from app.models.contact_messages import ContactMessage
from app.models.enums import ContactMessageStatus

UNSCHEDULED_BY_PERSON = "unscheduled_by_person"
EDITED = "edited"
CANCELLED = "cancelled"
# Cancelled by the three-e-mail rule (R3 and beyond); also the message's `cancel_reason`.
SEQUENCE_LIMIT = "sequence_limit"
# The recipients changed with the person's addresses (`contact_recipients`): to validate again.
RECIPIENT_CHANGED = "recipient_changed"
# Taken back on purpose: nothing to recover.
BY_PERSON = frozenset({UNSCHEDULED_BY_PERSON, EDITED, CANCELLED, SEQUENCE_LIMIT})

# Dispatcher codes after which the mail may have left all the same (`dispatch_held`: the database
# was perhaps restored from before the send).
SENT_CHECK_REASONS = frozenset(
    {"send_not_confirmed", "send_draft_not_found", "send_probably_sent", "dispatch_held"}
)
# `draft_check`: what the last look at the mailbox said of a scheduled message's draft.
DRAFT_MISSING = "missing"
DRAFT_UNVERIFIED = "unverified"
# The doubt raised by that look.
DOUBT_DRAFT_MISSING = "draft_missing"


def mark_doubt(message: ContactMessage, reason: str, moment: datetime) -> None:
    """The first reason stays: it is the one a person has to check."""
    if message.sent_doubt_reason is None:
        message.sent_doubt_reason = reason
        message.sent_doubt_at = moment


def clear_doubt(message: ContactMessage) -> None:
    """Only on a person's word (they looked in the sent items) or a recorded send."""
    message.sent_doubt_reason = None
    message.sent_doubt_at = None


def leave_schedule(message: ContactMessage, reason: str, moment: datetime) -> None:
    """Call before taking `scheduled_at` away from a scheduled message that was not sent."""
    if message.scheduled_at is None:
        return
    if reason in SENT_CHECK_REASONS:
        mark_doubt(message, reason, moment)
    elif message.draft_check == DRAFT_MISSING:
        mark_doubt(message, DOUBT_DRAFT_MISSING, moment)
    message.missed_scheduled_at = message.scheduled_at
    message.missed_reason = reason
    message.missed_at = moment


def forget_schedule_trace(message: ContactMessage) -> None:
    """A new send moment (its doubt confirmed first), or the send itself, closes the story."""
    message.missed_scheduled_at = None
    message.missed_reason = None
    message.missed_at = None
    message.draft_check = None
    clear_doubt(message)


def covering_doubts(session: Session, message: ContactMessage) -> list[ContactMessage]:
    """The doubtful unsent messages a person must have checked before `message` may be scheduled:
    itself, and any of the prospect's former sequences (a change of contact week starts new
    messages: the mail of the former one may have left all the same)."""
    return list(
        session.scalars(
            select(ContactMessage).where(
                ContactMessage.prospect_id == message.prospect_id,
                ContactMessage.status != ContactMessageStatus.SENT,
                ContactMessage.sent_doubt_reason.is_not(None),
                or_(
                    ContactMessage.id == message.id,
                    ContactMessage.sequence_id != message.sequence_id,
                ),
            )
        )
    )


def unconfirmed_elsewhere(session: Session, message: ContactMessage) -> list[ContactMessage]:
    """The prospect's messages of another sequence whose send is claimed and not settled."""
    return list(
        session.scalars(
            select(ContactMessage).where(
                ContactMessage.prospect_id == message.prospect_id,
                ContactMessage.sequence_id != message.sequence_id,
                ContactMessage.status != ContactMessageStatus.SENT,
                ContactMessage.dispatch_claim_id.is_not(None),
            )
        )
    )


def blocked_by_earlier_sql() -> ColumnElement[bool]:
    """Over `ContactMessage` rows: another sequence of the prospect holds a send that is claimed
    or may have left, and nobody confirmed it since. A scheduled mail in that case does not leave
    (a confirmed schedule clears the doubts it covers)."""
    other = aliased(ContactMessage)
    return exists().where(
        other.prospect_id == ContactMessage.prospect_id,
        other.sequence_id != ContactMessage.sequence_id,
        other.status != ContactMessageStatus.SENT,
        or_(other.dispatch_claim_id.is_not(None), other.sent_doubt_reason.is_not(None)),
    )


def blocked_by_earlier(session: Session, message: ContactMessage) -> bool:
    found = session.scalar(
        select(ContactMessage.id).where(ContactMessage.id == message.id, blocked_by_earlier_sql())
    )
    return found is not None


def needs_sent_check(message: ContactMessage) -> bool:
    """Scheduling this message needs the person's confirmation (a sent one never does)."""
    if message.status is ContactMessageStatus.SENT:
        return False
    if message.sent_doubt_reason is not None:
        return True
    session = object_session(message)
    return session is not None and bool(covering_doubts(session, message))
