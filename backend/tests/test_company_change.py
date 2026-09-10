"""Company-change rule: re-verification is requested, nothing is deleted."""

import uuid
from datetime import UTC, datetime

import pytest
from sqlalchemy.orm import Session

from app.models.enums import VerificationStatus
from app.services import prospects as prospect_service
from app.services.errors import NotFoundError
from tests.builders import OPERATOR, add_company, add_email, add_phone, add_prospect

VERIFIED_AT = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)


def test_changing_company_requests_reverification_without_deleting(db_session: Session) -> None:
    old, new = add_company(db_session), add_company(db_session, "Nouvel Employeur SAS")
    prospect = add_prospect(db_session, old, employment_verified_at=VERIFIED_AT)
    verified = {"verification_status": VerificationStatus.VERIFIED, "last_verified_at": VERIFIED_AT}
    email = add_email(db_session, prospect, "jean.test@ancien.example", is_primary=True, **verified)
    phone = add_phone(db_session, prospect, "0200000001", **verified)
    invalid = add_email(
        db_session,
        prospect,
        "jean@invalide.example",
        verification_status=VerificationStatus.INVALID,
    )
    former = add_email(db_session, prospect, "jean@archive.example", is_active=False, **verified)

    changed = prospect_service.change_company(db_session, OPERATOR, prospect.id, new.id)
    db_session.expire_all()

    assert changed.company_id == new.id
    assert changed.employment_verified_at is None
    assert (email.verification_status, email.last_verified_at) == (
        VerificationStatus.UNVERIFIED,
        VERIFIED_AT,
    )
    assert phone.verification_status is VerificationStatus.UNVERIFIED
    assert invalid.verification_status is VerificationStatus.INVALID
    assert former.verification_status is VerificationStatus.VERIFIED
    assert email.is_primary and email.is_active
    assert len(changed.emails) == 3
    assert len(changed.phones) == 1


def test_same_company_changes_nothing(db_session: Session) -> None:
    company = add_company(db_session)
    prospect = add_prospect(db_session, company, employment_verified_at=VERIFIED_AT)

    unchanged = prospect_service.change_company(db_session, OPERATOR, prospect.id, company.id)

    assert unchanged.employment_verified_at == VERIFIED_AT


def test_unknown_company_is_rejected(db_session: Session) -> None:
    company = add_company(db_session)
    prospect = add_prospect(db_session, company, employment_verified_at=VERIFIED_AT)

    with pytest.raises(NotFoundError):
        prospect_service.change_company(db_session, OPERATOR, prospect.id, uuid.uuid4())

    assert prospect.company_id == company.id
    assert prospect.employment_verified_at == VERIFIED_AT
