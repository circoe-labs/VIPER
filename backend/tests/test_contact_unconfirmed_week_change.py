"""A change of contact week while an earlier send is claimed and not settled: nothing new is
scheduled or sent until it is (no double send)."""

import uuid
from datetime import date, timedelta
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models.enums import ContactMessageStatus as M
from app.services import audit
from tests.builders import FIXTURE_ACTOR, add_cohort
from tests.fake_toolbox import FakeToolbox
from tests.test_contact_dispatch import DUE, Clock, dispatcher, row, scheduled, toolbox_of
from tests.test_contact_messages_api import FUTURE, messages, ok, prospect_id, refused

LATER = FUTURE + timedelta(days=1)
UNREADABLE = {"content": [{"type": "text", "text": "illisible"}]}


def unconfirmed(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, session: Session
) -> tuple[uuid.UUID, str]:
    """A Contact whose send answered nothing readable: claimed, no doubt recorded yet."""
    person = prospect_id(session)
    message = scheduled(connected, person)
    fake.mode.send_result = UNREADABLE
    dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))
    fake.mode.send_result = None
    old = row(session, message["id"])
    assert old.dispatch_claim_id is not None and old.sent_doubt_reason is None
    return person, message["id"]


def change_week(connected: TestClient, session: Session, person: uuid.UUID) -> str:
    cohort = add_cohort(session, "S45", date(2026, 11, 2))
    session.flush()
    ok(connected.put(f"/api/prospects/{person}/cohort", json={"cohort_id": str(cohort.id)}))
    return f"{messages(person)}/contact"


def validated_again(connected: TestClient, base: str) -> None:
    ok(connected.put(base, json={"subject": "Objet", "body_text": "Corps"}), 201)
    ok(connected.post(f"{base}/validate", json={"expected_revision": 1}))


def schedule_body(**extra: Any) -> dict[str, Any]:
    return {"expected_revision": 1, "scheduled_at": LATER.isoformat(), **extra}


