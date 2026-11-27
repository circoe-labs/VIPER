"""A send that did not leave stays visible and is recovered by a person only, and the drafts of
the scheduled messages are checked before they are due (fake Toolbox, injected time)."""

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.core.logs import configure_logging
from app.models import Warehouse, WarehouseDraft
from app.models.enums import ContactMessageStatus, ContactTrackingStatus
from app.services.contact_dispatch_worker import CHECK_INTERVAL, ContactDispatcher
from app.services.contact_draft_check import check_scheduled_drafts
from app.services.warehouse_dispatch import dispatch_warehouses
from tests.builders import add_company, add_email, add_prospect, start_sequence
from tests.fake_toolbox import Draft, FakeToolbox
from tests.test_contact_dispatch import (
    DUE,
    Clock,
    actions_of,
    config,
    dispatcher,
    row,
    scheduled,
    toolbox_of,
)
from tests.test_contact_messages_api import FUTURE, messages, ok, prospect_id, refused

M = ContactMessageStatus
LATER = FUTURE + timedelta(days=7)


def unsent(client: TestClient) -> dict[str, Any]:
    return ok(client.get("/api/contact/unsent"))


def planning_row(client: TestClient, prospect: uuid.UUID) -> dict[str, Any]:
    page = ok(client.get("/api/contact/prospects?category=to_send&limit=200"))
    return next(item for item in page["items"] if item["id"] == str(prospect))


def target(prospect: uuid.UUID, confirmed: bool = False, rank: int = 0) -> dict[str, Any]:
    return {
        "prospect_id": str(prospect),
        "rank": rank,
        "expected_revision": 1,
        "sent_check_confirmed": confirmed,
    }


def reschedule(client: TestClient, *targets: dict[str, Any]) -> dict[str, Any]:
    return ok(
        client.post(
            "/api/contact/unsent/reschedule",
            json={"scheduled_at": LATER.isoformat(), "items": list(targets)},
        )
    )


def test_a_scheduled_message_is_said_as_scheduled_and_never_overdue(
    connected: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session, ContactTrackingStatus.NEUTRAL)
    before = planning_row(connected, prospect)
    assert before["overdue"] is True and before["send"] is None  # an old cohort date
    assert ok(connected.get("/api/prospection/prospects?segment=due"))["total"] == 1

    scheduled(connected, prospect)

    after = planning_row(connected, prospect)
    assert after["overdue"] is False
    assert after["send"]["state"] == "scheduled"
    assert datetime.fromisoformat(after["send"]["scheduled_at"]) == FUTURE
    # The theoretical due date is still there, apart from the effective schedule.
    assert after["next_due_at"] == before["next_due_at"]
    assert ok(connected.get("/api/prospection/prospects?segment=due"))["total"] == 0
    (listed,) = ok(connected.get("/api/prospection/prospects"))["items"]
    assert (listed["due"], listed["send"]["state"]) == (False, "scheduled")
    place = ok(connected.get(f"/api/prospects/{prospect}/sequences"))["place"]
    assert place["send"]["state"] == "scheduled"
    assert unsent(connected)["items"] == []


