"""Where a prospect's next send really stands, for every list and card that names a prospect.

The planning's due date (`next_due_at`) is theoretical: this is the effective schedule. One
`SendSituation` per prospect, read from the unsent messages of its current sequence, the most
pressing first:

- `unconfirmed`  scheduled, claimed, and the send ended without a known outcome;
- `doubt`        not scheduled, and it may have left (`sent_doubt_*`): a person checks the sent
                 items;
- `missed`       it was scheduled and did not leave (`missed_*`, `contact_schedule_trace`):
                 a person has to act;
- `scheduled`    it will leave at `scheduled_at` (`draft_missing`: its Infomaniak draft was not
                 found by the last check);
- `unscheduled`  a person took the send back (unscheduled, edited, cancelled).

A prospect whose messages were never scheduled has none.
"""

import uuid
from collections.abc import Collection, Iterable
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.contact_steps import step_code, step_label
from app.models import ContactMessage, ContactSequence
from app.models.enums import ContactMessageStatus
from app.services.contact_dispatch import UNCONFIRMED
from app.services.contact_schedule_trace import (
    BY_PERSON,
    CANCELLED,
    DRAFT_MISSING,
    SEQUENCE_LIMIT,
)

M = ContactMessageStatus
# Most pressing first.
STATES = ("unconfirmed", "doubt", "missed", "scheduled", "unscheduled")


@dataclass(frozen=True, slots=True)
class SendSituation:
    state: str
    rank: int
    step: str
    step_label: str
    # The effective send moment (`scheduled`, `unconfirmed`) or the one that was missed.
    scheduled_at: datetime | None
    # Why (a code), and when it happened.
    reason: str | None = None
    at: datetime | None = None
    draft_missing: bool = False
    needs_sent_check: bool = False


def message_situation(message: ContactMessage) -> SendSituation | None:
    """The situation of one message; None when it has nothing to say about a send moment."""
    scheduled_at, reason, at = message.scheduled_at, message.last_error_code, message.last_error_at
    if message.status is M.SCHEDULED:
        unconfirmed = message.dispatch_claim_id is not None and reason in UNCONFIRMED
        state = "unconfirmed" if unconfirmed else "scheduled"
    elif message.status is M.SENT:
        return None
    elif message.sent_doubt_reason is not None:
        state = "doubt"
        scheduled_at = message.missed_scheduled_at
        reason, at = message.sent_doubt_reason, message.sent_doubt_at
    elif message.missed_reason is None:
        return None
    else:
        if message.status is M.CANCELLED and message.missed_reason not in (
            CANCELLED,
            SEQUENCE_LIMIT,
        ):
            return None
        state = "unscheduled" if message.missed_reason in BY_PERSON else "missed"
        scheduled_at = message.missed_scheduled_at
        reason, at = message.missed_reason, message.missed_at
    return SendSituation(
        state=state,
        rank=message.rank,
        step=step_code(message.rank),
        step_label=step_label(message.rank),
        scheduled_at=scheduled_at,
        reason=reason,
        at=at,
        draft_missing=message.status is M.SCHEDULED and message.draft_check == DRAFT_MISSING,
        # Its own doubt only: `contact_unsent` adds those inherited from former sequences.
        needs_sent_check=message.sent_doubt_reason is not None,
    )


def situation_of(messages: Iterable[ContactMessage]) -> SendSituation | None:
    """The most pressing situation among one sequence's messages (lowest rank on a tie)."""
    found = [situation for message in messages if (situation := message_situation(message))]
    return min(found, key=lambda s: (STATES.index(s.state), s.rank), default=None)


def send_situations(
    session: Session, prospect_ids: Collection[uuid.UUID]
) -> dict[uuid.UUID, SendSituation]:
    """The situation of each of these prospects that has one (one statement)."""
    if not prospect_ids:
        return {}
    rows = session.scalars(
        select(ContactMessage)
        .join(ContactSequence, ContactSequence.id == ContactMessage.sequence_id)
        .where(ContactSequence.is_current, ContactMessage.prospect_id.in_(prospect_ids))
    )
    by_prospect: dict[uuid.UUID, list[ContactMessage]] = {}
    for message in rows:
        by_prospect.setdefault(message.prospect_id, []).append(message)
    return {
        prospect_id: situation
        for prospect_id, messages in by_prospect.items()
        if (situation := situation_of(messages))
    }
