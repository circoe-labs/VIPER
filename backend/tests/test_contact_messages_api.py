"""`/api/prospects/{id}/messages` (Contact port Slice S3): the HTTP contract of the message state
machine — shapes, status codes, stable refusal codes, protection, and the cancellation reported
by `PATCH …/tracking`."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.api.session_cookie import CSRF_HEADER
from app.core.config import Settings
from app.models import ContactTracking
from app.models.enums import ContactTrackingStatus
from tests.builders import add_cohort, add_company, add_email, add_prospect, start_sequence
from tests.test_prospects_api import PROSPECTS, body_of, load

SENDER = "prospection@exemple.example"
FUTURE = (datetime.now(UTC) + timedelta(days=2)).replace(microsecond=0)


@pytest.fixture
def app_with_sender(app: FastAPI) -> FastAPI:
    app.state.settings = Settings(
        database_url=app.state.settings.database_url, default_outbound_email=SENDER
    )
    return app


def prospect_id(
    session: Session, state: ContactTrackingStatus | None = None, *, in_cohort: bool = True
) -> uuid.UUID:
    """A prospect with a primary e-mail, an optional state and, by default, an open sequence in
    the cohort S41 (messages belong to a sequence: rework D6)."""
    prospect = add_prospect(session, add_company(session))
    add_email(session, prospect, "jean.test@exemple.example", is_primary=True)
    if state is not None:
        session.add(ContactTracking(prospect_id=prospect.id, status=state))
        session.flush()
    if in_cohort:
        start_sequence(session, prospect)
    return prospect.id


def messages(prospect: uuid.UUID) -> str:
    return f"{PROSPECTS}/{prospect}/messages"


def ok(response: Any, status: int = 200) -> dict[str, Any]:
    assert response.status_code == status, response.text
    body: dict[str, Any] = response.json()
    return body


def refused(response: Any, status: int, code: str) -> dict[str, Any]:
    assert response.status_code == status, response.text
    detail: dict[str, Any] = response.json()["detail"]
    assert detail["code"] == code
    return detail


def test_the_sequence_read_model(
    app_with_sender: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session, ContactTrackingStatus.NEUTRAL)
    sequence_id = (
        load(client, prospect)["contact"]["cohort"]["id"]
        and ok(client.get(f"{PROSPECTS}/{prospect}/sequences"))["place"]["sequence_id"]
    )

    body = ok(client.get(messages(prospect)))

    assert body["sequence"] == {
        "prospect_id": str(prospect),
        "state": "neutral",
        "do_not_contact": False,
        "sequence_id": sequence_id,
        "out_of_campaign": False,
        "closed": False,
        "max_follow_ups": 4,
        "sent_count": 0,
        "next_rank": 0,
        "next_step": "contact",
        "finished": False,
        "level_label": "Contact",
        "level": "contact_pending",
    }
    assert body["defaults"] == {
        "from_email": SENDER,
        "to": ["jean.test@exemple.example"],
        "generation_available": False,
        "toolbox_connected": False,
        "toolbox_state": "disabled",
        # S7: no dispatcher in this app, so a scheduled message would not leave.
        "automatic_sending_active": False,
        "dispatch_reason": "toolbox_disabled",
        "dispatch_max_lateness_minutes": 360,
        "dispatch_claim_ttl_seconds": 600,
    }
    # Every step from the Contact to R<max> (« max relances », 4 by default).
    assert body["steps"] == [
        {"rank": rank, "step": step, "label": label, "message": None}
        for rank, (step, label) in enumerate(
            [("contact", "Contact"), ("r1", "R1"), ("r2", "R2"), ("r3", "R3"), ("r4", "R4")]
        )
    ]
    assert ok(client.get(f"{messages(prospect)}/r1")) == {"message": None}
    assert ok(client.get(f"{messages(prospect)}/r4")) == {"message": None}
    refused(client.get(messages(uuid.uuid4())), 404, "not_found")
    for malformed in ("r0", "R1", "rank1", "r100", "-1"):
        assert client.get(f"{messages(prospect)}/{malformed}").status_code == 422


def test_the_full_lifecycle_over_http(
    app_with_sender: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    path = f"{messages(prospect)}/contact"

    created = ok(client.put(path, json={"subject": "Objet", "body_text": "Corps"}), 201)
    message = created["message"]
    assert (created["created"], message["status"], message["revision"]) == (True, "draft", 1)
    assert (message["from_email"], message["to"], message["has_remote_draft"]) == (
        SENDER,
        ["jean.test@exemple.example"],
        False,
    )

    validated = ok(client.post(f"{path}/validate", json={"expected_revision": 1}))["message"]
    assert (validated["status"], validated["validated_revision"]) == ("validated", 1)
    assert validated["validated_by"]

    scheduled = ok(
        client.post(
            f"{path}/schedule",
            json={"expected_revision": 1, "scheduled_at": FUTURE.isoformat()},
        )
    )["message"]
    assert scheduled["status"] == "scheduled"
    assert datetime.fromisoformat(scheduled["scheduled_at"]) == FUTURE

    edited = ok(client.put(path, json={"expected_revision": 1, "subject": "Nouvel objet"}))
    assert (edited["unvalidated"], edited["message"]["status"], edited["message"]["revision"]) == (
        True,
        "draft",
        2,
    )
    assert edited["message"]["scheduled_at"] is None

    ok(client.post(f"{path}/validate", json={"expected_revision": 2}))
    ok(
        client.post(
            f"{path}/schedule", json={"expected_revision": 2, "scheduled_at": FUTURE.isoformat()}
        )
    )
    assert (
        ok(client.post(f"{path}/unschedule", json={"expected_revision": 2}))["message"]["status"]
        == "validated"
    )
    cancelled = ok(client.post(f"{path}/cancel", json={"expected_revision": 2}))["message"]
    assert (cancelled["status"], cancelled["cancel_reason"]) == ("cancelled", "manual")
    reopened = ok(client.post(f"{path}/reopen", json={"expected_revision": 2}))["message"]
    assert (reopened["status"], reopened["revision"]) == ("draft", 3)

    history = ok(client.get(f"{PROSPECTS}/{prospect}/history", params={"limit": 20}))
    titles = [item["title"] for item in history["items"]]
    assert "Message validé" in titles and "Message programmé" in titles


def test_refusal_codes(app_with_sender: FastAPI, client: TestClient, db_session: Session) -> None:
    prospect = prospect_id(db_session)
    path = f"{messages(prospect)}/r1"

    refused(
        client.post(f"{path}/validate", json={"expected_revision": 1}), 404, "message_not_found"
    )
    ok(client.put(path, json={"to": []}), 201)
    refused(client.put(path, json={"subject": "Doublon"}), 409, "message_exists")
    refused(
        client.put(path, json={"expected_revision": 7, "subject": "x"}), 409, "revision_conflict"
    )
    detail = refused(
        client.post(f"{path}/validate", json={"expected_revision": 1}), 422, "message_incomplete"
    )
    assert detail["fields"] == ["to", "subject", "body_text"]
    detail = refused(
        client.post(f"{path}/unschedule", json={"expected_revision": 1}), 409, "invalid_transition"
    )
    assert detail["status"] == "draft"
    detail = refused(client.put(path, json={"expected_revision": 1, "cc": ["x"]}), 422, "invalid")
    assert detail["field"] == "cc.0"
    # Content only: a status, a revision-less action or a naive moment is a malformed request.
    assert client.put(path, json={"expected_revision": 1, "status": "sent"}).status_code == 422
    assert client.post(f"{path}/cancel", json={}).status_code == 422
    ok(
        client.put(
            path,
            json={"expected_revision": 1, "to": ["a@x.example"], "subject": "s", "body_text": "b"},
        )
    )
    ok(client.post(f"{path}/validate", json={"expected_revision": 2}))
    naive = {"expected_revision": 2, "scheduled_at": "2030-01-01T09:00:00"}
    assert client.post(f"{path}/schedule", json=naive).status_code == 422
    past = {"expected_revision": 2, "scheduled_at": "2020-01-01T09:00:00+01:00"}
    detail = refused(client.post(f"{path}/schedule", json=past), 422, "invalid")
    assert (detail["field"], detail["reason"]) == ("scheduled_at", "not_future")
    # No route sends a message.
    assert client.post(f"{path}/send", json={"expected_revision": 2}).status_code in (404, 405)


def test_a_state_change_reports_the_cancelled_messages(
    app_with_sender: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    view = load(client, prospect)
    view = ok(
        client.patch(
            f"{PROSPECTS}/{prospect}/tracking",
            json={"version": view["version"], "status": "neutral"},
        )
    )
    assert view["cancelled_messages"] == 0
    for step in ("contact", "r1"):
        ok(client.put(f"{messages(prospect)}/{step}", json={"subject": "s", "body_text": "b"}), 201)

    view = ok(
        client.patch(
            f"{PROSPECTS}/{prospect}/tracking",
            json={"version": view["version"], "status": "response_received"},
        )
    )

    assert view["cancelled_messages"] == 2
    body = ok(client.get(messages(prospect)))
    assert body["sequence"]["closed"] is True
    assert [step["message"]["status"] for step in body["steps"][:2]] == ["cancelled"] * 2
    refused(
        client.post(f"{messages(prospect)}/contact/reopen", json={"expected_revision": 1}),
        409,
        "prospect_sequence_closed",
    )
    refused(client.put(f"{messages(prospect)}/r2", json={}), 409, "prospect_sequence_closed")


def test_messages_need_a_session_and_the_csrf_token(
    anonymous_client: TestClient, client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    assert anonymous_client.get(messages(prospect)).status_code == 401
    assert anonymous_client.put(f"{messages(prospect)}/contact", json={}).status_code == 401
    del client.headers[CSRF_HEADER]
    assert client.put(f"{messages(prospect)}/contact", json={}).status_code == 403
    assert (
        client.post(
            f"{messages(prospect)}/contact/cancel", json={"expected_revision": 1}
        ).status_code
        == 403
    )


def claim(session: Session, prospect: uuid.UUID, step: str) -> None:
    """Mark a scheduled message as claimed by the dispatcher (S7)."""
    session.execute(
        text(
            "UPDATE contact_messages SET dispatch_claim_id = :claim, dispatch_claimed_at = now() "
            "WHERE prospect_id = :id AND rank = :rank"
        ),
        {"claim": uuid.uuid4(), "id": prospect, "rank": ["contact", "r1", "r2"].index(step)},
    )


def scheduled(client: TestClient, prospect: uuid.UUID, step: str) -> None:
    path = f"{messages(prospect)}/{step}"
    ok(client.put(path, json={"subject": "s", "body_text": "b"}), 201)
    ok(client.post(f"{path}/validate", json={"expected_revision": 1}))
    ok(
        client.post(
            f"{path}/schedule", json={"expected_revision": 1, "scheduled_at": FUTURE.isoformat()}
        )
    )


def test_ignored_reports_cancelled_and_in_flight_messages(
    app_with_sender: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session, ContactTrackingStatus.NEUTRAL)
    ok(client.put(f"{messages(prospect)}/contact", json={"subject": "s"}), 201)
    scheduled(client, prospect, "r1")
    claim(db_session, prospect, "r1")
    view = load(client, prospect)

    view = ok(
        client.patch(
            f"{PROSPECTS}/{prospect}/tracking",
            json={"version": view["version"], "status": "ignored"},
        )
    )

    assert (view["cancelled_messages"], view["in_flight_messages"]) == (1, 1)
    steps = ok(client.get(messages(prospect)))["steps"]
    assert steps[0]["message"]["cancel_reason"] == "prospect_state:ignored"
    assert steps[1]["message"]["status"] == "scheduled"  # left to the dispatcher


def test_the_opposition_cancels_the_unsent_messages(
    app_with_sender: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session, ContactTrackingStatus.NEUTRAL)
    scheduled(client, prospect, "contact")
    view = load(client, prospect)

    view = ok(
        client.put(
            f"{PROSPECTS}/{prospect}/contactability",
            json={"do_not_contact": True, "reason": "Demande", "version": view["version"]},
        )
    )

    assert (view["cancelled_messages"], view["in_flight_messages"]) == (1, 0)
    message = ok(client.get(f"{messages(prospect)}/contact"))["message"]
    assert (message["status"], message["cancel_reason"]) == ("cancelled", "do_not_contact")
    body = ok(client.get(messages(prospect)))
    assert body["sequence"]["closed"] is True


def test_the_editor_save_reports_the_cancelled_messages(
    app_with_sender: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session, ContactTrackingStatus.NEUTRAL)
    ok(client.put(f"{messages(prospect)}/r1", json={"subject": "s"}), 201)
    view = load(client, prospect)
    tracking = body_of(view)["tracking"] | {"status": "appointment_obtained"}

    saved = ok(client.put(f"{PROSPECTS}/{prospect}", json=body_of(view, tracking=tracking)))

    assert (saved["cancelled_messages"], saved["in_flight_messages"]) == (1, 0)
    unchanged = ok(client.put(f"{PROSPECTS}/{prospect}", json=body_of(saved)))
    assert (unchanged["cancelled_messages"], unchanged["in_flight_messages"]) == (0, 0)


def test_other_checks_of_the_content(
    app_with_sender: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    path = f"{messages(prospect)}/contact"
    detail = refused(client.put(path, json={"subject": "a\r\nBcc: x@y.example"}), 422, "invalid")
    assert (detail["field"], detail["reason"]) == ("subject", "control_character")
    ok(client.put(path, json={"subject": "s", "body_text": "b"}), 201)
    ok(client.post(f"{path}/validate", json={"expected_revision": 1}))
    far = (datetime.now(UTC) + timedelta(days=400)).isoformat()
    detail = refused(
        client.post(f"{path}/schedule", json={"expected_revision": 1, "scheduled_at": far}),
        422,
        "invalid",
    )
    assert (detail["field"], detail["reason"]) == ("scheduled_at", "too_far")


# --- sequences (rework D3, D6) ------------------------------------------------------------------


def test_mark_sent_over_http(
    app_with_sender: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    ok(client.put(f"{messages(prospect)}/contact", json={"subject": "s", "body_text": "b"}), 201)

    sent = ok(
        client.post(
            f"{messages(prospect)}/mark-sent",
            json={"rank": 0, "sent_at": "2026-09-07T10:00:00+02:00"},
        )
    )
    bare = ok(client.post(f"{messages(prospect)}/mark-sent", json={"rank": 1}), 201)

    assert (sent["created"], sent["message"]["status"], sent["message"]["sent_source"]) == (
        False,
        "sent",
        "manual",
    )
    assert (sent["message"]["rank"], sent["message"]["step"]) == (0, "contact")
    assert (bare["created"], bare["message"]["rank"], bare["message"]["step"]) == (True, 1, "r1")
    place = ok(client.get(f"{PROSPECTS}/{prospect}/sequences"))["place"]
    assert (place["sent_count"], place["next_step"], place["level_label"]) == (2, "r2", "R2")
    # The planning's level key, as in `GET …/messages` and the Contact / Prospection lists.
    listed = ok(client.get(messages(prospect)))["sequence"]
    assert place["level"] == listed["level"] == "r1_sent"
    detail = refused(
        client.post(
            f"{messages(prospect)}/mark-sent",
            json={"rank": 2, "sent_at": "2020-01-01T00:00:00Z"},
        ),
        422,
        "invalid",
    )
    assert (detail["field"], detail["reason"]) == ("sent_at", "before_previous_send")
    assert (
        client.post(
            f"{messages(prospect)}/mark-sent", json={"rank": 2, "sent_at": "2026-09-07T10:00:00"}
        )
    ).status_code == 422  # a time zone is required
    # The rank the person saw is required (S4): a bare declaration is refused.
    assert client.post(f"{messages(prospect)}/mark-sent", json={}).status_code == 422


def test_without_a_cohort_the_sequence_is_closed(
    app_with_sender: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session, in_cohort=False)

    body = ok(client.get(messages(prospect)))

    assert (body["sequence"]["sequence_id"], body["sequence"]["closed"]) == (None, True)
    refused(client.put(f"{messages(prospect)}/contact", json={}), 409, "no_open_sequence")
    refused(
        client.post(f"{messages(prospect)}/mark-sent", json={"rank": 0}), 409, "no_open_sequence"
    )


def test_s0_is_out_of_campaign_over_http(
    app_with_sender: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session, in_cohort=False)
    client.put(
        f"{PROSPECTS}/{prospect}/cohort", json={"cohort_id": str(add_cohort(db_session, "S0").id)}
    )

    body = ok(client.get(messages(prospect)))

    assert (body["sequence"]["out_of_campaign"], body["sequence"]["closed"]) == (True, True)
    refused(client.put(f"{messages(prospect)}/contact", json={}), 409, "out_of_campaign")
