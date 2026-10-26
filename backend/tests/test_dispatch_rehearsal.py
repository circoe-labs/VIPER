"""Rehearsal of the first big scheduled send (2026-10-12 08:00 Paris = 06:00 UTC): 90 scheduled
messages, 47 R1 whose Infomaniak draft creation had an unknown outcome and 43 R2, none with a
remote draft yet, every previous step already sent. The real dispatcher against the fake Toolbox
(never a real mailbox), with the clock injected, under the failures a real morning can bring."""

import uuid
from datetime import timedelta

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ContactMessage
from app.models.enums import ContactMessageStatus
from tests.fake_toolbox import FakeToolbox
from tests.test_contact_dispatch import (
    DUE,
    Clock,
    dispatcher,
    toolbox_of,
)
from tests.test_contact_messages_api import FUTURE, messages, ok, prospect_id
from tests.test_contact_remote_drafts import validated

M = ContactMessageStatus
R1, R2 = 47, 43


def population(
    client: TestClient, session: Session, fake: FakeToolbox, r1: int = R1, r2: int = R2
) -> list[uuid.UUID]:
    """The state found in the real base: scheduled at the same moment, no remote draft, the R1
    ones carrying `toolbox_outcome_unknown`, the previous steps sent."""
    ids: list[uuid.UUID] = []
    for step, count in (("r1", r1), ("r2", r2)):
        for _ in range(count):
            prospect = prospect_id(session)
            ranks = 1 if step == "r1" else 2
            for rank in range(ranks):
                ok(client.post(f"{messages(prospect)}/mark-sent", json={"rank": rank}), 201)
            if step == "r1":
                fake.mode.lose_answer_of = "infomaniak.mail.create_draft"
            else:
                fake.mode.http_status = 503
            validated(client, prospect, step)
            body = ok(
                client.post(
                    f"{messages(prospect)}/{step}/schedule",
                    json={"expected_revision": 1, "scheduled_at": FUTURE.isoformat()},
                )
            )
            fake.mode.lose_answer_of = None
            fake.mode.http_status = None
            ids.append(uuid.UUID(body["message"]["id"]))
    fake.drafts.clear()  # the real mailbox held no draft at all
    fake.sent.clear()
    return ids


def statuses(session: Session, ids: list[uuid.UUID]) -> dict[str, int]:
    session.expire_all()
    counts: dict[str, int] = {}
    for message in session.scalars(select(ContactMessage).where(ContactMessage.id.in_(ids))):
        counts[message.status.value] = counts.get(message.status.value, 0) + 1
    return counts


def test_the_nominal_morning_sends_all_ninety_once(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    ids = population(connected, db_session, fake)
    assert len(ids) == R1 + R2 and fake.drafts == {}
    pass_ = dispatcher(toolbox_app, Clock(DUE))
    toolbox = toolbox_of(toolbox_app)

    report = pass_.run_pass(toolbox)

    assert report.sent == R1 + R2, report.summary
    assert statuses(db_session, ids) == {"sent": R1 + R2}
    assert len(fake.sent) == R1 + R2 and len(set(fake.sent)) == R1 + R2
    # Further passes, a restart (a fresh dispatcher), a late wake-up: nothing leaves twice.
    assert pass_.run_pass(toolbox).sent == 0
    assert dispatcher(toolbox_app, Clock(DUE + timedelta(hours=1))).run_pass(toolbox).sent == 0
    assert len(fake.sent) == R1 + R2


def test_a_toolbox_down_at_eight_then_back_still_sends_everything_once(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    ids = population(connected, db_session, fake)
    clock = Clock(DUE)
    toolbox = toolbox_of(toolbox_app)
    fake.mode.http_status = 503

    first = dispatcher(toolbox_app, clock).run_pass(toolbox)
    assert first.sent == 0 and fake.sent == []
    assert statuses(db_session, ids) == {"scheduled": R1 + R2}  # nothing lost, nothing sent

    fake.mode.http_status = None
    for minutes in (1, 2, 4, 8, 16, 32):  # the worker keeps passing; backoff then retries
        clock.at = DUE + timedelta(minutes=minutes)
        dispatcher(toolbox_app, clock).run_pass(toolbox)  # a fresh dispatcher: a restart each time

    assert statuses(db_session, ids) == {"sent": R1 + R2}
    assert len(fake.sent) == R1 + R2 and len(set(fake.sent)) == R1 + R2


def test_draft_creation_answers_lost_at_eight_are_recovered_without_duplicates(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    ids = population(connected, db_session, fake)
    before = len(fake.calls)
    clock = Clock(DUE)
    toolbox = toolbox_of(toolbox_app)
    fake.mode.lose_answer_of = "infomaniak.mail.create_draft"  # drafts get created, answers lost

    dispatcher(toolbox_app, clock).run_pass(toolbox)
    assert len(set(fake.sent)) == len(fake.sent)  # whatever left in this pass left once

    fake.mode.lose_answer_of = None
    for minutes in (2, 5, 10, 20):
        clock.at = DUE + timedelta(minutes=minutes)
        dispatcher(toolbox_app, clock).run_pass(toolbox)

    assert statuses(db_session, ids) == {"sent": R1 + R2}
    assert len(fake.sent) == R1 + R2 and len(set(fake.sent)) == R1 + R2
    # Every recipient got exactly one mail: a draft whose answer was lost is found again, never
    # created a second time.
    creations = [call for call in fake.calls[before:] if call[1] == "infomaniak.mail.create_draft"]
    assert len(creations) == R1 + R2


def test_a_worker_started_within_the_lateness_window_still_sends(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    ids = population(connected, db_session, fake)
    late = FUTURE + timedelta(hours=5, minutes=59)

    report = dispatcher(toolbox_app, Clock(late)).run_pass(toolbox_of(toolbox_app))

    assert report.sent == R1 + R2, report.summary
    assert statuses(db_session, ids) == {"sent": R1 + R2}


def test_a_worker_started_after_six_hours_sends_nothing_and_loses_nothing(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    ids = population(connected, db_session, fake)
    late = FUTURE + timedelta(hours=6, seconds=1)

    report = dispatcher(toolbox_app, Clock(late)).run_pass(toolbox_of(toolbox_app))

    assert (report.sent, report.overdue) == (0, R1 + R2)
    assert fake.sent == []
    # Back to Validé with the reason, ready to be scheduled again: no late send.
    assert statuses(db_session, ids) == {"validated": R1 + R2}


def test_an_unrecognised_send_answer_holds_the_claim_and_never_resends(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    """The Infomaniak login page returned as a send error (seen in the diagnostic): the outcome
    is unknown, so VIPER keeps the claim and a person settles it. Nothing is sent twice."""
    ids = population(connected, db_session, fake, r1=3, r2=0)
    fake.mode.send_result = {
        "content": [
            {"type": "text", "text": "L'API Infomaniak Mail a répondu 400 : <!doctype html><html>"}
        ],
        "isError": True,
    }
    clock = Clock(DUE)
    toolbox = toolbox_of(toolbox_app)

    report = dispatcher(toolbox_app, clock).run_pass(toolbox)
    assert report.uncertain == 3, report.summary
    assert fake.sent == []

    fake.mode.send_result = None
    clock.at = DUE + timedelta(minutes=5)
    assert dispatcher(toolbox_app, clock).run_pass(toolbox).sent == 0  # never resent by itself
    assert statuses(db_session, ids) == {"scheduled": 3}
