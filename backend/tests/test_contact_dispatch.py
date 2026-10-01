"""Scheduled sending (Contact port S7, handoff Task 16): the dispatcher against the local fake
Toolbox (`tests/fake_toolbox.py`, never a real Toolbox — P6), with the time injected. Due or not,
lateness, step order, a sequence closed meanwhile, the opposition, the allowlist, stale claims,
unknown outcomes and their reconciliation, attempts and backoff, a missing remote draft, an edit
after scheduling, the people's « Marquer envoyé » / « Remettre en Validé », the CLI, the worker
and two passes in two processes (two database sessions) at once."""

import threading
import uuid
from collections.abc import Iterator
from datetime import datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import Engine, select, text
from sqlalchemy.orm import Session, sessionmaker

from app import cli
from app.core.config import Settings
from app.db.session import create_session_factory
from app.models import AuditLogEntry, ContactMessage, ContactTracking
from app.models.enums import ContactMessageStatus, ContactMessageStep, ContactTrackingStatus
from app.services import audit
from app.services.contact_dispatch import (
    DISPATCH_ACTOR,
    DispatchConfig,
    Dispatcher,
    DispatchReport,
    backoff,
    classify_send_error,
    hold_scheduled,
)
from app.services.contact_dispatch_worker import ContactDispatcher
from app.services.toolbox.errors import toolbox_error
from app.services.toolbox.integration import ToolboxIntegration
from app.services.toolbox.mcp_client import DraftInput, DraftSummary, MailToolbox, SendResult
from tests.builders import FIXTURE_ACTOR, add_company, add_email, add_prospect
from tests.fake_toolbox import FakeToolbox
from tests.test_contact_messages_api import FUTURE, messages, ok, prospect_id, refused
from tests.test_contact_remote_drafts import validated

M = ContactMessageStatus
DUE = FUTURE + timedelta(minutes=1)


def config(**overrides: Any) -> DispatchConfig:
    values: dict[str, Any] = {
        "interval": timedelta(seconds=30),
        "max_lateness": timedelta(hours=6),
        "claim_ttl": timedelta(minutes=10),
        "max_attempts": 5,
        "retry_base": timedelta(minutes=1),
    }
    return DispatchConfig(**(values | overrides))


class Clock:
    def __init__(self, at: datetime) -> None:
        self.at = at

    def __call__(self) -> datetime:
        return self.at


def dispatcher(app: FastAPI, clock: Clock, **overrides: Any) -> Dispatcher:
    return Dispatcher(app.state.session_factory, config(**overrides), now=clock)


def toolbox_of(app: FastAPI) -> MailToolbox:
    integration: ToolboxIntegration = app.state.toolbox
    toolbox = integration.mail_toolbox()
    assert toolbox is not None
    return toolbox


def scheduled(
    client: TestClient, prospect: uuid.UUID, step: str = "contact", at: datetime = FUTURE
) -> dict[str, Any]:
    validated(client, prospect, step)
    body = ok(
        client.post(
            f"{messages(prospect)}/{step}/schedule",
            json={"expected_revision": 1, "scheduled_at": at.isoformat()},
        )
    )
    assert body["remote_draft"]["status"] in ("already_present", "created")
    message: dict[str, Any] = body["message"]
    return message


def row(session: Session, message_id: str) -> ContactMessage:
    session.expire_all()
    message = session.get(ContactMessage, uuid.UUID(message_id))
    assert message is not None
    return message


def actions_of(session: Session, message_id: str) -> list[tuple[str, str | None]]:
    events = session.scalars(
        select(AuditLogEntry)
        .where(AuditLogEntry.entity_id == uuid.UUID(message_id))
        .order_by(AuditLogEntry.occurred_at, AuditLogEntry.id)
    )
    return [(event.action, event.context.get("reason")) for event in events]