def test_a_draft_gone_at_send_time_stays_visible_and_needs_the_sent_items_check(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    fake.drafts.clear()
    dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))

    back = row(db_session, message["id"])
    assert (back.status, back.scheduled_at) == (M.VALIDATED, None)
    assert (back.missed_scheduled_at, back.missed_reason, back.missed_at) == (
        FUTURE,
        "send_draft_not_found",
        DUE,
    )
    send = planning_row(connected, prospect)["send"]
    assert (send["state"], send["reason"], send["needs_sent_check"]) == (
        "doubt",
        "send_draft_not_found",
        True,
    )
    (item,) = unsent(connected)["items"]
    assert (item["kind"], item["send"]["step"]) == ("doubt", "contact")

    # No path reschedules it without the person's confirmation: editor, series, bulk.
    path = f"{messages(prospect)}/contact/schedule"
    body = {"expected_revision": 1, "scheduled_at": LATER.isoformat()}
    refused(connected.post(path, json=body), 409, "sent_check_required")
    series = ok(
        connected.post(
            "/api/contact/schedule-cohorts",
            json={"cohorts": ["S41"], "step": "contact", "scheduled_at": LATER.isoformat()},
        )
    )
    assert (series["scheduled"], series["refused"], series["to_check"]) == (0, 1, 1)
    answer = reschedule(connected, target(prospect))
    assert answer["done"] == 0
    assert [entry["code"] for entry in answer["refused"]] == ["sent_check_required"]
    assert fake.sent == []

    assert reschedule(connected, target(prospect, confirmed=True))["done"] == 1
    again = row(db_session, message["id"])
    assert (again.status, again.scheduled_at) == (M.SCHEDULED, LATER)
    assert (again.missed_scheduled_at, again.missed_reason) == (None, None)
    assert again.remote_draft_id in fake.drafts  # a new draft was made
    assert ("contact_message.scheduled", "sent_items_checked") in actions_of(
        db_session, message["id"]
    )
    assert unsent(connected)["items"] == []


def test_a_bulk_reschedule_never_carries_an_unconfirmed_send_along(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    safe = prospect_id(db_session)
    late_message = scheduled(connected, safe)
    dispatcher(toolbox_app, Clock(FUTURE + timedelta(hours=7))).run_pass(toolbox_of(toolbox_app))
    other = add_prospect(db_session, add_company(db_session, "Autre Société"), last_name="Autre")
    add_email(db_session, other, "autre.test@exemple.example", is_primary=True)
    start_sequence(db_session, other)
    doubtful = other.id
    lost = scheduled(connected, doubtful)
    del fake.drafts[str(row(db_session, lost["id"]).remote_draft_id)]
    dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))

    assert {item["send"]["reason"] for item in unsent(connected)["items"]} == {
        "dispatch_overdue",
        "send_draft_not_found",
    }
    answer = reschedule(connected, target(safe), target(doubtful))
    assert answer["done"] == 1
    assert [entry["prospect_id"] for entry in answer["refused"]] == [str(doubtful)]
    assert row(db_session, late_message["id"]).status is M.SCHEDULED
    assert row(db_session, lost["id"]).status is M.VALIDATED


