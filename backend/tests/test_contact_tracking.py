"""Contact tracking: one current row per prospect, response/appointment fields, status history."""

from datetime import UTC, datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import ContactTracking, ContactTrackingStatusHistory, InternalReferent
from app.models.enums import ContactTrackingStatus
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from tests.builders import OPERATOR, add_prospect

PLANNED = datetime(2026, 9, 14, 9, 0, tzinfo=UTC)
RESPONSE = datetime(2026, 9, 16, 15, 30, tzinfo=UTC)
APPOINTMENT = datetime(2026, 9, 23, 10, 0, tzinfo=UTC)


def history(session: Session, tracking: ContactTracking) -> list[tuple[str | None, str]]:
    rows = session.execute(
        select(ContactTrackingStatusHistory.from_status, ContactTrackingStatusHistory.to_status)
        .where(ContactTrackingStatusHistory.contact_tracking_id == tracking.id)
        .order_by(ContactTrackingStatusHistory.changed_at)
    )
    return [(from_status, to_status) for from_status, to_status in rows]


def test_tracking_lifecycle_keeps_one_row_and_records_transitions(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    referent = InternalReferent(first_name="Claire", last_name="Référente")
    db_session.add(referent)
    db_session.flush()

    save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(status=ContactTrackingStatus.TO_CONTACT, planned_contact_at=PLANNED),
    )
    save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(
            status=ContactTrackingStatus.RESPONSE_RECEIVED,
            planned_contact_at=PLANNED,
            response_received_at=RESPONSE,
        ),
    )
    tracking = save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(
            status=ContactTrackingStatus.APPOINTMENT_OBTAINED,
            planned_contact_at=PLANNED,
            response_received_at=RESPONSE,
            appointment_at=APPOINTMENT,
            referent_id=referent.id,
        ),
    )
    db_session.expire_all()

    assert db_session.execute(select(func.count()).select_from(ContactTracking)).scalar_one() == 1
    assert tracking.status is ContactTrackingStatus.APPOINTMENT_OBTAINED
    assert tracking.planned_contact_at == PLANNED
    assert tracking.response_received_at == RESPONSE
    assert tracking.appointment_at == APPOINTMENT
    assert tracking.referent_id == referent.id
    assert history(db_session, tracking) == [
        (None, "to_contact"),
        ("to_contact", "response_received"),
        ("response_received", "appointment_obtained"),
    ]


def test_history_snapshots_the_actor(db_session: Session) -> None:
    prospect = add_prospect(db_session)

    tracking = save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(status=ContactTrackingStatus.CONTACTED),
    )

    [entry] = tracking.status_history
    assert (entry.actor_type, entry.actor_id, entry.actor_display) == (
        OPERATOR.type,
        OPERATOR.id,
        OPERATOR.display,
    )
    assert entry.changed_at is not None


def test_saving_the_same_status_adds_no_history(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    first = ContactTrackingInput(status=ContactTrackingStatus.CONTACTED)
    save_contact_tracking(db_session, OPERATOR, prospect.id, first)

    tracking = save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(status=ContactTrackingStatus.CONTACTED, planned_contact_at=PLANNED),
    )

    assert tracking.planned_contact_at == PLANNED
    assert history(db_session, tracking) == [(None, "contacted")]