def set_state(session: Session, prospect: uuid.UUID, state: ContactTrackingStatus) -> None:
    """Close the sequence behind the services' back (as if a change raced the dispatcher): the
    decision-29 cancellation of the services does not run, the dispatcher must see it itself."""
    session.execute(
        text(
            "INSERT INTO contact_tracking (prospect_id, status) VALUES (:p, :s) "
            "ON CONFLICT (prospect_id) DO UPDATE SET status = :s"
        ),
        {"p": prospect, "s": state.value},
    )


# --- configuration and classification -------------------------------------------------------------


def test_settings_and_their_bounds() -> None:
    settings = Settings()
    assert settings.contact_dispatch_interval_ms == 30_000
    assert settings.contact_dispatch_max_lateness_ms == 6 * 3_600_000
    assert settings.contact_dispatch_max_attempts == 5
    # Never less than twice the Toolbox timeout (a running send is never taken for a dead one).
    assert Settings(
        contact_dispatch_claim_ttl_ms=1000, toolbox_timeout_ms=20_000
    ).contact_dispatch_claim_ttl == timedelta(seconds=40)
    assert Settings(contact_dispatch_interval_ms=0).contact_dispatch_interval_ms == 0
    with pytest.raises(ValidationError):
        Settings(contact_dispatch_interval_ms=100)
    with pytest.raises(ValidationError):
        Settings(contact_dispatch_max_attempts=0)
    allowlisted = DispatchConfig.from_settings(Settings(infomaniak_send_allowlist="@x.example"))
    assert allowlisted.allowlist == ("@x.example",)


def test_backoff_and_error_classes() -> None:
    base = timedelta(minutes=1)
    assert [backoff(n, base).total_seconds() for n in (0, 1, 2, 3)] == [0, 60, 120, 240]
    assert backoff(30, base) == timedelta(hours=1)
    unknown = toolbox_error("toolbox_timeout", "t", outcome_unknown=True)
    assert classify_send_error(unknown).kind == "uncertain"
    assert classify_send_error(toolbox_error("toolbox_unavailable", "u")).code == (
        "send_unavailable"
    )
    assert classify_send_error(toolbox_error("toolbox_outbound_blocked", "o")).kind == "terminal"
    assert classify_send_error(toolbox_error("toolbox_invalid_response", "r")).kind == "uncertain"
    assert classify_send_error(RuntimeError("boom")).code == "dispatch_internal_error"


# --- due, sent, never twice -----------------------------------------------------------------------


def test_a_due_message_leaves_once_and_the_prospect_state_never_moves(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session, ContactTrackingStatus.NEUTRAL)
    message = scheduled(connected, prospect)
    clock = Clock(FUTURE - timedelta(seconds=1))
    pass_ = dispatcher(toolbox_app, clock)
    toolbox = toolbox_of(toolbox_app)

    assert pass_.run_pass(toolbox).sent == 0  # not due yet
    assert fake.sent == []

    clock.at = DUE
    report = pass_.run_pass(toolbox)
    assert report.sent == 1
    assert len(fake.sent) == 1
    sent = row(db_session, message["id"])
    assert (sent.status, sent.sent_at, sent.remote_message_id) == (M.SENT, DUE, None)
    assert sent.dispatch_attempts == 1 and sent.last_error_code is None
    # No resend, whatever the number of passes.
    assert pass_.run_pass(toolbox).sent == 0
    assert len(fake.sent) == 1
    # Decision 10: sending changes no state; the cadence stays a suggestion.
    tracking = db_session.scalar(
        select(ContactTracking).where(ContactTracking.prospect_id == prospect)
    )
    assert tracking is not None and tracking.status is ContactTrackingStatus.NEUTRAL
    assert actions_of(db_session, message["id"])[-2:] == [
        ("contact_message.dispatch_claimed", None),
        ("contact_message.sent", "confirmed"),
    ]
    event = db_session.scalars(
        select(AuditLogEntry).where(AuditLogEntry.action == "contact_message.sent")
    ).one()
    assert (event.actor_type, event.actor_id, event.context["source"]) == (
        "system",
        "contact-dispatcher",
        "dispatcher",
    )
    # The read model says it; the API refuses any change of a sent message.
    body = ok(connected.get(messages(prospect)))
    assert body["steps"][0]["message"]["status"] == "sent"
    refused(
        connected.put(
            f"{messages(prospect)}/contact", json={"expected_revision": 1, "subject": "x"}
        ),
        409,
        "message_sent_immutable",
    )
    history = ok(connected.get(f"/api/prospects/{prospect}/history"))
    assert "Message envoyé" in [entry["title"] for entry in history["items"]]


