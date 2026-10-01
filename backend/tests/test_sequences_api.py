"""Sequences rework API: cohorts and « max relances » under `/api/settings`, the prospect's
sequences and change of cohort, quality alerts — protection, contract and stable refusal codes."""

import uuid
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.session_cookie import CSRF_HEADER
from tests.builders import add_cohort, add_company, add_prospect, audit_events, start_sequence
from tests.test_prospects_api import PROSPECTS

SETTINGS = "/api/settings"
ALERTS = "/api/alerts"


def ok(response: Any, status: int = 200) -> Any:
    assert response.status_code == status, response.text
    return response.json()


def refused(response: Any, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    detail: dict[str, Any] = response.json()["detail"]
    assert detail["code"] == code
    return detail


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("get", f"{SETTINGS}/cohorts"),
        ("post", f"{SETTINGS}/cohorts"),
        ("get", f"{SETTINGS}/contact"),
        ("put", f"{SETTINGS}/contact"),
        ("get", f"{PROSPECTS}/{uuid.uuid4()}/sequences"),
        ("put", f"{PROSPECTS}/{uuid.uuid4()}/cohort"),
        ("get", ALERTS),
        ("post", ALERTS),
        ("post", f"{ALERTS}/{uuid.uuid4()}/resolve"),
    ],
)
def test_every_route_needs_a_session(anonymous_client: TestClient, method: str, path: str) -> None:
    assert (
        getattr(anonymous_client, method)(
            path, **({} if method == "get" else {"json": {}})
        ).status_code
        == 401
    )


def test_writes_need_the_csrf_token(client: TestClient) -> None:
    del client.headers[CSRF_HEADER]
    assert client.post(f"{SETTINGS}/cohorts", json={"code": "S1"}).status_code == 403
    assert client.put(f"{SETTINGS}/contact", json={"max_follow_ups": 3}).status_code == 403


def test_cohorts_crud(client: TestClient) -> None:
    [s0] = ok(client.get(f"{SETTINGS}/cohorts"))
    assert (s0["code"], s0["starts_on"], s0["out_of_campaign"]) == ("S0", None, True)

    created = ok(
        client.post(f"{SETTINGS}/cohorts", json={"code": "s 39", "starts_on": "2026-09-28"}), 201
    )
    assert (created["code"], created["starts_on"], created["current_count"]) == (
        "S39",
        "2026-09-28",
        0,
    )
    renamed = ok(client.patch(f"{SETTINGS}/cohorts/{created['id']}", json={"code": "S40"}))
    assert (renamed["code"], renamed["needs_review"]) == ("S40", False)
    detail = refused(
        client.post(f"{SETTINGS}/cohorts", json={"code": "S40", "starts_on": "2026-10-05"}),
        409,
        "duplicate",
    )
    assert detail["existing"]["id"] == created["id"]
    detail = refused(client.post(f"{SETTINGS}/cohorts", json={"code": "S41"}), 422, "invalid")
    assert (detail["field"], detail["reason"]) == ("starts_on", "required")
    refused(
        client.post(f"{SETTINGS}/cohorts", json={"code": "retraité", "starts_on": "2026-10-05"}),
        422,
        "invalid",
    )
    assert client.patch(f"{SETTINGS}/cohorts/{created['id']}", json={}).status_code == 422
    refused(client.delete(f"{SETTINGS}/cohorts/{s0['id']}"), 409, "cohort_s0_fixed")
    assert client.delete(f"{SETTINGS}/cohorts/{created['id']}").status_code == 204
    refused(client.delete(f"{SETTINGS}/cohorts/{created['id']}"), 404, "not_found")