def test_a_person_taking_a_send_back_is_said_not_listed_as_a_failure(
    connected: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    ok(connected.post(f"{messages(prospect)}/contact/unschedule", json={"expected_revision": 1}))
    send = planning_row(connected, prospect)["send"]
    assert (send["state"], send["reason"]) == ("unscheduled", "unscheduled_by_person")
    assert row(db_session, message["id"]).missed_scheduled_at == FUTURE
    assert unsent(connected)["items"] == []
    ok(connected.post(f"{messages(prospect)}/contact/cancel", json={"expected_revision": 1}))
    assert row(db_session, message["id"]).status is M.CANCELLED


def test_a_missing_draft_is_flagged_before_due_time_and_never_recreated_alone(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    draft_id = str(row(db_session, message["id"]).remote_draft_id)
    kept = fake.drafts.pop(draft_id)
    factory = toolbox_app.state.session_factory
    toolbox = toolbox_of(toolbox_app)

    report = check_scheduled_drafts(factory, toolbox)

    assert (report.present, report.missing, report.unverified) == (0, 1, 0)
    flagged = row(db_session, message["id"])
    assert (flagged.status, flagged.scheduled_at, flagged.draft_check) == (
        M.SCHEDULED,
        FUTURE,
        "missing",
    )
    assert fake.drafts == {} and fake.sent == []  # nothing recreated, nothing sent
    (item,) = unsent(connected)["items"]
    assert (item["kind"], item["send"]["needs_sent_check"]) == ("draft_missing", True)

    # Seen again: the flag goes.
    fake.drafts[draft_id] = kept
    assert check_scheduled_drafts(factory, toolbox).present == 1
    assert row(db_session, message["id"]).draft_check is None

    # Gone for good: a person confirms, a new draft is made and the date stays.
    del fake.drafts[draft_id]
    check_scheduled_drafts(factory, toolbox)
    url = "/api/contact/unsent/recreate-drafts"
    answer = ok(connected.post(url, json={"items": [target(prospect)]}))
    assert [entry["code"] for entry in answer["refused"]] == ["sent_check_required"]
    assert fake.drafts == {}
    answer = ok(connected.post(url, json={"items": [target(prospect, confirmed=True)]}))
    assert (answer["done"], answer["remote_draft_failures"]) == (1, 0)
    renewed = row(db_session, message["id"])
    assert (renewed.status, renewed.scheduled_at, renewed.draft_check) == (
        M.SCHEDULED,
        FUTURE,
        None,
    )
    assert renewed.remote_draft_id in fake.drafts and renewed.remote_draft_id != draft_id
    assert dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox).sent == 1


def test_a_full_draft_list_proves_nothing(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    del fake.drafts[str(row(db_session, message["id"]).remote_draft_id)]
    for index in range(100):
        fake.drafts[f"other-{index}"] = Draft(
            to=["x@exemple.example"], subject="s", text="t", cc=[], bcc=[]
        )

    report = check_scheduled_drafts(toolbox_app.state.session_factory, toolbox_of(toolbox_app))

    assert (report.missing, report.unverified) == (0, 1)
    assert row(db_session, message["id"]).draft_check == "unverified"
    body = unsent(connected)
    assert (body["items"], body["unverified_drafts"]) == ([], 1)


def test_the_worker_checks_after_a_connection_then_at_intervals(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    draft_id = str(row(db_session, message["id"]).remote_draft_id)
    kept = fake.drafts.pop(draft_id)
    clock = Clock(datetime.now(UTC))
    worker = ContactDispatcher(
        toolbox_app.state.toolbox, toolbox_app.state.session_factory, config(), now=clock
    )

    worker.run_once()
    assert row(db_session, message["id"]).draft_check == "missing"
    fake.drafts[draft_id] = kept
    worker.run_once()  # not due yet
    assert row(db_session, message["id"]).draft_check == "missing"
    clock.at += CHECK_INTERVAL
    worker.run_once()
    assert row(db_session, message["id"]).draft_check is None


def test_a_warehouse_mail_that_does_not_leave_says_why(
    db_session: Session, session_factory: sessionmaker[Session]
) -> None:
    site = Warehouse(name="Site", contacts=[])
    db_session.add(site)
    db_session.flush()
    draft = WarehouseDraft(
        warehouse_id=site.id,
        warehouse_name="Site",
        contact_name="Anne",
        recipient="anne@example.test",
        subject="Objet",
        body="Bonjour",
        review_note="À vérifier",
        scheduled_at=datetime.now(UTC) - timedelta(days=2),
        send_state="scheduled",
        validated_at=datetime.now(UTC) - timedelta(days=3),
        human_validated=True,
    )
    db_session.add(draft)
    db_session.flush()

    dispatch_warehouses(session_factory, config(), None)  # type: ignore[arg-type]

    db_session.expire_all()
    failed = db_session.get(WarehouseDraft, draft.id)
    assert failed is not None
    assert (failed.send_state, failed.failure_code) == ("failed", "dispatch_overdue")
    assert failed.failed_at is not None and failed.scheduled_at is not None


def test_the_application_logs_reach_stderr_at_info() -> None:
    configure_logging()
    configure_logging()
    logger = logging.getLogger("app")
    assert logging.getLogger("app.services.contact_dispatch").isEnabledFor(logging.INFO)
    assert [handler.get_name() for handler in logger.handlers].count("viper-app") == 1