def test_a_draft_or_a_validated_message_never_leaves(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    validated(connected, prospect)
    ok(connected.put(f"{messages(prospect)}/r1", json={"subject": "S", "body_text": "B"}), 201)
    report = dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))
    assert report == DispatchReport()
    assert fake.sent == []


def test_too_late_it_goes_back_to_validated_without_leaving(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    late = FUTURE + timedelta(hours=6, seconds=1)
    report = dispatcher(toolbox_app, Clock(late)).run_pass(toolbox_of(toolbox_app))
    assert (report.overdue, report.sent) == (1, 0)
    assert fake.sent == []
    back = row(db_session, message["id"])
    assert (back.status, back.scheduled_at, back.last_error_code) == (
        M.VALIDATED,
        None,
        "dispatch_overdue",
    )
    assert back.validated_revision == back.revision and back.remote_draft_id is not None
    # Scheduling it again clears the diagnostic.
    again = ok(
        connected.post(
            f"{messages(prospect)}/contact/schedule",
            json={"expected_revision": 1, "scheduled_at": FUTURE.isoformat()},
        )
    )
    assert again["message"]["last_error_code"] is None


# --- step order (decision C-24) -------------------------------------------------------------------


def test_steps_leave_in_order(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    contact = scheduled(connected, prospect, "contact")
    r1 = scheduled(connected, prospect, "r1")  # same moment: Contact first
    report = dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))
    assert report.sent == 2
    assert fake.sent == [
        contact_draft := row(db_session, contact["id"]).remote_draft_id,
        row(db_session, r1["id"]).remote_draft_id,
    ]
    assert contact_draft is not None


def test_a_follow_up_waits_for_or_refuses_an_unsent_previous_step(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    pass_ = dispatcher(toolbox_app, Clock(DUE))
    toolbox = toolbox_of(toolbox_app)
    # Contact only validated: R1 goes back to Validé with the reason.
    first = prospect_id(db_session)
    validated(connected, first, "contact")
    r1 = scheduled(connected, first, "r1")
    assert pass_.run_pass(toolbox).failed == 1
    assert row(db_session, r1["id"]).last_error_code == "send_previous_step_pending"
    # Contact scheduled later than R1: same.
    second = prospect_id(db_session)
    scheduled(connected, second, "contact", FUTURE + timedelta(days=1))
    r1_later = scheduled(connected, second, "r1")
    pass_.run_pass(toolbox)
    assert row(db_session, r1_later["id"]).status is M.VALIDATED
    # No Contact message at all (a first contact made outside VIPER): R1 leaves.
    third = prospect_id(db_session, ContactTrackingStatus.CONTACTED)
    r1_alone = scheduled(connected, third, "r1")
    pass_.run_pass(toolbox)
    assert row(db_session, r1_alone["id"]).status is M.SENT
    assert len(fake.sent) == 1


def test_a_follow_up_waits_while_the_previous_send_is_unconfirmed(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    contact = scheduled(connected, prospect, "contact")
    r1 = scheduled(connected, prospect, "r1")
    fake.mode.lose_answer_of = "infomaniak.mail.send_draft"
    report = dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))
    assert (report.uncertain, report.deferred, report.sent) == (1, 1, 0)
    assert row(db_session, contact["id"]).last_error_code == "send_outcome_unknown"
    assert row(db_session, r1["id"]).status is M.SCHEDULED
    assert len(fake.sent) == 1


