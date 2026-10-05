"""Prospection HTTP API (`/api/prospection`, Task 14): protection, parameters and contract."""

from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import ContactTracking, Prospect
from app.models.enums import ContactabilityStatus, ContactTrackingStatus, VerificationStatus
from app.services.prospection.segments import Segment
from tests.builders import add_company, add_email, add_prospect, add_role

COUNTERS = "/api/prospection/counters"
PROSPECTS = "/api/prospection/prospects"


def get(client: TestClient, path: str, **params: Any) -> dict[str, Any]:
    response = client.get(path, params=params)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


@pytest.mark.parametrize("path", [COUNTERS, PROSPECTS])
def test_prospection_needs_a_session(anonymous_client: TestClient, path: str) -> None:
    assert anonymous_client.get(path).status_code == 401


def test_counters_and_list_agree_for_every_segment(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, "Transports Exemple SARL")
    for n in range(5):
        prospect = add_prospect(db_session, company, first_name="Api", last_name=f"Test{n}")
        if n % 2:
            add_email(db_session, prospect, f"api{n}@exemple.example", is_primary=True)
        if n >= 2:
            db_session.add(
                ContactTracking(
                    prospect_id=prospect.id,
                    status=ContactTrackingStatus.NEUTRAL,
                    # Relative to the real clock: the API compares with the business day.
                    planned_contact_at=datetime.now(UTC) - timedelta(days=n),
                )
            )
    db_session.flush()

    counters = get(client, COUNTERS, q="api")

    assert set(counters["counts"]) == {segment.value for segment in Segment}
    assert counters["stale_threshold_days"] is None
    for segment in Segment:
        page = get(client, PROSPECTS, segment=segment.value, q="api")
        assert page["total"] == counters["counts"][segment.value], segment
    assert counters["counts"]["due"] == 3


def test_list_rows_carry_the_view_model(client: TestClient, db_session: Session) -> None:
    role = add_role(db_session)
    prospect = add_prospect(
        db_session,
        add_company(db_session, "Logistique Témoin SAS"),
        first_name="Élodie",
        last_name="Exemple",
        role_id=role.id,
        contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
        do_not_contact_at=datetime(2026, 1, 1, tzinfo=UTC),
    )

    page = get(client, PROSPECTS, sort="company", limit=10)

    assert (page["total"], page["limit"], page["offset"]) == (1, 10, 0)
    (row,) = page["items"]
    assert row["id"] == str(prospect.id)
    assert row["company_name"] == "Logistique Témoin SAS"
    assert row["role_label"] == "Rôle test"
    assert row["verification_state"] == "never_verified"
    assert row["email_state"] == "missing"
    assert row["contactability_status"] == "do_not_contact"
    assert row["tracking_status"] is None
    assert row["planned_contact_week"] is None


def test_none_filters_and_validation(client: TestClient, db_session: Session) -> None:
    add_prospect(db_session, first_name="Sans", last_name="Rôle")

    assert (
        get(client, PROSPECTS, role="none", referent="none", tracking_status="none")["total"] == 1
    )
    assert get(client, COUNTERS, tracking_status="contacted")["counts"]["all"] == 0
    # « Aucun état » includes a prospect without any tracking row.
    assert get(client, COUNTERS, tracking_status="neutral")["counts"]["all"] == 1
    for params in (
        {"segment": "inconnu"},
        {"role": "pas-un-uuid"},
        {"tracking_status": "do_not_contact"},  # an opposition is not a stage
        {"sort": "prenom"},
        {"limit": 0},
        {"limit": 201},
        {"offset": -1},
        {"q": "x" * 201},
    ):
        assert client.get(PROSPECTS, params=params).status_code == 422, params
    assert client.get(COUNTERS, params={"company": "x"}).status_code == 422


def test_stale_threshold_comes_from_the_settings(
    app: FastAPI, client: TestClient, test_database_url: str, db_session: Session
) -> None:
    add_prospect(
        db_session,
        employment_verified_at=datetime.now(UTC) - timedelta(days=40),
        last_name="Ancien",
    )
    assert get(client, COUNTERS)["counts"]["needs_recheck"] == 0

    app.state.settings = Settings(database_url=test_database_url, verification_stale_days=30)

    counters = get(client, COUNTERS)
    assert (counters["stale_threshold_days"], counters["counts"]["needs_recheck"]) == (30, 1)
    (row,) = get(client, PROSPECTS, segment="needs_recheck")["items"]
    assert row["verification_state"] == "stale"


def test_reads_write_nothing(client: TestClient, db_session: Session) -> None:
    add_prospect(db_session)

    get(client, COUNTERS)
    get(client, PROSPECTS)

    assert not db_session.dirty and not db_session.new


def test_reviews_partition_the_base_and_count_this_week(
    client: TestClient, db_session: Session
) -> None:
    now = datetime.now(UTC)
    old = now - timedelta(days=60)
    company = add_company(db_session, "Revue Exemple SAS")

    def person(
        name: str, *, employment: datetime | None, email: datetime | None, ignored: bool = False
    ) -> Prospect:
        prospect = add_prospect(
            db_session,
            company,
            first_name="Revue",
            last_name=name,
            employment_verified_at=employment,
        )
        if email is not None:
            add_email(
                db_session,
                prospect,
                f"{name.lower()}@exemple.example",
                is_primary=True,
                verification_status=VerificationStatus.VERIFIED,
                last_verified_at=email,
            )
        if ignored:
            db_session.add(
                ContactTracking(prospect_id=prospect.id, status=ContactTrackingStatus.IGNORED)
            )
        return prospect

    person("Complete", employment=now, email=now)  # verified, completed this week
    person("Ancienne", employment=old, email=old)  # verified, long ago
    person("SansEmail", employment=now, email=None)  # to verify: no verified e-mail
    person("Jamais", employment=None, email=now)  # to verify: never verified
    person("Ecartee", employment=now, email=now, ignored=True)  # ignored wins over verified
    db_session.flush()

    counters = get(client, COUNTERS, q="Revue")
    reviews = counters["reviews"]

    assert reviews["verified"] == {"total": 2, "week": 1}
    assert reviews["to_verify"]["total"] == 2
    assert reviews["ignored"]["total"] == 1
    assert sum(r["total"] for r in reviews.values()) == counters["counts"]["all"]
    for key, review in reviews.items():
        page = get(client, PROSPECTS, review=key, q="Revue")
        assert page["total"] == review["total"], key
