"""Dashboard counts, score parity and shared service interests, with real PostgreSQL."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models import AuditLogEntry, ContactMessage, Prospect
from app.models.enums import (
    ContactabilityStatus,
    ContactMessageStatus,
    SequenceEndReason,
    VerificationStatus,
)
from app.services.prospect_data_quality import DataQualityConfig, data_quality_of
from app.services.prospection.dashboard import quality_sql
from tests.builders import add_company, add_email, add_phone, add_prospect, add_send, start_sequence


def test_service_interests_persist_and_are_shared(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session)
    add_prospect(db_session, company, first_name="Anne")
    add_prospect(db_session, company, first_name="Bruno")
    path = f"/api/companies/{company.id}/services"
    assert client.get(path).json()["services"] == []
    for code in ["iguard", "iadvice"]:
        response = client.put(f"{path}/{code}", json={"identified": True})
        assert response.status_code == 200, response.text
    assert client.get(path).json()["services"] == ["iadvice", "iguard"]
    rows = client.get("/api/prospection/prospects").json()["items"]
    assert len(rows) == 2
    assert all(row["proposed_services"] == ["iadvice", "iguard"] for row in rows)
    assert (
        client.get("/api/prospection/prospects?services=iguard&services=emailing").json()["total"]
        == 2
    )
    assert client.get("/api/prospection/prospects?services=emailing").json()["total"] == 0
    assert client.put(f"{path}/iguard", json={"identified": False}).status_code == 200
    assert client.get(path).json()["services"] == ["iadvice"]
    assert (
        db_session.scalar(
            select(AuditLogEntry.id).where(
                AuditLogEntry.entity_id == company.id, AuditLogEntry.action == "company.updated"
            )
        )
        is not None
    )


def test_invalid_services_and_anonymous_writes_are_refused(
    client: TestClient, anonymous_client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session)
    path = f"/api/companies/{company.id}/services"
    assert client.put(f"{path}/invented", json={"identified": True}).status_code == 422
    assert client.get("/api/prospection/prospects?services=invented").status_code == 422
    assert anonymous_client.put(f"{path}/iguard", json={"identified": True}).status_code in (
        401,
        403,
    )
    assert anonymous_client.get("/api/prospection/dashboard").status_code == 401


def test_counts_use_sent_history_and_do_not_count_drafts(
    client: TestClient, db_session: Session
) -> None:
    a = add_prospect(db_session, add_company(db_session), first_name="A")
    b = add_prospect(db_session, first_name="B")
    sequence = start_sequence(db_session, a)
    for rank in range(3):
        add_send(db_session, sequence, rank, datetime.now(UTC) - timedelta(days=10 - rank))
    sequence.closed_at = datetime.now(UTC)
    sequence.end_reason = SequenceEndReason.COMPLETED
    sequence.is_current = False
    db_session.flush()
    start_sequence(db_session, a)
    draft_sequence = start_sequence(db_session, b)
    db_session.add(
        ContactMessage(
            prospect_id=b.id,
            sequence_id=draft_sequence.id,
            rank=0,
            status=ContactMessageStatus.DRAFT,
        )
    )
    db_session.flush()
    body = client.get("/api/prospection/dashboard").json()
    assert body["total"] == 2
    assert sum(body["reviews"].values()) == 2
    assert body["sends"] == {"sent": 1, "r1": 1, "r2": 1}
    assert client.get("/api/prospection/prospects?send_stage=r1").json()["total"] == 1
    rows = {row["id"]: row for row in client.get("/api/prospection/prospects").json()["items"]}
    assert rows[str(a.id)]["send_stage"] == "r2"
    assert rows[str(b.id)]["send_stage"] is None


@pytest.mark.parametrize("stale_days", [None, 30])
def test_sql_quality_matches_the_existing_business_score(
    db_session: Session, stale_days: int | None
) -> None:
    now = datetime.now(UTC)
    config = DataQualityConfig(stale_days=stale_days)
    company = add_company(db_session)
    for index in range(5):
        person = add_prospect(
            db_session,
            company,
            first_name=str(index),
            employment_verified_at=now - timedelta(days=index * 25),
            exact_job_title="Directeur" if index % 2 else None,
        )
        add_email(
            db_session,
            person,
            f"contact{index}@example.test",
            is_primary=index % 2 == 0,
            verification_status=VerificationStatus.VERIFIED
            if index % 2
            else VerificationStatus.UNVERIFIED,
        )
        add_phone(db_session, person, f"+3361234567{index}", is_active=index % 2 == 0)
    db_session.flush()
    people = db_session.scalars(
        select(Prospect).options(selectinload(Prospect.emails), selectinload(Prospect.phones))
    ).all()
    for person in people:
        score = db_session.scalar(select(quality_sql(now, config)).where(Prospect.id == person.id))
        assert score == data_quality_of(person, now, config).total


def test_average_excludes_opposition_and_empty_is_explicit(
    client: TestClient, db_session: Session
) -> None:
    assert client.get("/api/prospection/dashboard").json()["average_quality"] is None
    add_prospect(
        db_session,
        first_name="Opposition",
        contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
        do_not_contact_at=datetime.now(UTC),
    )
    add_prospect(db_session, add_company(db_session), first_name="Eligible")
    body = client.get("/api/prospection/dashboard").json()
    assert body["scored_count"] == 1
    assert body["average_quality"] == 10