# --- the sequence closed, the opposition, the allowlist -------------------------------------------


@pytest.mark.parametrize(
    ("close", "reason"),
    [
        (ContactTrackingStatus.RESPONSE_RECEIVED, "prospect_state:response_received"),
        (None, "do_not_contact"),
    ],
)
def test_a_closed_sequence_cancels_instead_of_sending(
    connected: TestClient,
    toolbox_app: FastAPI,
    fake: FakeToolbox,
    db_session: Session,
    close: ContactTrackingStatus | None,
    reason: str,
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    if close is None:
        db_session.execute(
            text(
                "UPDATE prospects SET contactability_status = 'do_not_contact', "
                "do_not_contact_at = now() WHERE id = :p"
            ),
            {"p": prospect},
        )
    else:
        set_state(db_session, prospect, close)
    report = dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))
    assert (report.cancelled, report.sent) == (1, 0)
    assert fake.sent == []
    cancelled = row(db_session, message["id"])
    assert (cancelled.status, cancelled.cancel_reason) == (M.CANCELLED, reason)
    assert cancelled.remote_draft_id is None  # queued for deletion


def test_the_allowlist_refuses_other_recipients(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)  # jean.test@exemple.example
    message = scheduled(connected, prospect)
    pass_ = dispatcher(toolbox_app, Clock(DUE), allowlist=("@autre.example",))
    assert pass_.run_pass(toolbox_of(toolbox_app)).failed == 1
    assert fake.sent == []
    assert row(db_session, message["id"]).last_error_code == "send_recipient_not_allowed"

    other = prospect_id(db_session)
    allowed = scheduled(connected, other)
    pass_ = dispatcher(toolbox_app, Clock(DUE), allowlist=("jean.test@exemple.example",))
    assert pass_.run_pass(toolbox_of(toolbox_app)).sent == 1
    assert row(db_session, allowed["id"]).status is M.SENT


def test_a_state_closed_during_the_send_cancels_after_a_definitive_failure(
    connected: TestClient, toolbox_app: FastAPI, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    factory: sessionmaker[Session] = toolbox_app.state.session_factory

    class ClosingToolbox:
        def send_draft(self, draft_id: str) -> SendResult:
            with factory.begin() as session:
                set_state(session, prospect, ContactTrackingStatus.APPOINTMENT_OBTAINED)
            raise toolbox_error("toolbox_rejected", "refused")

    report = dispatcher(toolbox_app, Clock(DUE)).run_pass(ClosingToolbox())  # type: ignore[arg-type]
    assert (report.failed, report.cancelled) == (1, 1)
    cancelled = row(db_session, message["id"])
    assert (cancelled.status, cancelled.cancel_reason) == (
        M.CANCELLED,
        "prospect_state:appointment_obtained",
    )


# --- failures, attempts, backoff ------------------------------------------------------------------


def test_transient_failures_retry_with_backoff_then_give_up(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    clock = Clock(DUE)
    pass_ = dispatcher(toolbox_app, clock, max_attempts=2)
    toolbox = toolbox_of(toolbox_app)
    fake.mode.http_status = 503  # refused at `initialize`: certainly not sent

    assert pass_.run_pass(toolbox).retrying == 1
    first = row(db_session, message["id"])
    assert (first.status, first.dispatch_claim_id, first.dispatch_attempts) == (
        M.SCHEDULED,
        None,
        1,
    )
    assert first.last_error_code == "send_unavailable"
    assert pass_.run_pass(toolbox).deferred == 1  # within the backoff

    clock.at = DUE + timedelta(minutes=2)
    assert pass_.run_pass(toolbox).failed == 1
    spent = row(db_session, message["id"])
    assert (spent.status, spent.dispatch_attempts, spent.last_error_code) == (
        M.VALIDATED,
        2,
        "send_unavailable",
    )
    assert fake.sent == []


def test_a_gone_draft_is_a_definitive_failure(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    fake.drafts.clear()  # deleted in the webmail
    assert dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app)).failed == 1
    gone = row(db_session, message["id"])
    assert (gone.status, gone.last_error_code, gone.remote_draft_id) == (
        M.VALIDATED,
        "send_draft_not_found",
        None,
    )


def test_a_missing_remote_draft_is_created_before_the_send(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    fake.mode.http_status = 503
    validated(connected, prospect)
    ok(
        connected.post(
            f"{messages(prospect)}/contact/schedule",
            json={"expected_revision": 1, "scheduled_at": FUTURE.isoformat()},
        )
    )
    fake.mode.http_status = None
    assert fake.drafts == {}
    report = dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app))
    assert report.sent == 1
    assert len(fake.sent) == 1


