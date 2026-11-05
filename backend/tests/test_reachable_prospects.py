"""Reachability differs from verification and never overrides explicit contact exclusions."""

from datetime import UTC, datetime

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import ContactTracking
from app.models.enums import (
    ActivityStatus,
    ContactabilityStatus,
    ContactTrackingStatus,
    VerificationStatus,
)
from tests.builders import add_company, add_email, add_phone, add_prospect


def test_reachable_includes_unverified_email_and_phone_only(
    client: TestClient, db_session: Session
) -> None:
    email = add_prospect(db_session, first_name="Email")
    add_email(db_session, email, "unverified@example.test", is_primary=True)
    phone = add_prospect(db_session, first_name="Phone")
    add_phone(db_session, phone, "+33612345678", is_primary=True)
    missing = add_prospect(db_session, first_name="Missing")
    invalid = add_prospect(db_session, first_name="Invalid")
    add_email(
        db_session,
        invalid,
        "invalid@example.test",
        is_primary=True,
        verification_status=VerificationStatus.INVALID,
    )
    response = client.get("/api/prospection/prospects?reachable=true")
    assert response.status_code == 200, response.text
    assert {row["id"] for row in response.json()["items"]} == {str(email.id), str(phone.id)}
    assert client.get("/api/prospection/prospects").json()["total"] == 4
    assert missing.employment_verified_at is None


def test_reachable_keeps_explicit_exclusions(client: TestClient, db_session: Session) -> None:
    for index, state in enumerate(
        [
            ContactTrackingStatus.IGNORED,
            ContactTrackingStatus.DISQUALIFIED,
            ContactTrackingStatus.NOT_INTERESTED,
        ]
    ):
        person = add_prospect(db_session, first_name=f"State{index}")
        add_email(db_session, person, f"state{index}@example.test", is_primary=True)
        db_session.add(ContactTracking(prospect_id=person.id, status=state))
    inactive = add_prospect(db_session, first_name="Left", activity_status=ActivityStatus.INACTIVE)
    add_email(db_session, inactive, "left@example.test", is_primary=True)
    opposed = add_prospect(
        db_session,
        first_name="Opposed",
        contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
        do_not_contact_at=datetime.now(UTC),
    )
    add_email(db_session, opposed, "opposed@example.test", is_primary=True)
    db_session.flush()
    assert client.get("/api/prospection/prospects?reachable=true").json()["total"] == 0
    assert client.get("/api/prospection/prospects").json()["total"] == 5


def test_company_sort_keeps_namesake_companies_together_across_pages(
    client: TestClient, db_session: Session
) -> None:
    first = add_company(db_session, "Entreprise homonyme")
    second = add_company(db_session, "Entreprise homonyme")
    for company, last_name in [(first, "A"), (second, "B"), (first, "D"), (second, "C")]:
        add_prospect(
            db_session, company, last_name=last_name, employment_verified_at=datetime.now(UTC)
        )
    path = "/api/prospection/prospects?validated_only=true&sort=company&limit=2"
    one = client.get(path).json()
    two = client.get(path + "&offset=2").json()
    assert one["total"] == two["total"] == 4
    one_company = {row["company_id"] for row in one["items"]}
    two_company = {row["company_id"] for row in two["items"]}
    assert len(one_company) == len(two_company) == 1
    assert one_company.isdisjoint(two_company)


def test_validation_workspace_scope_does_not_require_verified_email(
    client: TestClient, db_session: Session
) -> None:
    now = datetime.now(UTC)
    verified_email = add_prospect(db_session, first_name="Checked", employment_verified_at=now)
    add_email(
        db_session,
        verified_email,
        "checked@example.test",
        is_primary=True,
        verification_status=VerificationStatus.VERIFIED,
    )
    unchecked_email = add_prospect(
        db_session, first_name="UnverifiedEmail", employment_verified_at=now
    )
    add_email(db_session, unchecked_email, "unchecked@example.test", is_primary=True)
    no_channels = add_prospect(db_session, first_name="NoChannels", employment_verified_at=now)
    uncertain = add_prospect(db_session, first_name="Uncertain")
    add_email(
        db_session,
        uncertain,
        "uncertain@example.test",
        is_primary=True,
        verification_status=VerificationStatus.VERIFIED,
    )
    ignored = add_prospect(db_session, first_name="Ignored", employment_verified_at=now)
    db_session.add(ContactTracking(prospect_id=ignored.id, status=ContactTrackingStatus.IGNORED))
    db_session.flush()
    path = "/api/prospection/prospects?validated_only=true&limit=2"
    first = client.get(path).json()
    second = client.get(path + "&offset=2").json()
    assert first["total"] == second["total"] == 3
    assert {row["id"] for row in first["items"] + second["items"]} == {
        str(verified_email.id),
        str(unchecked_email.id),
        str(no_channels.id),
    }
    dashboard = client.get("/api/prospection/dashboard?validated_only=true").json()
    assert dashboard["total"] == 3
    assert dashboard["reviews"] == {"verified": 3, "ignored": 0, "to_verify": 0}
    assert client.get("/api/prospection/prospects").json()["total"] == 5