def test_a_used_cohort_is_not_deleted(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    cohort = add_cohort(db_session, "S39")
    start_sequence(db_session, prospect, cohort)

    detail = refused(client.delete(f"{SETTINGS}/cohorts/{cohort.id}"), 409, "in_use")

    assert detail["usage"] == {"sequences": 1}


def test_max_follow_ups(client: TestClient, db_session: Session) -> None:
    assert ok(client.get(f"{SETTINGS}/contact")) == {"max_follow_ups": 4}

    assert ok(client.put(f"{SETTINGS}/contact", json={"max_follow_ups": 6})) == {
        "max_follow_ups": 6
    }

    assert ok(client.get(f"{SETTINGS}/contact")) == {"max_follow_ups": 6}
    assert client.put(f"{SETTINGS}/contact", json={"max_follow_ups": -1}).status_code == 422
    assert client.put(f"{SETTINGS}/contact", json={"max_follow_ups": 4, "x": 1}).status_code == 422
    [event] = audit_events(db_session, entity_type="app_setting")
    assert event.changes["value"] == {"before": None, "after": 6}


def test_change_of_cohort_and_sequences(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    s39 = add_cohort(db_session, "S39")
    s41 = add_cohort(db_session, "S41")
    path = f"{PROSPECTS}/{prospect.id}"

    empty = ok(client.get(f"{path}/sequences"))
    assert (empty["place"]["cohort"], empty["place"]["pause_reason"], empty["sequences"]) == (
        None,
        "no_cohort",
        [],
    )
    first = ok(client.put(f"{path}/cohort", json={"cohort_id": str(s39.id)}))
    assert (first["changed"], first["place"]["cohort"]["code"], first["place"]["next_step"]) == (
        True,
        "S39",
        "contact",
    )
    ok(
        client.post(f"{path}/messages/mark-sent", json={"sent_at": "2026-09-07T10:00:00+02:00"}),
        201,
    )
    again = ok(client.put(f"{path}/cohort", json={"cohort_id": str(s39.id)}))
    assert (again["changed"], again["place"]["sent_count"]) == (False, 1)
    moved = ok(client.put(f"{path}/cohort", json={"cohort_id": str(s41.id)}))
    assert (moved["changed"], moved["place"]["sent_count"], moved["cancelled_messages"]) == (
        True,
        0,
        0,
    )

    body = ok(client.get(f"{path}/sequences"))
    assert [(s["cohort"]["code"], s["is_current"], s["end_reason"]) for s in body["sequences"]] == [
        ("S41", True, None),
        ("S39", False, "cohort_changed"),
    ]
    [send] = body["sequences"][1]["messages"]
    assert (send["step"], send["step_label"], send["status"], send["sent_source"]) == (
        "contact",
        "Contact",
        "sent",
        "manual",
    )
    assert send["has_content"] is False
    removed = ok(client.put(f"{path}/cohort", json={"cohort_id": None}))
    assert removed["place"]["cohort"] is None
    refused(client.put(f"{path}/cohort", json={"cohort_id": str(uuid.uuid4())}), 404, "not_found")
    refused(client.get(f"{PROSPECTS}/{uuid.uuid4()}/sequences"), 404, "not_found")
    assert client.put(f"{path}/cohort", json={}).status_code == 422


def test_alerts(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    start_sequence(db_session, prospect, add_cohort(db_session, "S39"))

    raised = ok(
        client.post(
            ALERTS,
            json={
                "type": "email_error",
                "prospect_id": str(prospect.id),
                "note": "Retour en erreur",
            },
        ),
        201,
    )
    assert (raised["source"], raised["raised_by_type"], raised["open"]) == ("human", "human", True)
    place = ok(client.get(f"{PROSPECTS}/{prospect.id}/sequences"))["place"]
    assert (place["email_error"], place["pause_reason"], place["next_due_at"]) == (
        True,
        "email_error",
        None,
    )
    refused(
        client.post(ALERTS, json={"type": "email_error", "prospect_id": str(prospect.id)}),
        409,
        "alert_exists",
    )
    # The source is never chosen by the client.
    assert (
        client.post(
            ALERTS, json={"type": "email_error", "prospect_id": str(prospect.id), "source": "ai"}
        ).status_code
        == 422
    )
    listed = ok(client.get(ALERTS, params={"prospect": str(prospect.id)}))
    assert (listed["total"], listed["items"][0]["id"]) == (1, raised["id"])

    resolved = ok(
        client.post(f"{ALERTS}/{raised['id']}/resolve", json={"note": "Nouvelle adresse"})
    )
    assert (resolved["open"], resolved["resolution_note"]) == (False, "Nouvelle adresse")
    assert ok(client.get(ALERTS, params={"prospect": str(prospect.id)}))["total"] == 0
    assert (
        ok(client.get(ALERTS, params={"prospect": str(prospect.id), "state": "all"}))["total"] == 1
    )
    refused(client.post(f"{ALERTS}/{raised['id']}/resolve", json={}), 409, "alert_resolved")
    refused(client.post(f"{ALERTS}/{uuid.uuid4()}/resolve", json={}), 404, "not_found")
    detail = refused(
        client.post(ALERTS, json={"type": "company_to_check", "prospect_id": str(prospect.id)}),
        422,
        "invalid",
    )
    assert detail["reason"] == "subject_type"


def test_disqualified_over_http_is_a_state_of_a_person(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    start_sequence(db_session, prospect, add_cohort(db_session, "S39"))
    version = ok(client.get(f"{PROSPECTS}/{prospect.id}"))["version"]

    view = ok(
        client.patch(
            f"{PROSPECTS}/{prospect.id}/tracking",
            json={"version": version, "status": "disqualified"},
        )
    )

    assert view["tracking"]["status"] == "disqualified"
    # The cohort and the history stay; nothing is due.
    assert view["contact"]["cohort"]["code"] == "S39"
    assert (view["contact"]["pause_reason"], view["contact"]["next_due_on"]) == ("state", None)