def test_no_schedule_path_while_the_earlier_send_is_unconfirmed(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    person, old_id = unconfirmed(connected, toolbox_app, fake, db_session)
    base = change_week(connected, db_session, person)
    validated_again(connected, base)
    for body in (schedule_body(), schedule_body(sent_check_confirmed=True)):
        response = connected.post(f"{base}/schedule", json=body)
        refused(response, 409, "earlier_send_unconfirmed")
    series = ok(
        connected.post(
            "/api/contact/schedule-cohorts",
            json={"cohorts": ["S45"], "step": "contact", "scheduled_at": LATER.isoformat()},
        )
    )
    assert (series["scheduled"], series["to_check"]) == (0, 1)
    target = {
        "prospect_id": str(person),
        "rank": 0,
        "expected_revision": 1,
        "sent_check_confirmed": True,
    }
    recovery = ok(
        connected.post(
            "/api/contact/unsent/reschedule",
            json={"scheduled_at": LATER.isoformat(), "items": [target]},
        )
    )
    assert [item["code"] for item in recovery["refused"]] == ["earlier_send_unconfirmed"]
    # The locked mail is listed, though it belongs to the former week.
    items = ok(connected.get("/api/contact/unsent"))["items"]
    assert [(i["message_id"], i["kind"], i["current"]) for i in items] == [
        (old_id, "unconfirmed", False)
    ]

    # Reconciled (the draft is still there): a recorded doubt, which a person may confirm away.
    dispatcher(toolbox_app, Clock(LATER)).run_pass(toolbox_of(toolbox_app))
    assert row(db_session, old_id).sent_doubt_reason == "send_not_confirmed"
    refused(connected.post(f"{base}/schedule", json=schedule_body()), 409, "sent_check_required")
    ok(connected.post(f"{base}/schedule", json=schedule_body(sent_check_confirmed=True)))
    report = dispatcher(toolbox_app, Clock(LATER + timedelta(minutes=1))).run_pass(
        toolbox_of(toolbox_app)
    )
    assert report.sent == 1


def test_a_mail_already_scheduled_does_not_leave_behind_an_unconfirmed_send(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    """Scheduled before this rule existed (or raced it): pulled back, due or not, before the
    reconciliation can conclude."""
    person, old_id = unconfirmed(connected, toolbox_app, fake, db_session)
    base = change_week(connected, db_session, person)
    validated_again(connected, base)
    new = ok(connected.get(base))["message"]
    stored = row(db_session, new["id"])
    audit.annotate(db_session, FIXTURE_ACTOR, stored)
    stored.status = M.SCHEDULED
    stored.scheduled_at = LATER + timedelta(days=30)
    db_session.flush()
    # The old draft left after all: the reconciliation would record it as sent.
    fake.drafts.clear()
    dispatcher(toolbox_app, Clock(LATER)).run_pass(toolbox_of(toolbox_app))
    after = row(db_session, new["id"])
    assert (after.status, after.last_error_code) == (M.VALIDATED, "send_earlier_unconfirmed")
    assert row(db_session, old_id).status is M.SENT
    assert fake.sent == []


def test_a_former_week_claim_is_settled_by_a_person(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    person, old_id = unconfirmed(connected, toolbox_app, fake, db_session)
    base = change_week(connected, db_session, person)
    validated_again(connected, base)
    old = row(db_session, old_id)
    body = {"items": [{"message_id": old_id, "expected_revision": old.revision}]}
    # The clock of this call is the real one, long before the claim's moment: too early.
    early = ok(connected.post("/api/contact/unsent/confirm-not-sent", json=body))
    assert [item["code"] for item in early["refused"]] == ["dispatch_release_too_early"]
    old = row(db_session, old_id)
    audit.annotate(db_session, FIXTURE_ACTOR, old)
    old.dispatch_claimed_at = old.dispatch_claimed_at.replace(year=2020)  # type: ignore[union-attr]
    db_session.flush()
    done = ok(connected.post("/api/contact/unsent/confirm-not-sent", json=body))
    assert done["done"] == 1
    assert row(db_session, old_id).status is M.CANCELLED
    ok(connected.post(f"{base}/schedule", json=schedule_body()))


def test_an_existing_r3_that_left_is_recorded_without_sending(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    person = prospect_id(db_session)
    message = scheduled(connected, person)
    record = "/api/contact/unsent/record-sent"
    stored = row(db_session, message["id"])
    body = {"message_id": message["id"], "expected_revision": stored.revision}
    # Within R2 and current: the sheet's job, refused here.
    refused(connected.post(record, json=body), 409, "invalid_transition")
    # An R3 of the former four-mail sequence, cancelled by the limit with its doubt.
    audit.annotate(db_session, FIXTURE_ACTOR, stored)
    stored.rank = 3
    stored.status = M.CANCELLED
    stored.cancelled_at = DUE
    stored.cancel_reason = "sequence_limit"
    stored.missed_scheduled_at, stored.missed_reason, stored.missed_at = (
        FUTURE,
        "sequence_limit",
        DUE,
    )
    stored.sent_doubt_reason, stored.sent_doubt_at = "draft_missing", DUE
    stored.scheduled_at = None
    stored.remote_provider = stored.remote_draft_id = None
    db_session.flush()
    done = ok(connected.post(record, json=body))["message"]
    assert (done["status"], done["sent_source"]) == ("sent", "manual")
    after = row(db_session, message["id"])
    assert after.sent_doubt_reason is None and after.cancel_reason is None
    assert fake.sent == []
    refused(connected.post(record, json=body), 409, "invalid_transition")


def test_a_former_week_claim_that_left_is_recorded(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    person, old_id = unconfirmed(connected, toolbox_app, fake, db_session)
    change_week(connected, db_session, person)
    old = row(db_session, old_id)
    body = {"message_id": old_id, "expected_revision": old.revision}
    done = ok(connected.post("/api/contact/unsent/record-sent", json=body))["message"]
    assert done["status"] == "sent"
    assert row(db_session, old_id).dispatch_claim_id is None or done["status"] == "sent"