def test_a_missing_draft_whose_creation_answer_was_lost_is_recovered_not_duplicated(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    fake.mode.lose_answer_of = "infomaniak.mail.create_draft"
    validated(connected, prospect)
    message = ok(
        connected.post(
            f"{messages(prospect)}/contact/schedule",
            json={"expected_revision": 1, "scheduled_at": FUTURE.isoformat()},
        )
    )["message"]
    assert message["last_error_code"] == "toolbox_outcome_unknown"
    fake.mode.lose_answer_of = None
    held = len(fake.drafts)
    assert dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app)).sent == 1
    assert len(fake.drafts) == held - 1  # the lost draft was found and sent, no second one


def test_a_draft_that_cannot_be_created_ends_back_in_validated(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    fake.mode.tool_error_text = "Paramètres invalides : TOOL_INPUT_INVALID"
    message = ok(
        connected.put(f"{messages(prospect)}/contact", json={"subject": "S", "body_text": "B"}), 201
    )["message"]
    ok(connected.post(f"{messages(prospect)}/contact/validate", json={"expected_revision": 1}))
    ok(
        connected.post(
            f"{messages(prospect)}/contact/schedule",
            json={"expected_revision": 1, "scheduled_at": FUTURE.isoformat()},
        )
    )
    assert dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app)).failed == 1
    back = row(db_session, message["id"])
    assert (back.status, back.last_error_code) == (M.VALIDATED, "send_draft_not_created")


