"""Durable do-not-contact: separate from tracking, never silently reactivated."""

import uuid

import pytest
from sqlalchemy import delete, select, text, update
from sqlalchemy.orm import Session

from app.models import Prospect
from app.models.enums import ContactabilityStatus, ContactTrackingStatus
from app.services import prospects as prospect_service
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from app.services.errors import DomainError, NotFoundError
from tests.builders import (
    DNC_GUARD_MESSAGE,
    OPERATOR,
    REQUEST_ID,
    add_prospect,
    audit_events,
    bind_operator,
    rejected,
)


def stored_contactability(session: Session, prospect: Prospect) -> ContactabilityStatus:
    session.expire_all()
    return session.execute(
        select(Prospect.contactability_status).where(Prospect.id == prospect.id)
    ).scalar_one()


def blocked_prospect(session: Session) -> Prospect:
    """A prospect (fixture data) that the operator then blocks, as in a signed-in request."""
    prospect = add_prospect(session)
    bind_operator(session)
    return prospect_service.mark_do_not_contact(
        session, OPERATOR, prospect.id, reason="  Opposition exprimée par téléphone  "
    )


def test_do_not_contact_is_not_a_contact_tracking_stage() -> None:
    assert "do_not_contact" not in {status.value for status in ContactTrackingStatus}


def test_marking_do_not_contact_persists_status_date_and_reason(db_session: Session) -> None:
    prospect = blocked_prospect(db_session)
    db_session.expire_all()

    assert prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT
    assert prospect.do_not_contact_at is not None
    assert prospect.do_not_contact_reason == "Opposition exprimée par téléphone"


def test_marking_twice_keeps_the_original_restriction(db_session: Session) -> None:
    prospect = blocked_prospect(db_session)
    first_blocked_at = prospect.do_not_contact_at

    again = prospect_service.mark_do_not_contact(db_session, OPERATOR, prospect.id, reason="Autre")

    assert again.do_not_contact_at == first_blocked_at
    assert again.do_not_contact_reason == "Opposition exprimée par téléphone"


def test_generic_writes_cannot_reactivate_a_blocked_prospect(db_session: Session) -> None:
    prospect = blocked_prospect(db_session)

    # What an import merge or a Database Explorer edit would do without the dedicated operation.
    with rejected(db_session, DNC_GUARD_MESSAGE):
        prospect.contactability_status = ContactabilityStatus.CONTACTABLE
        prospect.do_not_contact_at = None
        prospect.do_not_contact_reason = None
    with rejected(db_session, DNC_GUARD_MESSAGE):
        db_session.execute(
            text(
                "UPDATE prospects SET contactability_status = 'contactable', "
                "do_not_contact_at = NULL, do_not_contact_reason = NULL"
            )
        )

    assert stored_contactability(db_session, prospect) is ContactabilityStatus.DO_NOT_CONTACT


def test_blocked_prospect_stays_editable_otherwise(db_session: Session) -> None:
    prospect = blocked_prospect(db_session)

    db_session.execute(
        update(Prospect).where(Prospect.id == prospect.id).values(exact_job_title="Gérant")
    )

    assert stored_contactability(db_session, prospect) is ContactabilityStatus.DO_NOT_CONTACT


def test_blocked_prospect_cannot_be_deleted(db_session: Session) -> None:
    prospect = blocked_prospect(db_session)

    with rejected(db_session, "is do_not_contact and cannot be deleted"):
        db_session.execute(delete(Prospect).where(Prospect.id == prospect.id))


def test_clearing_requires_a_reason(db_session: Session) -> None:
    prospect = blocked_prospect(db_session)

    with pytest.raises(DomainError):
        prospect_service.clear_do_not_contact(db_session, OPERATOR, prospect.id, reason="   ")

    assert stored_contactability(db_session, prospect) is ContactabilityStatus.DO_NOT_CONTACT


