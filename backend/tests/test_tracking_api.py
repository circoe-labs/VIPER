"""`PATCH /api/prospects/{id}/tracking` (Contact port, Slice S1): the human choice of a Contact
state and of the next-action ISO week, with the cadence suggestion and the stable refusal codes."""

import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.session_cookie import CSRF_HEADER
from app.core.business_time import business_day
from app.models import ContactTracking
from app.services.contact_workflow import IsoWeek
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


def this_week() -> IsoWeek:
    return IsoWeek.of(business_day(datetime.now(UTC)))


def test_tracking_needs_a_session_and_the_csrf_token(
    anonymous_client: TestClient, client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    path = f"{PROSPECTS}/{prospect.id}/tracking"
    assert anonymous_client.patch(path, json={}).status_code == 401
    del client.headers[CSRF_HEADER]
    assert client.patch(path, json={"version": "x", "status": "contacted"}).status_code == 403


def test_a_week_planner_then_the_sequence_with_its_suggestions(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    view = load(client, prospect.id)
    assert view["tracking"] is None

    # A first contact planned in week 44: neutral (no state yet), stored as that Monday.
    view = patch(client, prospect.id, view["version"], next_action_week={"year": 2026, "week": 44})
    tracking = view["tracking"]
    assert (tracking["status"], tracking["planned_contact_on"]) == ("neutral", "2026-10-26")
    assert tracking["planned_contact_week"] == "2026-W44"
    assert tracking["suggested_next_contact_on"] is None

    view = patch(client, prospect.id, view["version"], status="contacted")
    tracking = view["tracking"]
    suggested = this_week().plus(2)
    # The week is untouched: the cadence is only proposed.
    assert (tracking["status"], tracking["planned_contact_week"]) == ("contacted", "2026-W44")
    assert tracking["suggested_next_contact_on"] == suggested.monday.isoformat()
    assert tracking["suggested_next_contact_week"] == suggested.label

    # The UI applies the suggestion explicitly, then R2 proposes a review 4 weeks later.
    view = patch(
        client,
        prospect.id,
        view["version"],
        next_action_week={"year": suggested.year, "week": suggested.week},
    )
    assert view["tracking"]["planned_contact_week"] == suggested.label
    view = patch(client, prospect.id, view["version"], status="r2")
    assert view["tracking"]["suggested_next_contact_week"] == this_week().plus(4).label

    # A state without a next action clears it; clearing explicitly works too.
    view = patch(client, prospect.id, view["version"], status="response_received")
    tracking = view["tracking"]
    assert (tracking["planned_contact_on"], tracking["suggested_next_contact_on"]) == (None, None)
    assert tracking["response_received_on"] is not None
    view = patch(client, prospect.id, view["version"], next_action_week={"year": 2027, "week": 2})
    view = patch(client, prospect.id, view["version"], next_action_week=None)
    assert view["tracking"]["planned_contact_on"] is None
    assert view["tracking"]["status"] == "response_received"

    events = audit_events(db_session, entity_type="contact_tracking")
    assert [event.action for event in events] == [
        "contact_tracking.created",
        "contact_tracking.status_changed",
        "contact_tracking.updated",
        "contact_tracking.status_changed",
        "contact_tracking.status_changed",
        "contact_tracking.updated",
        "contact_tracking.updated",
    ]


def test_state_and_week_in_one_call_write_one_history_row(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    view = load(client, prospect.id)

    view = patch(
        client,
        prospect.id,
        view["version"],
        status="r1",
        next_action_week={"year": 2026, "week": 53},
    )

    assert (view["tracking"]["status"], view["tracking"]["planned_contact_on"]) == (
        "r1",
        "2026-12-28",
    )
    tracking = db_session.query(ContactTracking).filter_by(prospect_id=prospect.id).one()
    assert [(row.from_status, row.to_status) for row in tracking.status_history] == [(None, "r1")]


def test_ignored_reinforces_the_opposition_and_is_terminal(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    view = load(client, prospect.id)
    view = patch(client, prospect.id, view["version"], next_action_week={"year": 2026, "week": 44})

    view = patch(client, prospect.id, view["version"], status="ignored")

    assert view["contactability_status"] == "do_not_contact"
    assert (view["tracking"]["status"], view["tracking"]["planned_contact_on"]) == (
        "ignored",
        None,
    )
    version = view["version"]
    assert refusal(client, prospect.id, {"version": version, "status": "contacted"}) == (
        409,
        {"code": "ignored_is_terminal", "message": "An ignored prospect keeps its state."},
    )
    week = {"year": 2026, "week": 50}
    status, detail = refusal(client, prospect.id, {"version": version, "next_action_week": week})
    assert (status, detail["code"]) == (409, "ignored_has_no_next_action")
    lift = {"do_not_contact": False, "reason": "Erreur (synthétique)", "version": version}
    lifted = client.put(f"{PROSPECTS}/{prospect.id}/contactability", json=lift)
    assert (lifted.status_code, lifted.json()["detail"]["code"]) == (409, "ignored_is_terminal")
    assert load(client, prospect.id)["contactability_status"] == "do_not_contact"


def test_refusals_have_stable_codes(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    version = load(client, prospect.id)["version"]

    status, detail = refusal(client, prospect.id, {"version": version})
    assert (status, detail["code"], detail["reason"]) == (422, "invalid", "empty")
    status, detail = refusal(
        client, prospect.id, {"version": version, "next_action_week": {"year": 2025, "week": 53}}
    )
    assert (status, detail["code"], detail["field"], detail["reason"]) == (
        422,
        "invalid",
        "next_action_week",
        "iso_week",
    )
    for body in (
        {"version": version, "status": "to_contact"},  # a legacy code is never written
        {"version": version, "status": "contacted", "planned_contact_on": "2026-10-26"},
        {"version": version, "next_action_week": {"year": 2026, "week": 54}},
    ):
        assert refusal(client, prospect.id, body)[0] == 422, body
    assert refusal(client, prospect.id, {"version": "stale", "status": "contacted"}) == (
        409,
        {"code": "conflict", "message": "The prospect changed since it was read."},
    )
    status, detail = refusal(client, uuid.uuid4(), {"version": version, "status": "contacted"})
    assert (status, detail["code"]) == (404, "not_found")
    assert load(client, prospect.id)["tracking"] is None
