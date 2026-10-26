"""Contact tracking (`Suivi de contact`): the commercial state per prospect and its history.

`save_contact_tracking` is the only write path of `contact_tracking` (Prospect editor, the
dedicated tracking endpoint, Database Explorer, imports), so the Contact rules hold everywhere
(sequences rework D7; former handoff decisions 7, 10, 29):

- a state change is a decision of a person, an import or a system job — an agent actor is refused
  (no automatic classification); « Défaillant » (`disqualified`) is chosen by a person only (D4,
  D7: never an import, a job or the AI); nothing here changes a state from a date or a mail;
- `ignored` is terminal (no way out) and reinforces the durable opposition `do_not_contact`
  through `prospects.mark_do_not_contact` (decision 7; never lifted here);
- entering `response_received` without a response date records the caller's `now`;
- choosing `response_received`, `appointment_obtained`, `ignored` or `disqualified` cancels the
  prospect's future unsent messages (decision 29) through `cancel_future_messages`, in the same
  transaction. The cohort and the sequence are never touched (`contact_sequences`); conversely a
  person's new cohort resumes `disqualified`/`response_received`/`appointment_obtained` to
  `neutral` (`contact_sequences.change_cohort`, decision R-11).

Operations flush; the caller owns the transaction.
"""

import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models.contact_tracking import ContactTracking, ContactTrackingStatusHistory
from app.models.enums import ContactTrackingStatus, TrackingHistoryStatus
from app.services import audit, contact_messages
from app.services.audit import AuditAction
from app.services.contact_message_cancellation import NOTHING, Cancellation
from app.services.contact_workflow import (
    HUMAN_ONLY_STATES,
    SEQUENCE_CLOSING_STATES,
    TERMINAL_STATES,
)
from app.services.errors import ActorNotAllowedError, TrackingRuleError
from app.services.prospects import get_prospect, record_do_not_contact

S = ContactTrackingStatus
# `context.reason` of the `prospect.do_not_contact.set` event written when `ignored` is chosen.
IGNORED_REASON = "Suivi de contact : Ignoré"


@dataclass(frozen=True, slots=True)
class ContactTrackingInput:
    status: ContactTrackingStatus
    referent_id: uuid.UUID | None = None
    response_received_at: datetime | None = None
    appointment_at: datetime | None = None


def cancel_future_messages(
    session: Session, actor: ActorContext, tracking: ContactTracking
) -> Cancellation:
    """Cancel the prospect's future unsent messages after a sequence-closing state (decision 29);
    returns how many (and how many are left to the dispatcher). It runs inside the state change's
    transaction, so a failure here rolls the change back."""
    return contact_messages.cancel_future_messages(
        session, actor, tracking.prospect_id, tracking.status
    )


@dataclass(frozen=True, slots=True)
class TrackingSaved:
    tracking: ContactTracking
    # Messages cancelled by this change (decision 29, then the opposition of `ignored`), and the
    # claimed ones left to the dispatcher; nothing when the state did not close the sequence.
    messages: Cancellation = NOTHING


def _checked(
    tracking: ContactTracking | None,
    actor: ActorContext,
    data: ContactTrackingInput,
    *,
    now: datetime,
) -> ContactTrackingInput:
    """`data` with the mechanical effects of the state change applied, or a refusal."""
    previous = tracking.status if tracking else None
    moved = previous != data.status
    if moved and actor.type is ActorType.AGENT:
        raise ActorNotAllowedError("A contact state is chosen by a person, never by an agent.")
    if moved and data.status in HUMAN_ONLY_STATES and actor.type is not ActorType.HUMAN:
        raise ActorNotAllowedError("« Défaillant » is a decision of a person.")
    if moved and previous in TERMINAL_STATES:
        raise TrackingRuleError("ignored_is_terminal", "An ignored prospect keeps its state.")
    response = data.response_received_at
    if moved and data.status is S.RESPONSE_RECEIVED and response is None:
        response = now
    return replace(data, response_received_at=response)


def save_contact_tracking(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    data: ContactTrackingInput,
    *,
    now: datetime | None = None,
) -> ContactTracking:
    """`apply_contact_tracking` for callers that only need the row."""
    return apply_contact_tracking(session, actor, prospect_id, data, now=now).tracking


def apply_contact_tracking(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    data: ContactTrackingInput,
    *,
    now: datetime | None = None,
) -> TrackingSaved:
    """Create or replace the prospect's current tracking; log a history row on status change.

    Audit: `contact_tracking.created`, `contact_tracking.status_changed` when the state moves, or
    `contact_tracking.updated` when only dates/referent change (no event when nothing changes);
    `prospect.do_not_contact.set` when `ignored` reinforces the opposition.
    Refusals: `ActorNotAllowedError` (agent; `disqualified` by anyone but a person),
    `TrackingRuleError` (`ignored_is_terminal`). Returns the row and the number of messages
    cancelled by a
    sequence-closing state. `now` is the caller's clock (the request's moment); callers
    without one (Explorer, imports) get the current time.
    """
    prospect = get_prospect(session, prospect_id)
    tracking = prospect.contact_tracking
    moment = now if now is not None else datetime.now(UTC)
    data = _checked(tracking, actor, data, now=moment)
    previous_status = tracking.status if tracking else None
    moved = previous_status != data.status
    if tracking is None:
        tracking = ContactTracking()
        audit.annotate(session, actor, tracking)
        prospect.contact_tracking = tracking
    else:
        audit.annotate(
            session, actor, tracking, AuditAction.CONTACT_TRACKING_STATUS_CHANGED if moved else None
        )
    tracking.status = data.status
    tracking.referent_id = data.referent_id
    tracking.response_received_at = data.response_received_at
    tracking.appointment_at = data.appointment_at
    if moved:
        tracking.status_history.append(
            ContactTrackingStatusHistory(
                from_status=TrackingHistoryStatus(previous_status) if previous_status else None,
                to_status=TrackingHistoryStatus(data.status),
                actor_type=actor.type,
                actor_id=actor.id,
                actor_display=actor.display,
            )
        )
    session.flush()
    messages = NOTHING
    # The state cancels first, so an `ignored` prospect's messages carry `prospect_state:ignored`;
    # the opposition it reinforces then finds nothing left (only claimed rows, counted again).
    if moved and data.status in SEQUENCE_CLOSING_STATES:
        messages = cancel_future_messages(session, actor, tracking)
    if data.status in TERMINAL_STATES:
        opposition = record_do_not_contact(session, actor, prospect_id, reason=IGNORED_REASON)
        messages = messages.then(opposition.messages)
    return TrackingSaved(tracking, messages)