def test_an_edit_after_scheduling_never_lets_the_old_revision_leave(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    old_draft = row(db_session, message["id"]).remote_draft_id
    edited = ok(
        connected.put(
            f"{messages(prospect)}/contact", json={"expected_revision": 1, "subject": "Nouveau"}
        )
    )
    assert edited["message"]["status"] == "draft" and edited["unvalidated"] is True
    assert dispatcher(toolbox_app, Clock(DUE)).run_pass(toolbox_of(toolbox_app)).sent == 0
    assert fake.sent == [] and old_draft not in fake.sent


# --- unknown outcomes, stale claims, reconciliation -----------------------------------------------


def test_an_unknown_outcome_keeps_the_claim_and_is_never_resent(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    clock = Clock(DUE)
    pass_ = dispatcher(toolbox_app, clock)
    toolbox = toolbox_of(toolbox_app)
    fake.mode.lose_answer_of = "infomaniak.mail.send_draft"
    assert pass_.run_pass(toolbox).uncertain == 1
    fake.mode.lose_answer_of = None
    held = row(db_session, message["id"])
    assert held.status is M.SCHEDULED and held.dispatch_claim_id is not None
    assert held.last_error_code == "send_outcome_unknown"
    # The editor's actions are locked, the next passes do not resend.
    refused(
        connected.post(f"{messages(prospect)}/contact/unschedule", json={"expected_revision": 1}),
        409,
        "dispatch_in_progress",
    )
    clock.at = DUE + timedelta(minutes=5)
    assert pass_.run_pass(toolbox) == DispatchReport()
    assert len(fake.sent) == 1
    # After the TTL: the draft left the mailbox and the listing is complete → sent (deduced).
    clock.at = DUE + timedelta(minutes=11)
    assert pass_.run_pass(toolbox).reconciled_sent == 1
    deduced = row(db_session, message["id"])
    assert (deduced.status, deduced.last_error_code) == (M.SENT, "send_reconciled_draft_absent")
    assert len(fake.sent) == 1


def test_a_stale_claim_with_its_draft_still_there_is_retried(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    clock = Clock(DUE)
    # A process claimed it, then died before `send_draft`.
    crashed = dispatcher(toolbox_app, clock)
    assert crashed._claim(uuid.UUID(message["id"]), DispatchReport()) is not None

    clock.at = DUE + timedelta(minutes=11)
    pass_ = dispatcher(toolbox_app, clock)
    report = pass_.run_pass(toolbox_of(toolbox_app))
    assert (report.reconciled_retry, report.sent) == (1, 0)
    released = row(db_session, message["id"])
    assert (released.dispatch_claim_id, released.last_error_code) == (None, "send_not_confirmed")
    clock.at = DUE + timedelta(minutes=13)  # after the backoff
    assert pass_.run_pass(toolbox_of(toolbox_app)).sent == 1
    assert len(fake.sent) == 1


def test_a_truncated_listing_keeps_the_claim_and_a_person_settles_it(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    clock = Clock(DUE)
    assert dispatcher(toolbox_app, clock)._claim(uuid.UUID(message["id"]), DispatchReport())
    # The mailbox holds more than one page of drafts: absence proves nothing.
    toolbox = toolbox_of(toolbox_app)
    for n in range(100):
        toolbox.create_draft(DraftInput(to=["autre@exemple.example"], subject=f"x{n}", text="t"))
    fake.drafts.pop(row(db_session, message["id"]).remote_draft_id or "")
    clock.at = DUE + timedelta(minutes=11)
    report = dispatcher(toolbox_app, clock).run_pass(toolbox)
    assert (report.uncertain, report.reconciled_sent) == (1, 0)
    stuck = row(db_session, message["id"])
    assert stuck.dispatch_claim_id is not None
    assert stuck.last_error_code == "send_reconcile_inconclusive"

    # « Marquer envoyé »: a person found it in the sent items.
    sent = ok(
        connected.post(f"{messages(prospect)}/contact/mark-sent", json={"expected_revision": 1})
    )
    assert (sent["message"]["status"], sent["message"]["last_error_code"]) == (
        "sent",
        "send_marked_by_person",
    )
    assert actions_of(db_session, message["id"])[-1] == ("contact_message.sent", "person")


def test_a_person_puts_an_unconfirmed_send_back_to_validated(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    path = f"{messages(prospect)}/contact"
    # Not claimed: nothing to settle.
    refused(
        connected.post(f"{path}/release", json={"expected_revision": 1}),
        409,
        "dispatch_not_unconfirmed",
    )
    clock = Clock(DUE)
    claim = dispatcher(toolbox_app, clock)._claim(uuid.UUID(message["id"]), DispatchReport())
    assert claim is not None
    # Claimed a moment ago, the send may be running: refused.
    refused(
        connected.post(f"{path}/mark-sent", json={"expected_revision": 1}),
        409,
        "dispatch_not_unconfirmed",
    )
    refused(
        connected.post(f"{path}/release", json={"expected_revision": 2}), 409, "revision_conflict"
    )
    # The send call ended without an answer: a person may settle it at once.
    db_session.execute(
        text(
            "UPDATE contact_messages SET last_error_code = 'send_outcome_unknown', "
            "last_error_at = now() WHERE id = :i"
        ),
        {"i": uuid.UUID(message["id"])},
    )
    released = ok(connected.post(f"{path}/release", json={"expected_revision": 1}))["message"]
    assert (released["status"], released["scheduled_at"], released["dispatch_claimed_at"]) == (
        "validated",
        None,
        None,
    )
    assert released["last_error_code"] == "send_released_by_person"
    assert released["has_remote_draft"] is True
    assert actions_of(db_session, message["id"])[-1] == (
        "contact_message.dispatch_released",
        "send_released_by_person",
    )


# --- two passes, two processes --------------------------------------------------------------------


def test_two_passes_one_after_the_other_send_once(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    scheduled(connected, prospect)
    clock = Clock(DUE)
    first, second = dispatcher(toolbox_app, clock), dispatcher(toolbox_app, clock)
    toolbox = toolbox_of(toolbox_app)
    assert first.run_pass(toolbox).sent + second.run_pass(toolbox).sent == 1
    assert len(fake.sent) == 1


class BlockingToolbox:
    """`send_draft` waits until released, counting the calls (thread-safe)."""

    def __init__(self) -> None:
        self.entered = threading.Event()
        self.release = threading.Event()
        self.calls: list[str] = []
        self._lock = threading.Lock()

    def send_draft(self, draft_id: str) -> SendResult:
        with self._lock:
            self.calls.append(draft_id)
        self.entered.set()
        assert self.release.wait(10)
        return SendResult(draft_id=draft_id, transport="api", cancel_resource=None)

    def create_draft(self, draft: DraftInput) -> str:
        raise AssertionError("not used")

    def delete_draft(self, draft_id: str) -> bool:
        raise AssertionError("not used")

    def list_drafts(self, limit: int = 100) -> list[DraftSummary]:
        return []


@pytest.fixture
def committed(engine: Engine) -> Iterator[tuple[sessionmaker[Session], uuid.UUID]]:
    """A scheduled, due message committed for real (two database sessions must see it), removed
    afterwards with its audit events (the append-only trigger is bypassed for this cleanup only)."""
    factory = create_session_factory(engine)
    draft_id = f"draft-{uuid.uuid4()}"
    with audit.attributed_unit_of_work(factory, FIXTURE_ACTOR) as session:
        company = add_company(session)
        prospect = add_prospect(session, company)
        add_email(session, prospect, "deux.passes@exemple.example", is_primary=True)
        message = ContactMessage(
            prospect_id=prospect.id,
            step=ContactMessageStep.CONTACT,
            status=M.SCHEDULED,
            from_email="prospection@exemple.example",
            to_recipients=["deux.passes@exemple.example"],
            subject="Objet",
            body_text="Corps",
            validated_revision=1,
            validated_at=DUE,
            validated_by_actor_id="test-user",
            validated_by_display="Opératrice Test",
            scheduled_at=FUTURE,
            remote_provider="circoe_toolbox",
            remote_draft_id=draft_id,
        )
        session.add(message)
        session.flush()
        ids = (company.id, prospect.id, message.id)
    try:
        yield factory, ids[2]
    finally:
        keys = {"c": ids[0], "p": ids[1], "m": ids[2], "d": draft_id}
        with engine.begin() as connection:
            # Only the audit rows need the append-only trigger off; the rest cascades normally.
            connection.execute(text("SET LOCAL session_replication_role = replica"))
            connection.execute(
                text(
                    "DELETE FROM audit_log WHERE subject_id IN (:c, :p) "
                    "OR entity_id IN (:c, :p, :m)"
                ),
                keys,
            )
            connection.execute(text("SET LOCAL session_replication_role = origin"))
            connection.execute(text("DELETE FROM prospects WHERE id = :p"), keys)
            connection.execute(text("DELETE FROM companies WHERE id = :c"), keys)
            connection.execute(
                text(
                    "DELETE FROM contact_message_remote_draft_cleanups WHERE remote_draft_id = :d"
                ),
                keys,
            )


def test_two_processes_at_once_send_once(
    engine: Engine, committed: tuple[sessionmaker[Session], uuid.UUID]
) -> None:
    factory, message_id = committed
    toolbox = BlockingToolbox()
    clock = Clock(DUE)
    reports: list[DispatchReport] = []

    # Another process holds the row (in the middle of its claim): this pass skips it at once.
    with engine.connect() as other:
        other.execute(
            text("SELECT id FROM contact_messages WHERE id = :m FOR UPDATE"), {"m": message_id}
        )
        skipped = Dispatcher(factory, config(), now=clock).run_pass(toolbox)
        other.rollback()
    assert skipped.sent == 0 and toolbox.calls == []

    def run(dispatcher_: Dispatcher) -> None:
        reports.append(dispatcher_.run_pass(toolbox))

    first = threading.Thread(target=run, args=(Dispatcher(factory, config(), now=clock),))
    first.start()
    assert toolbox.entered.wait(10)  # the first process holds the claim and is sending
    second = threading.Thread(target=run, args=(Dispatcher(factory, config(), now=clock),))
    second.start()
    second.join(10)
    toolbox.release.set()
    first.join(10)

    assert len(toolbox.calls) == 1
    assert sorted(report.sent for report in reports) == [0, 1]
    with factory() as session:
        message = session.get(ContactMessage, message_id)
        assert message is not None and message.status is M.SENT


# --- operators: CLI, worker, settings status, restore safeguard -----------------------------------


def test_the_cli_pass_the_hold_and_the_worker(
    engine: Engine,
    connected: TestClient,
    toolbox_app: FastAPI,
    fake: FakeToolbox,
    db_session: Session,
    capsys: pytest.CaptureFixture[str],
) -> None:
    integration: ToolboxIntegration = toolbox_app.state.toolbox
    factory: sessionmaker[Session] = toolbox_app.state.session_factory
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)

    assert cli.main(["contact-dispatch", "--once"], factory, integration) == 0
    assert "sent=0" in capsys.readouterr().out  # not due in real time

    assert cli.main(["contact-dispatch", "--hold-scheduled"], factory, integration) == 0
    assert "back to Validé: 1" in capsys.readouterr().out
    held = row(db_session, message["id"])
    assert (held.status, held.last_error_code) == (M.VALIDATED, "dispatch_held")

    worker = ContactDispatcher(integration, factory, config(interval=timedelta(hours=1)))
    assert worker.run_once() is not None
    assert worker.status().last_outcome == "ok"
    assert worker.status().active is False  # not started
    # The thread gets its own sessions: the per-test connection must not be shared across threads.
    worker = ContactDispatcher(
        integration, create_session_factory(engine), config(interval=timedelta(hours=1))
    )
    worker.start()
    assert worker.status().active is True
    body = ok(connected.get("/api/settings/toolbox"))
    assert body["dispatch"]["running"] is False  # this app has no worker of its own
    toolbox_app.state.contact_dispatcher = worker
    try:
        body = ok(connected.get("/api/settings/toolbox"))
        assert body["dispatch"]["active"] is True and body["dispatch"]["scheduled"] == 0
        defaults = ok(connected.get(messages(prospect)))["defaults"]
        assert defaults["automatic_sending_active"] is True
        assert defaults["dispatch_max_lateness_minutes"] == 360
    finally:
        toolbox_app.state.contact_dispatcher = None
        worker.stop(timeout=10)
    assert worker.status().running is False

    ok(connected.post("/api/settings/toolbox/forget"))
    assert worker.run_once() is None
    assert cli.main(["contact-dispatch", "--once"], factory, integration) == 1
    assert "not connected" in capsys.readouterr().err


def test_the_hold_leaves_claimed_messages(
    db_session: Session, toolbox_app: FastAPI, connected: TestClient
) -> None:
    prospect = prospect_id(db_session)
    message = scheduled(connected, prospect)
    assert dispatcher(toolbox_app, Clock(DUE))._claim(uuid.UUID(message["id"]), DispatchReport())
    with audit.bound(db_session, DISPATCH_ACTOR):
        hold = hold_scheduled(db_session, DISPATCH_ACTOR)
    assert (hold.held, hold.claimed) == (0, 1)


def test_without_a_worker_the_editor_is_told_nothing_leaves(
    client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    defaults = ok(client.get(messages(prospect)))["defaults"]
    assert defaults["automatic_sending_active"] is False
    assert defaults["dispatch_claim_ttl_seconds"] == 600
