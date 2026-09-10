"""Contact tracking (`Suivi de contact`): the current row per prospect and its status history.

Tracking never reads or writes prospect contactability: a do-not-contact restriction is durable and
independent of the stage (`not_interested` is an outcome, not an opposition). Operations flush; the
caller owns the transaction.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.contact_tracking import ContactTracking, ContactTrackingStatusHistory
from app.models.enums import ContactTrackingStatus
from app.services import audit
from app.services.audit import AuditAction
from app.services.prospects import get_prospect


@dataclass(frozen=True, slots=True)
class ContactTrackingInput:
    status: ContactTrackingStatus
    planned_contact_at: datetime | None = None
    referent_id: uuid.UUID | None = None
    response_received_at: datetime | None = None
    appointment_at: datetime | None = None


def save_contact_tracking(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, data: ContactTrackingInput
) -> ContactTracking:
    """Create or replace the prospect's current tracking; log a history row on status change.

    Audit: `contact_tracking.created`, `contact_tracking.status_changed` when the stage moves, or
    `contact_tracking.updated` when only dates/referent change (no event when nothing changes).
    """
    prospect = get_prospect(session, prospect_id)
    tracking = prospect.contact_tracking
    previous_status = None
    if tracking is None:
        tracking = ContactTracking()
        audit.annotate(session, actor, tracking)
        prospect.contact_tracking = tracking
    else:
        previous_status = tracking.status
        moved = previous_status != data.status
        audit.annotate(
            session, actor, tracking, AuditAction.CONTACT_TRACKING_STATUS_CHANGED if moved else None
        )
    tracking.status = data.status
    tracking.planned_contact_at = data.planned_contact_at
    tracking.referent_id = data.referent_id
    tracking.response_received_at = data.response_received_at
    tracking.appointment_at = data.appointment_at
    if previous_status != data.status:
        tracking.status_history.append(
            ContactTrackingStatusHistory(
                from_status=previous_status,
                to_status=data.status,
                actor_type=actor.type,
                actor_id=actor.id,
                actor_display=actor.display,
            )
        )
    session.flush()
    return tracking