def test_dedicated_operation_clears_and_the_guard_rearms(db_session: Session) -> None:
    prospect = blocked_prospect(db_session)

    cleared = prospect_service.clear_do_not_contact(
        db_session, OPERATOR, prospect.id, reason="Consentement écrit reçu"
    )

    assert stored_contactability(db_session, cleared) is ContactabilityStatus.CONTACTABLE
    assert (cleared.do_not_contact_at, cleared.do_not_contact_reason) == (None, None)

    reblocked = prospect_service.mark_do_not_contact(db_session, OPERATOR, prospect.id)
    with rejected(db_session, DNC_GUARD_MESSAGE):
        reblocked.contactability_status = ContactabilityStatus.CONTACTABLE
        reblocked.do_not_contact_at = None


@pytest.mark.parametrize(
    "status",
    [ContactTrackingStatus.CONTACTED, ContactTrackingStatus.NOT_INTERESTED],
)
def test_tracking_updates_never_change_contactability(
    db_session: Session, status: ContactTrackingStatus
) -> None:
    blocked = blocked_prospect(db_session)
    contactable = add_prospect(db_session, first_name="Marie")

    for prospect in (blocked, contactable):
        save_contact_tracking(
            db_session, OPERATOR, prospect.id, ContactTrackingInput(status=status)
        )

    assert stored_contactability(db_session, blocked) is ContactabilityStatus.DO_NOT_CONTACT
    assert stored_contactability(db_session, contactable) is ContactabilityStatus.CONTACTABLE


def test_unknown_prospect_is_reported(db_session: Session) -> None:
    with pytest.raises(NotFoundError):
        prospect_service.mark_do_not_contact(db_session, OPERATOR, uuid.uuid4())


# --- audit -------------------------------------------------------------------------------------


def test_blocking_is_audited_with_its_reason(db_session: Session) -> None:
    prospect = blocked_prospect(db_session)
    blocked_at = prospect.do_not_contact_at
    assert blocked_at is not None

    [entry] = audit_events(db_session)
    assert (entry.action, entry.entity_type, entry.entity_id) == (
        "prospect.do_not_contact.set",
        "prospect",
        prospect.id,
    )
    assert (entry.actor_type, entry.actor_id, entry.actor_display) == (
        OPERATOR.type,
        OPERATOR.id,
        OPERATOR.display,
    )
    assert entry.changes == {
        "contactability_status": {"before": "contactable", "after": "do_not_contact"},
        "do_not_contact_at": {"before": None, "after": blocked_at.isoformat()},
        "do_not_contact_reason": {"before": None, "after": "Opposition exprimée par téléphone"},
    }
    assert entry.context == {
        "source": "ui",
        "request_id": REQUEST_ID,
        "reason": "Opposition exprimée par téléphone",
    }

    prospect_service.mark_do_not_contact(db_session, OPERATOR, prospect.id, reason="Autre")
    assert len(audit_events(db_session)) == 1


def test_clearing_persists_its_reason_in_the_audit_log(db_session: Session) -> None:
    prospect = blocked_prospect(db_session)

    prospect_service.clear_do_not_contact(
        db_session, OPERATOR, prospect.id, reason="  Consentement écrit reçu  "
    )

    entry = audit_events(db_session)[-1]
    assert entry.action == "prospect.do_not_contact.cleared"
    assert entry.context == {
        "source": "ui",
        "request_id": REQUEST_ID,
        "reason": "Consentement écrit reçu",
    }
    assert entry.changes["contactability_status"] == {
        "before": "do_not_contact",
        "after": "contactable",
    }
    assert entry.changes["do_not_contact_reason"] == {
        "before": "Opposition exprimée par téléphone",
        "after": None,
    }
    assert [event.action for event in audit_events(db_session)] == [
        "prospect.do_not_contact.set",
        "prospect.do_not_contact.cleared",
    ]


def test_a_refused_clear_leaves_no_audit_event(db_session: Session) -> None:
    contactable = add_prospect(db_session, first_name="Marie")
    prospect = blocked_prospect(db_session)

    with pytest.raises(DomainError):
        prospect_service.clear_do_not_contact(db_session, OPERATOR, prospect.id, reason=" ")
    prospect_service.clear_do_not_contact(db_session, OPERATOR, contactable.id, reason="Rien")

    assert [event.action for event in audit_events(db_session)] == ["prospect.do_not_contact.set"]
