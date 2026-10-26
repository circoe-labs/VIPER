"""`PATCH /api/prospects/{id}/tracking` (Contact port, Slice S1; sequences rework D7): the human
choice of a commercial state (« Défaillant » included) with the stable refusal codes; the next due
date is derived, never written."""

import uuid
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.session_cookie import CSRF_HEADER
from app.models import ContactTracking
from tests.builders import add_company, add_prospect, audit_events
from tests.test_prospects_api import PROSPECTS, load


def patch(client: TestClient, prospect_id: uuid.UUID, version: str, **body: Any) -> dict[str, Any]:
    response = client.patch(
        f"{PROSPECTS}/{prospect_id}/tracking", json={"version": version, **body}
    )
    assert response.status_code == 200, response.text
    view: dict[str, Any] = response.json()
    return view


def refusal(client: TestClient, prospect_id: uuid.UUID, body: dict[str, Any]) -> tuple[int, Any]:
    response = client.patch(f"{PROSPECTS}/{prospect_id}/tracking", json=body)
    return response.status_code, response.json()["detail"]


def test_tracking_needs_a_session_and_the_csrf_token(
    anonymous_client: TestClient, client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    path = f"{PROSPECTS}/{prospect.id}/tracking"
    assert anonymous_client.patch(path, json={}).status_code == 401
    del client.headers[CSRF_HEADER]
    assert client.patch(path, json={"version": "x", "status": "neutral"}).status_code == 403


def test_states_are_chosen_one_history_row_each(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    view = load(client, prospect.id)
    assert view["tracking"] is None
    assert view["contact"]["pause_reason"] == "no_cohort"

    view = patch(client, prospect.id, view["version"], status="response_received")
    tracking = view["tracking"]
    assert tracking["status"] == "response_received"
    assert tracking["response_received_on"] is not None
    assert "planned_contact_on" not in tracking and "suggested_next_contact_on" not in tracking
    view = patch(client, prospect.id, view["version"], status="disqualified")
    assert view["tracking"]["status"] == "disqualified"
    view = patch(client, prospect.id, view["version"], status="neutral")

    row = db_session.query(ContactTracking).filter_by(prospect_id=prospect.id).one()
    assert [(entry.from_status, entry.to_status) for entry in row.status_history] == [
        (None, "response_received"),
        ("response_received", "disqualified"),
        ("disqualified", "neutral"),
    ]
    events = audit_events(db_session, entity_type="contact_tracking")
    assert [event.action for event in events] == [
        "contact_tracking.created",
        "contact_tracking.status_changed",
        "contact_tracking.status_changed",
    ]


def test_ignored_reinforces_the_opposition_and_is_terminal(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    view = load(client, prospect.id)

    view = patch(client, prospect.id, view["version"], status="ignored")

    assert view["contactability_status"] == "do_not_contact"
    assert view["tracking"]["status"] == "ignored"
    version = view["version"]
    assert refusal(client, prospect.id, {"version": version, "status": "neutral"}) == (
        409,
        {"code": "ignored_is_terminal", "message": "An ignored prospect keeps its state."},
    )
    lift = {"do_not_contact": False, "reason": "Erreur (synthétique)", "version": version}
    lifted = client.put(f"{PROSPECTS}/{prospect.id}/contactability", json=lift)
    assert (lifted.status_code, lifted.json()["detail"]["code"]) == (409, "ignored_is_terminal")
    assert load(client, prospect.id)["contactability_status"] == "do_not_contact"


def test_refusals_have_stable_codes(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    version = load(client, prospect.id)["version"]

    status, detail = refusal(client, prospect.id, {"version": version})
    assert (status, detail["code"], detail["reason"]) == (422, "invalid", "empty")
    # The next due date is derived from the cohort and the real sends: never written.
    status, detail = refusal(
        client, prospect.id, {"version": version, "next_action_week": {"year": 2026, "week": 44}}
    )
    assert (status, detail["code"], detail["field"], detail["reason"]) == (
        422,
        "invalid",
        "next_action_week",
        "derived",
    )
    for body in (
        {"version": version, "status": "to_contact"},  # a legacy code is never written
        {"version": version, "status": "contacted"},  # nor a former state (rework D7)
        {"version": version, "status": "r1"},
        {"version": version, "status": "failure"},
        {"version": version, "status": "neutral", "planned_contact_on": "2026-10-26"},
    ):
        assert refusal(client, prospect.id, body)[0] == 422, body
    assert refusal(client, prospect.id, {"version": "stale", "status": "neutral"}) == (
        409,
        {"code": "conflict", "message": "The prospect changed since it was read."},
    )
    status, detail = refusal(client, uuid.uuid4(), {"version": version, "status": "neutral"})
    assert (status, detail["code"]) == (404, "not_found")
    assert load(client, prospect.id)["tracking"] is None
