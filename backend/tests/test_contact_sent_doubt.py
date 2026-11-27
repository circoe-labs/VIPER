"""The two ways a mail could leave twice or a recovery fail, with a connected fake Toolbox and a
dispatcher in the process: the « may have left » doubt survives every change until a person says
they looked in the sent items, and the bulk recovery answers once the schedule is committed."""

import uuid
from datetime import timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ContactMessage
from app.models.enums import ContactMessageStatus
from app.services.contact_dispatch_worker import ContactDispatcher
from app.services.contact_draft_check import check_scheduled_drafts
from tests.builders import add_cohort
from tests.fake_toolbox import FakeToolbox
from tests.test_contact_dispatch import (
    Clock,
    config,
    dispatcher,
    row,
    scheduled,
    toolbox_of,
)
from tests.test_contact_messages_api import FUTURE, messages, ok, prospect_id, refused
from tests.test_contact_unsent import LATER, reschedule, target, unsent

M = ContactMessageStatus


def series(client: TestClient, cohort: str = "S41") -> dict[str, Any]:
    return ok(
        client.post(
            "/api/contact/schedule-cohorts",
            json={"cohorts": [cohort], "step": "contact", "scheduled_at": LATER.isoformat()},
        )
    )


def sent_by_hand(
    client: TestClient, app: FastAPI, fake: FakeToolbox, session: Session
) -> tuple[uuid.UUID, dict[str, Any]]:
    """A scheduled mail whose draft left the mailbox (sent from Infomaniak), seen by the check."""
    prospect = prospect_id(session)
    message = scheduled(client, prospect)
    del fake.drafts[str(row(session, message["id"]).remote_draft_id)]
    check_scheduled_drafts(app.state.session_factory, toolbox_of(app))
    return prospect, message


def text_of(response: Any) -> int:
    revision: int = ok(response)["message"]["revision"]
    return revision


@pytest.mark.parametrize(
    "path", ["edit", "unschedule_edit", "cancel_reopen", "overdue_edit", "restore"]
)
def test_the_doubt_survives_every_change_until_a_person_confirms(
    connected: TestClient,
    toolbox_app: FastAPI,
    fake: FakeToolbox,
    db_session: Session,
    path: str,
) -> None:
    prospect, message = sent_by_hand(connected, toolbox_app, fake, db_session)
    base = f"{messages(prospect)}/contact"
    revision = {"expected_revision": 1}
    if path == "overdue_edit":
        late = Clock(FUTURE + timedelta(hours=7))
        dispatcher(toolbox_app, late).run_pass(toolbox_of(toolbox_app))
    if path == "unschedule_edit":
        ok(connected.post(f"{base}/unschedule", json=revision))
    if path == "cancel_reopen":
        ok(connected.post(f"{base}/cancel", json=revision))
        now = text_of(connected.post(f"{base}/reopen", json=revision))
    else:
        now = text_of(connected.put(base, json={**revision, "body_text": "Nouveau texte"}))
    if path == "restore":
        versions = ok(connected.get(f"{base}/versions"))["versions"]
        body = {"expected_revision": now}
        now = text_of(connected.post(f"{base}/versions/{versions[-1]['id']}/restore", json=body))

    changed = row(db_session, message["id"])
    assert changed.sent_doubt_reason == "draft_missing"
    (item,) = unsent(connected)["items"]
    assert (item["kind"], item["send"]["needs_sent_check"]) == ("doubt", True)

    # The series validates the draft but never schedules it.
    answer = series(connected)
    assert (answer["scheduled"], answer["to_check"]) == (0, 1)
    # Nor does the editor without the confirmation, and the record cannot be quietly deleted.
    current = row(db_session, message["id"]).revision
    unconfirmed = {"expected_revision": current}
    if row(db_session, message["id"]).status is M.DRAFT:
        # The series' refusal rolled its own validation back.
        ok(connected.post(f"{base}/validate", json=unconfirmed))
    schedule = {**unconfirmed, "scheduled_at": LATER.isoformat()}
    refused(connected.post(f"{base}/schedule", json=schedule), 409, "sent_check_required")
    refused(connected.post(f"{base}/delete", json=unconfirmed), 409, "sent_check_required")
    dispatcher(toolbox_app, Clock(LATER + timedelta(minutes=1))).run_pass(toolbox_of(toolbox_app))
    assert fake.sent == []

    ok(connected.post(f"{base}/schedule", json={**schedule, "sent_check_confirmed": True}))
    confirmed = row(db_session, message["id"])
    assert (confirmed.status, confirmed.sent_doubt_reason) == (M.SCHEDULED, None)


def test_the_doubt_follows_the_prospect_into_a_new_contact_week(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect, message = sent_by_hand(connected, toolbox_app, fake, db_session)
    other = add_cohort(db_session, "S45")
    ok(connected.put(f"/api/prospects/{prospect}/cohort", json={"cohort_id": str(other.id)}))
    ok(
        connected.put(
            f"{messages(prospect)}/contact", json={"subject": "Objet", "body_text": "Texte"}
        ),
        201,
    )

    (item,) = unsent(connected)["items"]
    assert (item["message_id"], item["current"], item["status"]) == (
        message["id"],
        False,
        "cancelled",
    )
    assert series(connected, "S45")["to_check"] == 1
    step = ok(connected.get(messages(prospect)))["steps"][0]["message"]
    assert step["needs_sent_check"] is True

    answer = ok(
        connected.post(
            "/api/contact/unsent/confirm-not-sent",
            json={"items": [{"message_id": message["id"], "expected_revision": 1}]},
        )
    )
    assert answer == {"done": 1, "refused": []}
    assert row(db_session, message["id"]).sent_doubt_reason is None
    assert unsent(connected)["items"] == []
    assert series(connected, "S45")["scheduled"] == 1


def test_marking_it_sent_clears_the_doubt(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect, message = sent_by_hand(connected, toolbox_app, fake, db_session)
    ok(connected.post(f"{messages(prospect)}/mark-sent", json={"rank": 0}))
    done = row(db_session, message["id"])
    assert (done.status, done.sent_doubt_reason) == (M.SENT, None)
    assert unsent(connected)["items"] == []


@pytest.mark.parametrize("action", ["reschedule", "recreate-drafts"])
def test_a_recovery_with_a_dispatcher_and_a_connected_toolbox_answers(
    connected: TestClient,
    toolbox_app: FastAPI,
    fake: FakeToolbox,
    db_session: Session,
    action: str,
) -> None:
    """The bulk reschedule answered 500 after scheduling: the request's transaction was ended
    twice. Only seen with a dispatcher in the process."""
    prospect, message = sent_by_hand(connected, toolbox_app, fake, db_session)
    if action == "reschedule":
        ok(
            connected.post(
                f"{messages(prospect)}/contact/unschedule", json={"expected_revision": 1}
            )
        )
    toolbox_app.state.contact_dispatcher = ContactDispatcher(
        toolbox_app.state.toolbox, toolbox_app.state.session_factory, config()
    )
    item = target(prospect, confirmed=True)
    if action == "reschedule":
        answer = reschedule(connected, item)
    else:
        answer = ok(connected.post("/api/contact/unsent/recreate-drafts", json={"items": [item]}))
    assert (answer["done"], answer["refused"], answer["remote_draft_failures"]) == (1, [], 0)
    stored = db_session.scalars(select(ContactMessage.remote_draft_id)).one()
    assert stored in fake.drafts
    assert row(db_session, message["id"]).status is M.SCHEDULED
