"""Contact tracking (`Suivi de contact`): the current row per prospect and its status history.

`save_contact_tracking` is the only write path of `contact_tracking` (Prospect editor, the
dedicated tracking endpoint, Database Explorer, imports), so the Contact rules hold everywhere
(handoff decision log; reference `src/server/contactTrackingService.ts`):

- a state change is a decision of a person, an import or a system job — an agent actor is refused
  (decision 10: no automatic classification); nothing here changes a state from a date or a mail;
- `ignored` is terminal (no way out, never a next action) and reinforces the durable opposition
  `do_not_contact` through `prospects.mark_do_not_contact` (decision 7; never lifted here);
- entering a state without a default next action (`response_received`, `appointment_obtained`,
  `failure`, `ignored`) clears the next action when the input only echoes the stored one (the
  editor's full-form save, Explorer, imports); a different one is kept. A caller that knows the
  week was given explicitly (`PATCH …/tracking`) passes `explicit_next_action=True` and it is
  kept even when equal — on `ignored` that week is refused (`ignored_has_no_next_action`);
- entering `response_received` without a response date records the caller's `now`;
- choosing `response_received`, `appointment_obtained` or `ignored` cancels the prospect's future
  unsent messages (decision 29) through `cancel_future_messages`, in the same transaction.

Operations flush; the caller owns the transaction.
"""

import uuid
from dataclasses import dataclass, replace
from datetime import UTC, datetime

from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models.contact_tracking import ContactTracking, ContactTrackingStatusHistory
from app.models.enums import ContactTrackingStatus, TrackingHistoryStatus
from app.services import audit
from app.services.audit import AuditAction
from app.services.contact_workflow import (
    NEXT_ACTION_STATES,
    SEQUENCE_CLOSING_STATES,
    TERMINAL_STATES,
)
from app.services.errors import ActorNotAllowedError, TrackingRuleError
from app.services.prospects import get_prospect, mark_do_not_contact

S = ContactTrackingStatus
# `context.reason` of the `prospect.do_not_contact.set` event written when `ignored` is chosen.
IGNORED_REASON = "Suivi de contact : Ignoré"


@dataclass(frozen=True, slots=True)
class ContactTrackingInput:
    status: ContactTrackingStatus
    planned_contact_at: datetime | None = None
    referent_id: uuid.UUID | None = None
    response_received_at: datetime | None = None
    appointment_at: datetime | None = None


def cancel_future_messages(session: Session, actor: ActorContext, tracking: ContactTracking) -> int:
    """Cancel the prospect's future unsent messages after a sequence-closing state (decision 29);
    returns how many. Seam for Slice S3 (`contact_messages` does not exist yet): nothing to cancel.
    It runs inside the state change's transaction, so a failure here rolls the change back."""
    return 0


def _checked(
    tracking: ContactTracking | None,
    actor: ActorContext,
    data: ContactTrackingInput,
    *,
    explicit_next_action: bool,
    now: datetime,
) -> ContactTrackingInput:
    """`data` with the mechanical effects of the state change applied, or a refusal."""
    previous = tracking.status if tracking else None
    moved = previous != data.status
    if moved and actor.type is ActorType.AGENT:
        raise ActorNotAllowedError("A contact state is chosen by a person, never by an agent.")
    if moved and previous in TERMINAL_STATES:
        raise TrackingRuleError("ignored_is_terminal", "An ignored prospect keeps its state.")
    planned = data.planned_contact_at
    if (
        moved
        and tracking is not None
        and data.status not in NEXT_ACTION_STATES
        and planned == tracking.planned_contact_at
        and not explicit_next_action
    ):
        planned = None
    if data.status in TERMINAL_STATES and planned is not None:
        raise TrackingRuleError(
            "ignored_has_no_next_action", "An ignored prospect has no next action."
        )
    response = data.response_received_at
    if moved and data.status is S.RESPONSE_RECEIVED and response is None:
        response = now
    return replace(data, planned_contact_at=planned, response_received_at=response)


def save_contact_tracking(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    data: ContactTrackingInput,
    *,
    explicit_next_action: bool = False,
    now: datetime | None = None,
) -> ContactTracking:
    """Create or replace the prospect's current tracking; log a history row on status change.

    Audit: `contact_tracking.created`, `contact_tracking.status_changed` when the state moves, or
    `contact_tracking.updated` when only dates/referent change (no event when nothing changes);
    `prospect.do_not_contact.set` when `ignored` reinforces the opposition.
    Refusals: `ActorNotAllowedError` (agent), `TrackingRuleError` (`ignored_is_terminal`,
    `ignored_has_no_next_action`). `now` is the caller's clock (the request's moment); callers
    without one (Explorer, imports) get the current time.
    """
    prospect = get_prospect(session, prospect_id)
    tracking = prospect.contact_tracking
    moment = now if now is not None else datetime.now(UTC)
    data = _checked(tracking, actor, data, explicit_next_action=explicit_next_action, now=moment)
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
    tracking.planned_contact_at = data.planned_contact_at
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
    if data.status in TERMINAL_STATES:
        mark_do_not_contact(session, actor, prospect_id, reason=IGNORED_REASON)
    if moved and data.status in SEQUENCE_CLOSING_STATES:
        cancel_future_messages(session, actor, tracking)
    return tracking
