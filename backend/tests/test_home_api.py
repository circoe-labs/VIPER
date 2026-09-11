"""Home HTTP API (`GET /api/home`, Task 16): protection, contract, settings, agreement with
the Prospection counters and no raw audit payload."""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models import ContactTracking
from app.models.enums import ContactTrackingStatus
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from app.services.prospection.segments import Segment, SegmentContext
from tests.builders import OPERATOR, add_company, add_email, add_prospect, bind_operator

HOME = "/api/home"
S = ContactTrackingStatus


def get_home(client: TestClient) -> dict[str, Any]:
    response = client.get(HOME)
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def test_home_needs_a_session(anonymous_client: TestClient) -> None:
    assert anonymous_client.get(HOME).status_code == 401


def test_home_is_read_only(client: TestClient) -> None:
    assert client.post(HOME).status_code == 405


def test_contract_and_agreement_with_prospection(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, "Transports Exemple SARL")
    now = datetime.now(UTC)
    for n in range(6):
        prospect = add_prospect(db_session, company, first_name="Accueil", last_name=f"Test{n}")
        if n % 2:
            add_email(db_session, prospect, f"accueil{n}@exemple.example", is_primary=True)
        db_session.add(
            ContactTracking(
                prospect_id=prospect.id,
                status=[S.TO_CONTACT, S.CONTACTED, S.QUOTE_SENT][n % 3],
                planned_contact_at=now - timedelta(days=n + 1),
            )
        )
    db_session.flush()

    body = get_home(client)
    counters = client.get("/api/prospection/counters").json()

    assert set(body) == {
        "today",
        "stale_threshold_days",
        "counts",
        "companies",
        "stages",
        "progress",
        "next_actions",
        "recent_imports",
        "recent_edits",
    }
    assert body["counts"] == counters["counts"]
    assert set(body["counts"]) == {segment.value for segment in Segment}
    assert body["today"] == counters["today"]
    assert body["companies"] == 1
    assert body["stages"] == {"quote_sent": 2, "quote_follow_up": 0, "won": 0, "not_interested": 0}
    due = body["next_actions"]["due"]
    assert due["total"] == body["counts"]["due"] == 2
    assert [item["last_name"] for item in due["items"]] == ["Test3", "Test0"]
    assert set(due["items"][0]) == {
        "prospect_id",
        "first_name",
        "last_name",
        "company_name",
        "tracking_status",
        "at",
        "referent_name",
    }


def test_progress_targets_come_from_the_settings(
    app: FastAPI, client: TestClient, test_database_url: str
) -> None:
    progress = get_home(client)["progress"]
    assert (progress["contact_target"], progress["appointment_target"]) == (100, 10)
    assert len(progress["months"]) == 6
    this_month = SegmentContext.at(datetime.now(UTC)).today.replace(day=1)
    assert progress["months"][-1]["month"] == this_month.isoformat()

    app.state.settings = Settings(
        database_url=test_database_url, monthly_contact_target=80, monthly_appointment_target=8
    )

    progress = get_home(client)["progress"]
    assert (progress["contact_target"], progress["appointment_target"]) == (80, 8)


def test_recent_edits_carry_no_raw_payload(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, None, first_name="Jean", last_name="Témoin")
    add_email(db_session, prospect, "jean.temoin@exemple.example", is_primary=True)
    bind_operator(db_session)
    save_contact_tracking(
        db_session, OPERATOR, prospect.id, ContactTrackingInput(status=S.CONTACTED)
    )

    body = get_home(client)

    (edit,) = body["recent_edits"]
    assert edit["subject_label"] == "Jean Témoin"
    assert edit["actions"] == [
        {
            "action": "contact_tracking.created",
            "entity_type": "contact_tracking",
            "status_before": None,
            "status_after": "contacted",
        }
    ]
    assert set(edit) == {
        "occurred_at",
        "actor_display",
        "source",
        "subject_type",
        "subject_id",
        "subject_label",
        "actions",
    }
    text = client.get(HOME).text
    assert "jean.temoin@exemple.example" not in text
    assert '"changes"' not in text and '"context"' not in text
