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
"""

from datetime import datetime

from sqlalchemy import or_, select
from sqlalchemy.orm import Session, object_session

from app.models.contact_messages import ContactMessage
from app.models.enums import ContactMessageStatus

UNSCHEDULED_BY_PERSON = "unscheduled_by_person"
EDITED = "edited"
CANCELLED = "cancelled"
BY_PERSON = frozenset({UNSCHEDULED_BY_PERSON, EDITED, CANCELLED})

# Dispatcher codes after which the mail may have left all the same.
SENT_CHECK_REASONS = frozenset({"send_not_confirmed", "send_draft_not_found", "send_probably_sent"})
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


def needs_sent_check(message: ContactMessage) -> bool:
    """Scheduling this message needs the person's confirmation (a sent one never does)."""
    if message.status is ContactMessageStatus.SENT:
        return False
    if message.sent_doubt_reason is not None:
        return True
    session = object_session(message)
    return session is not None and bool(covering_doubts(session, message))
