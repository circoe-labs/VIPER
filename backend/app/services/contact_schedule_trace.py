"""What happened to a send moment that did not end in a send: the one owner of the
`contact_messages.missed_*` trace (a leaf module: models only).

A scheduled message that leaves the schedule without having been sent keeps `missed_scheduled_at`
(the moment that had been chosen), `missed_reason` (a code) and `missed_at` (when it happened), so
the screens can say it instead of letting the schedule vanish. The trace goes when the message is
scheduled again or recorded as sent; editing or revalidating the text keeps it.

`missed_reason` is a dispatcher code (`dispatch_overdue`, `send_draft_not_found`,
`send_not_confirmed`…: the send did not leave, a person has to act) or one of `BY_PERSON`
(someone took the send back on purpose).
"""

from datetime import datetime

from app.models.contact_messages import ContactMessage

UNSCHEDULED_BY_PERSON = "unscheduled_by_person"
EDITED = "edited"
CANCELLED = "cancelled"
BY_PERSON = frozenset({UNSCHEDULED_BY_PERSON, EDITED, CANCELLED})

# The mail may have left all the same (unknown outcome, or a draft that is gone: perhaps sent by
# hand from Infomaniak): a person checks the sent items before it can be scheduled again.
SENT_CHECK_REASONS = frozenset({"send_not_confirmed", "send_draft_not_found", "send_probably_sent"})
# `draft_check`: what the last look at the mailbox said of a scheduled message's draft.
DRAFT_MISSING = "missing"
DRAFT_UNVERIFIED = "unverified"


def leave_schedule(message: ContactMessage, reason: str, moment: datetime) -> None:
    """Call before taking `scheduled_at` away from a scheduled message that was not sent."""
    if message.scheduled_at is None:
        return
    message.missed_scheduled_at = message.scheduled_at
    message.missed_reason = reason
    message.missed_at = moment


def forget_schedule_trace(message: ContactMessage) -> None:
    """A new send moment, or the send itself, closes the story of the previous one."""
    message.missed_scheduled_at = None
    message.missed_reason = None
    message.missed_at = None
    message.draft_check = None


def needs_sent_check(message: ContactMessage) -> bool:
    return message.missed_reason in SENT_CHECK_REASONS or message.draft_check == DRAFT_MISSING
