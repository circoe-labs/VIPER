"""CIRCOE Toolbox in the Contact workflow (S6): the connection API, the Infomaniak draft created at
validation, the cleanup queue fed by edits and cancellations, the worker pass and the CLI — all
against the local fake (`tests/fake_toolbox.py`), never a real Toolbox (Contact port P6)."""

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select, text
from sqlalchemy.orm import Session, sessionmaker

from app import cli
from app.core.config import Settings, allowlist_permits
from app.models import AuditLogEntry, ContactMessage, ContactMessageRemoteDraftCleanup, Prospect
from app.services import audit, contact_messages, contact_remote_drafts
from app.services.contact_messages import GeneratedContent
from app.services.contact_remote_drafts import PROVIDER, backoff, process_cleanups
from app.services.toolbox.integration import ToolboxIntegration
from app.services.toolbox.mcp_client import DraftInput
from app.services.toolbox.token_store import MemoryTokenStore
from app.services.toolbox.worker import CleanupWorker
from tests.builders import OPERATOR
from tests.fake_toolbox import MCP_URL, FakeToolbox
from tests.test_contact_messages_api import FUTURE, SENDER, messages, ok, prospect_id, refused
from tests.test_prospects_api import PROSPECTS, load

REDIRECT = "http://localhost:5173/settings/connections"
STATUS = "/api/settings/toolbox"


def toolbox_settings(database_url: str, tmp_path: Path, **overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "database_url": database_url,
        "default_outbound_email": SENDER,
        "openai_api_key": None,
        "toolbox_mail_enabled": True,
        "toolbox_mcp_url": MCP_URL,
        "toolbox_oauth_redirect_uri": REDIRECT,
        "toolbox_token_store_path": tmp_path / "toolbox-oauth.json",
        "runtime_settings_path": tmp_path / "runtime-settings.json",
        "toolbox_cleanup_interval_ms": 0,
        # No background thread on the per-test connection: dispatcher tests run passes by hand.
        "contact_dispatch_interval_ms": 0,
    }
    return Settings(**(values | overrides))


def connect(client: TestClient, fake: FakeToolbox) -> dict[str, Any]:
    url = ok(client.post(f"{STATUS}/connect"))["authorization_url"]
    return ok(client.post(f"{STATUS}/callback", json=fake.authorize(url)))


def validated(client: TestClient, prospect: uuid.UUID, step: str = "contact") -> dict[str, Any]:
    path = f"{messages(prospect)}/{step}"
    ok(client.put(path, json={"subject": "Objet", "body_text": "Corps"}), 201)
    return ok(client.post(f"{path}/validate", json={"expected_revision": 1}))


def queue(session: Session) -> list[ContactMessageRemoteDraftCleanup]:
    session.expire_all()
    return list(
        session.scalars(
            select(ContactMessageRemoteDraftCleanup).order_by(
                ContactMessageRemoteDraftCleanup.created_at
            )
        )
    )


def remote_id(session: Session, message_id: str) -> str | None:
    session.expire_all()
    message = session.get(ContactMessage, uuid.UUID(message_id))
    assert message is not None
    return message.remote_draft_id


# --- configuration ------------------------------------------------------------------------------


def test_settings_validation(tmp_path: Path) -> None:
    settings = Settings(toolbox_mail_enabled=True, toolbox_mcp_url=" ")
    assert settings.toolbox_missing_settings == [
        "VIPER_TOOLBOX_MCP_URL",
        "VIPER_TOOLBOX_OAUTH_REDIRECT_URI",
    ]
    assert Settings(toolbox_mcp_url="http://127.0.0.1:9/mcp").toolbox_mcp_url
    for bad in ("http://toolbox.example.test/mcp", "ftp://x.test", "javascript:alert(1)"):
        with pytest.raises(ValidationError):
            Settings(toolbox_mcp_url=bad)
    with pytest.raises(ValidationError, match="outside the repository"):
        Settings(toolbox_token_store_path=Path(__file__))
    assert Settings(toolbox_token_store_path=tmp_path / "t.json").toolbox_token_store.parent == (
        tmp_path.resolve()
    )
    with pytest.raises(ValidationError):
        Settings(infomaniak_send_allowlist="pas-une-adresse")
    allowlist = Settings(infomaniak_send_allowlist="A@x.example, @y.example").send_allowlist
    assert allowlist == ("a@x.example", "@y.example")
    assert allowlist_permits(allowlist, ["a@x.example", "b@y.example"])
    assert not allowlist_permits(allowlist, ["b@x.example"])
    assert allowlist_permits(None, ["anyone@z.example"])
    assert Settings().toolbox_mail_enabled is False


# --- the connection API -------------------------------------------------------------------------


def test_status_in_each_state(
    app: FastAPI, client: TestClient, fake: FakeToolbox, tmp_path: Path, db_session: Session
) -> None:
    body = ok(client.get(STATUS))
    assert (body["state"], body["enabled"], body["configured"]) == ("disabled", False, False)
    refused(client.post(f"{STATUS}/connect"), 503, "toolbox_not_configured")

    settings = toolbox_settings(app.state.settings.database_url, tmp_path, toolbox_mcp_url=None)
    app.state.toolbox = ToolboxIntegration(settings, store=MemoryTokenStore())
    body = ok(client.get(STATUS))
    assert (body["state"], body["missing"]) == ("not_configured", ["VIPER_TOOLBOX_MCP_URL"])

    settings = toolbox_settings(app.state.settings.database_url, tmp_path)
    app.state.settings = settings
    app.state.toolbox = ToolboxIntegration(
        settings, store=MemoryTokenStore(), transport=fake.transport
    )
    body = ok(client.get(STATUS))
    assert (body["state"], body["connected"], body["toolbox_origin"]) == (
        "disconnected",
        False,
        "https://toolbox.example.test",
    )

    body = connect(client, fake)
    assert (body["state"], body["connected"], body["connected_by"]) == (
        "connected",
        True,
        "Pilote Test",
    )
    assert body["expires_at"] is not None
    assert "token" not in str(body).replace("toolbox", "")

    fake.revoke_all()
    validated(client, prospect_id(db_session))
    body = ok(client.get(STATUS))
    assert body["state"] == "expired"
    assert body["last_error"]["code"] == "toolbox_auth_expired"

    # « Se déconnecter » (S8): the token is forgotten and the integration turned off.
    body = ok(client.post(f"{STATUS}/forget"))
    assert (body["state"], body["last_error"]) == ("disabled", None)


def test_a_failed_return_is_recorded_and_said(
    toolbox_app: FastAPI, client: TestClient, fake: FakeToolbox
) -> None:
    url = ok(client.post(f"{STATUS}/connect"))["authorization_url"]
    params = fake.authorize(url) | {"error": "access_denied"}

    refused(client.post(f"{STATUS}/callback", json=params), 403, "toolbox_access_denied")
    body = ok(client.get(STATUS))
    assert (body["state"], body["last_error"]["code"]) == ("disconnected", "toolbox_access_denied")
    refused(client.post(f"{STATUS}/callback", json=params), 400, "toolbox_state_invalid")


def test_connecting_and_forgetting_are_audited_without_secret(
    toolbox_app: FastAPI, client: TestClient, fake: FakeToolbox, db_session: Session
) -> None:
    connect(client, fake)
    ok(client.post(f"{STATUS}/forget"))

    events = db_session.scalars(
        select(AuditLogEntry)
        .where(AuditLogEntry.entity_type == "toolbox_connection")
        .order_by(AuditLogEntry.occurred_at)
    ).all()
    assert [event.action for event in events] == ["toolbox.connected", "toolbox.forgotten"]
    assert "at-" not in str(events[0].changes)


def test_the_connection_routes_need_a_session_and_the_csrf_token(
    toolbox_app: FastAPI, anonymous_client: TestClient
) -> None:
    assert anonymous_client.get(STATUS).status_code == 401
    assert anonymous_client.post(f"{STATUS}/connect").status_code == 401
    assert anonymous_client.post(f"{STATUS}/callback", json={}).status_code == 401


# --- the remote draft at validation -------------------------------------------------------------


def test_disabled_keeps_everything_local(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    app.state.settings = Settings(
        database_url=app.state.settings.database_url, default_outbound_email=SENDER
    )
    prospect = prospect_id(db_session)

    body = validated(client, prospect)

    assert body["remote_draft"] == {"status": "disabled", "code": None}
    assert body["message"]["has_remote_draft"] is False
    assert ok(client.get(messages(prospect)))["defaults"]["toolbox_connected"] is False


def test_not_connected_creates_nothing(
    toolbox_app: FastAPI, client: TestClient, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)

    body = validated(client, prospect)

    assert body["remote_draft"]["status"] == "not_connected"
    assert fake.calls == []


def test_validation_creates_the_draft_without_the_sender(
    connected: TestClient, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    path = f"{messages(prospect)}/contact"
    ok(
        connected.put(
            path, json={"subject": "Objet", "body_text": "Corps", "cc": ["c@ex.example"]}
        ),
        201,
    )

    body = ok(connected.post(f"{path}/validate", json={"expected_revision": 1}))

    assert body["remote_draft"] == {"status": "created", "code": None}
    message = body["message"]
    assert (message["status"], message["has_remote_draft"]) == ("validated", True)
    [(draft_id, draft)] = fake.drafts.items()
    assert remote_id(db_session, message["id"]) == draft_id
    assert (draft.to, draft.cc, draft.subject) == (
        ["jean.test@exemple.example"],
        ["c@ex.example"],
        "Objet",
    )
    assert ok(connected.get(messages(prospect)))["defaults"]["toolbox_connected"] is True
    actions = db_session.scalars(
        select(AuditLogEntry.action).where(AuditLogEntry.entity_type == "contact_message")
    ).all()
    assert "contact_message.remote_draft_created" in actions
    # Scheduling keeps the same draft.
    scheduled = ok(
        connected.post(
            f"{path}/schedule", json={"expected_revision": 1, "scheduled_at": FUTURE.isoformat()}
        )
    )
    assert scheduled["remote_draft"]["status"] == "already_present"
    assert len(fake.drafts) == 1


def test_a_failure_keeps_the_validation_and_can_be_retried(
    connected: TestClient, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    fake.mode.http_status = 503

    body = validated(connected, prospect)

    assert body["remote_draft"] == {"status": "failed", "code": "toolbox_unavailable"}
    message = body["message"]
    assert (message["status"], message["has_remote_draft"]) == ("validated", False)
    assert message["last_error_code"] == "toolbox_unavailable"

    fake.mode.http_status = None
    path = f"{messages(prospect)}/contact"
    body = ok(connected.post(f"{path}/remote-draft", json={"expected_revision": 1}))

    assert body["remote_draft"]["status"] == "created"
    assert (body["message"]["has_remote_draft"], body["message"]["last_error_code"]) == (True, None)
    refused(
        connected.post(f"{path}/remote-draft", json={"expected_revision": 9}),
        409,
        "revision_conflict",
    )


def test_an_outbound_refusal_is_said(
    connected: TestClient, fake: FakeToolbox, db_session: Session
) -> None:
    fake.allowlist = ["@circoe.example"]

    body = validated(connected, prospect_id(db_session))

    assert body["remote_draft"] == {"status": "failed", "code": "toolbox_outbound_blocked"}


def test_retry_refusals(
    toolbox_app: FastAPI, client: TestClient, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    path = f"{messages(prospect)}/contact"
    ok(client.put(path, json={"subject": "S", "body_text": "B"}), 201)
    refused(
        client.post(f"{path}/remote-draft", json={"expected_revision": 1}),
        409,
        "invalid_transition",
    )
    ok(client.post(f"{path}/validate", json={"expected_revision": 1}))
    refused(
        client.post(f"{path}/remote-draft", json={"expected_revision": 1}),
        409,
        "toolbox_not_connected",
    )


def test_an_edit_during_the_creation_queues_the_new_draft(
    connected: TestClient,
    toolbox_app: FastAPI,
    fake: FakeToolbox,
    db_session: Session,
) -> None:
    """The message changed while the Toolbox was creating its draft: the draft is not attached
    to the new revision, it is queued for deletion (`replaced`)."""
    prospect = prospect_id(db_session)
    path = f"{messages(prospect)}/contact"
    ok(connected.put(path, json={"subject": "S", "body_text": "B"}), 201)
    ok(connected.post(f"{path}/validate", json={"expected_revision": 1}))
    # Detach and simulate a creation for an outdated revision.
    message_id = ok(connected.get(path))["message"]["id"]
    ok(connected.put(path, json={"expected_revision": 1, "subject": "S2"}))
    integration: ToolboxIntegration = toolbox_app.state.toolbox
    toolbox = integration.mail_toolbox()
    assert toolbox is not None
    snapshot = contact_remote_drafts._Snapshot(
        id=uuid.UUID(message_id),
        revision=1,
        draft=DraftInput(to=["x@ex.example"], subject="S", text="B"),
    )
    draft_id = toolbox.create_draft(snapshot.draft)
    factory: sessionmaker[Session] = toolbox_app.state.session_factory
    with factory.begin() as session:
        assert contact_remote_drafts._current(session, snapshot) is None
    with factory.begin() as session:
        contact_remote_drafts.enqueue_cleanup(session, snapshot.id, PROVIDER, draft_id, "replaced")
    reasons = {entry.remote_draft_id: entry.reason for entry in queue(db_session)}
    assert reasons[draft_id] == "replaced"


# --- the cleanup queue ----------------------------------------------------------------------------


def test_edits_and_cancellations_queue_the_old_draft(
    connected: TestClient, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    first = validated(connected, prospect)["message"]
    first_draft = remote_id(db_session, first["id"])
    path = f"{messages(prospect)}/contact"

    edited = ok(connected.put(path, json={"expected_revision": 1, "subject": "Nouveau"}))

    assert (edited["unvalidated"], edited["message"]["has_remote_draft"]) == (True, False)
    assert [(e.remote_draft_id, e.reason) for e in queue(db_session)] == [(first_draft, "edited")]

    revalidated = ok(connected.post(f"{path}/validate", json={"expected_revision": 2}))
    second_draft = remote_id(db_session, revalidated["message"]["id"])
    assert second_draft not in (None, first_draft)
    ok(connected.post(f"{path}/cancel", json={"expected_revision": 2}))
    r1 = validated(connected, prospect, "r1")["message"]
    r1_draft = remote_id(db_session, r1["id"])
    view = load(connected, prospect)
    ok(
        connected.patch(
            f"{PROSPECTS}/{prospect}/tracking",
            json={"version": view["version"], "status": "appointment_obtained"},
        )
    )

    assert [(e.remote_draft_id, e.reason) for e in queue(db_session)] == [
        (first_draft, "edited"),
        (second_draft, "cancelled"),
        (r1_draft, "cancelled"),
    ]
    assert all(entry.message_id is not None for entry in queue(db_session))


def test_a_pass_deletes_the_queued_drafts_idempotently(
    connected: TestClient,
    toolbox_app: FastAPI,
    fake: FakeToolbox,
    db_session: Session,
) -> None:
    prospect = prospect_id(db_session)
    validated(connected, prospect)
    path = f"{messages(prospect)}/contact"
    ok(connected.post(f"{path}/cancel", json={"expected_revision": 1}))
    [entry] = queue(db_session)
    fake.drafts.pop(entry.remote_draft_id)  # someone deleted it in Infomaniak already
    other = prospect_id(db_session)
    validated(connected, other)
    ok(connected.post(f"{messages(other)}/contact/cancel", json={"expected_revision": 1}))

    integration: ToolboxIntegration = toolbox_app.state.toolbox
    toolbox = integration.mail_toolbox()
    assert toolbox is not None
    report = process_cleanups(toolbox_app.state.session_factory, toolbox)

    assert (report.processed, report.deleted, report.already_absent, report.failed) == (2, 1, 1, 0)
    assert {e.outcome for e in queue(db_session)} == {"deleted", "already_absent"}
    assert process_cleanups(toolbox_app.state.session_factory, toolbox).processed == 0


def test_failures_back_off_and_the_connection_blocks_the_batch(
    connected: TestClient,
    toolbox_app: FastAPI,
    fake: FakeToolbox,
    db_session: Session,
) -> None:
    prospect = prospect_id(db_session)
    validated(connected, prospect)
    ok(connected.post(f"{messages(prospect)}/contact/cancel", json={"expected_revision": 1}))
    integration: ToolboxIntegration = toolbox_app.state.toolbox
    toolbox = integration.mail_toolbox()
    assert toolbox is not None
    factory = toolbox_app.state.session_factory
    now = datetime.now(UTC)

    fake.mode.http_status = 502
    report = process_cleanups(factory, toolbox, now=now)
    [entry] = queue(db_session)
    assert (report.failed, entry.attempts, entry.last_error_code) == (1, 1, "toolbox_unavailable")
    assert entry.next_attempt_at == now + timedelta(seconds=30)
    # Not due yet.
    assert process_cleanups(factory, toolbox, now=now + timedelta(seconds=10)).processed == 0

    fake.mode.http_status = None
    fake.revoke_all()
    report = process_cleanups(factory, toolbox, now=now + timedelta(minutes=1))
    assert (report.blocked, queue(db_session)[0].attempts) == ("toolbox_auth_expired", 1)
    assert integration.mail_toolbox() is None


def test_an_id_attached_again_is_never_deleted(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    message = validated(connected, prospect)["message"]
    draft_id = remote_id(db_session, message["id"])
    assert draft_id is not None
    factory: sessionmaker[Session] = toolbox_app.state.session_factory
    with factory.begin() as session:
        contact_remote_drafts.enqueue_cleanup(session, None, PROVIDER, draft_id, "replaced")
    toolbox = toolbox_app.state.toolbox.mail_toolbox()

    report = process_cleanups(factory, toolbox)

    assert (report.skipped, queue(db_session)[0].last_error_code) == (1, "still_attached")
    assert draft_id in fake.drafts


def test_backoff() -> None:
    assert [backoff(n).total_seconds() for n in (0, 1, 2, 3)] == [0, 30, 60, 120]
    assert backoff(50) == timedelta(hours=6)


def test_the_worker_pass_and_the_cli(
    connected: TestClient,
    toolbox_app: FastAPI,
    fake: FakeToolbox,
    db_session: Session,
    capsys: pytest.CaptureFixture[str],
) -> None:
    prospect = prospect_id(db_session)
    validated(connected, prospect)
    ok(connected.post(f"{messages(prospect)}/contact/cancel", json={"expected_revision": 1}))
    integration: ToolboxIntegration = toolbox_app.state.toolbox
    factory: sessionmaker[Session] = toolbox_app.state.session_factory

    assert cli.main(["toolbox-cleanup", "--once"], factory, integration) == 0
    assert "deleted 1" in capsys.readouterr().out

    worker = CleanupWorker(integration, factory, interval_seconds=3600)
    report = worker.run_once()
    assert report is not None and report.processed == 0
    ok(connected.post(f"{STATUS}/forget"))
    assert worker.run_once() is None
    assert cli.main(["toolbox-cleanup", "--once"], factory, integration) == 1
    assert "not connected" in capsys.readouterr().err


def test_the_worker_thread_starts_wakes_and_stops(
    toolbox_app: FastAPI, connected: TestClient
) -> None:
    integration: ToolboxIntegration = toolbox_app.state.toolbox
    worker = CleanupWorker(integration, toolbox_app.state.session_factory, interval_seconds=3600)
    worker.start()
    worker.wake()
    worker.stop(timeout=10)


def test_the_status_counts_the_queue(
    connected: TestClient, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    validated(connected, prospect)
    ok(connected.post(f"{messages(prospect)}/contact/cancel", json={"expected_revision": 1}))

    assert ok(connected.get(STATUS))["cleanups"] == {"pending": 1, "failing": 0}


# --- QA rework: deletion, auth recording, unknown outcome, other queueing paths ------------------


def queued_reasons(session: Session) -> dict[str, str]:
    return {entry.remote_draft_id: entry.reason for entry in queue(session)}


@pytest.mark.parametrize("path", ["editor", "reset", "explorer"])
def test_deleting_the_prospect_queues_its_drafts(
    connected: TestClient, db_session: Session, path: str
) -> None:
    prospect = prospect_id(db_session)
    message = validated(connected, prospect)["message"]
    draft_id = remote_id(db_session, message["id"])
    assert draft_id is not None

    if path == "editor":
        view = load(connected, prospect)
        response = connected.delete(f"{PROSPECTS}/{prospect}", params={"version": view["version"]})
        assert response.status_code == 204, response.text
    elif path == "reset":
        body = {"confirmation": "RESET_PROSPECTING_DATA"}
        ok(connected.post("/api/database/reset-prospecting", json=body))
    else:
        db_session.expire_all()
        row = db_session.get(Prospect, prospect)
        assert row is not None
        deletes = [{"key": {"id": str(row.id)}, "version": row.updated_at.isoformat()}]
        changes = {"updates": [], "inserts": [], "deletes": deletes}
        ok(connected.post("/api/explorer/tables/prospects/changes", json=changes))

    [entry] = queue(db_session)
    assert (entry.remote_draft_id, entry.reason, entry.message_id) == (draft_id, "deleted", None)


def test_a_sent_message_deleted_queues_nothing(db_session: Session) -> None:
    prospect = prospect_id(db_session)
    sequence = db_session.execute(
        text("SELECT id FROM contact_sequences WHERE prospect_id = :p"), {"p": prospect}
    ).scalar_one()
    db_session.execute(
        text(
            "INSERT INTO contact_messages (prospect_id, sequence_id, rank, status, from_email, "
            "subject, body_text, revision, validated_revision, validated_at, "
            "validated_by_actor_id, sent_at, sent_source, remote_provider, remote_draft_id) "
            "VALUES (:p, :s, 0, 'sent', 'a@ex.example', 's', 'b', 1, 1, now(), 'x', now(), "
            "'manual', 'circoe_toolbox', 'draft-sent')"
        ),
        {"p": prospect, "s": sequence},
    )
    db_session.execute(text("DELETE FROM prospects WHERE id = :p"), {"p": prospect})
    assert queue(db_session) == []


def test_an_ai_redraft_the_opposition_and_a_reopening_queue_or_keep_the_old_draft(
    connected: TestClient, toolbox_app: FastAPI, db_session: Session
) -> None:
    # AI redraft (S5 `save_generated`) of a validated message: its draft is queued as edited.
    prospect = prospect_id(db_session)
    first = validated(connected, prospect)["message"]
    first_draft = remote_id(db_session, first["id"])
    factory: sessionmaker[Session] = toolbox_app.state.session_factory
    with factory.begin() as session:
        audit.bind(session, OPERATOR)
        contact_messages.save_generated(
            session,
            OPERATOR,
            prospect,
            0,
            GeneratedContent("IA", "Corps IA", "fake-model", "v1"),
            1,
        )
    assert queued_reasons(db_session) == {first_draft: "edited"}

    # Cancel then reopen: the cancel queues the draft, the reopening queues nothing more.
    path = f"{messages(prospect)}/contact"
    second = ok(connected.post(f"{path}/validate", json={"expected_revision": 2}))["message"]
    second_draft = remote_id(db_session, second["id"])
    ok(connected.post(f"{path}/cancel", json={"expected_revision": 2}))
    ok(connected.post(f"{path}/reopen", json={"expected_revision": 2}))
    assert queued_reasons(db_session) == {first_draft: "edited", second_draft: "cancelled"}

    # The opposition cancels the validated R1 and queues its draft.
    r1_draft = remote_id(db_session, validated(connected, prospect, "r1")["message"]["id"])
    assert r1_draft is not None
    view = load(connected, prospect)
    ok(
        connected.put(
            f"{PROSPECTS}/{prospect}/contactability",
            json={"do_not_contact": True, "reason": "Demande", "version": view["version"]},
        )
    )
    assert queued_reasons(db_session)[r1_draft] == "cancelled"


def test_a_tool_level_auth_refusal_is_recorded_and_asks_to_reconnect(
    connected: TestClient, toolbox_app: FastAPI, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    fake.mode.tool_error_text = "Aucune connexion Infomaniak pour ce membre."

    body = validated(connected, prospect)

    assert body["remote_draft"] == {"status": "failed", "code": "toolbox_auth_expired"}
    status = ok(connected.get(STATUS))
    assert (status["state"], status["last_error"]["code"]) == ("expired", "toolbox_auth_expired")

    # The cleanup pass records it too (a draft queued before, then the refusal).
    fake.mode.tool_error_text = None
    connect(connected, fake)
    other = prospect_id(db_session)
    validated(connected, other)
    ok(connected.post(f"{messages(other)}/contact/cancel", json={"expected_revision": 1}))
    integration: ToolboxIntegration = toolbox_app.state.toolbox
    toolbox = integration.mail_toolbox()
    assert toolbox is not None
    fake.mode.tool_error_text = "Aucune connexion Infomaniak pour ce membre."
    report = process_cleanups(toolbox_app.state.session_factory, toolbox)
    assert report.blocked == "toolbox_auth_expired"
    assert ok(connected.get(STATUS))["state"] == "expired"
    [entry] = [e for e in queue(db_session) if e.reason == "cancelled"]
    assert (entry.attempts, entry.completed_at) == (0, None)


def test_an_unknown_creation_outcome_is_recovered_not_duplicated(
    connected: TestClient, fake: FakeToolbox, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    path = f"{messages(prospect)}/contact"
    ok(connected.put(path, json={"subject": "Objet", "body_text": "Corps"}), 201)
    # The Toolbox creates the draft, then the answer is lost (timeout after execution).
    fake.mode.lose_answer_of = "infomaniak.mail.create_draft"

    body = ok(connected.post(f"{path}/validate", json={"expected_revision": 1}))

    assert body["remote_draft"] == {"status": "failed", "code": "toolbox_outcome_unknown"}
    assert body["message"]["last_error_code"] == "toolbox_outcome_unknown"
    assert len(fake.drafts) == 1
    fake.mode.lose_answer_of = None

    retried = ok(connected.post(f"{path}/remote-draft", json={"expected_revision": 1}))

    assert retried["remote_draft"]["status"] == "recovered"
    assert retried["message"]["has_remote_draft"] is True
    assert len(fake.drafts) == 1  # no duplicate
    assert remote_id(db_session, retried["message"]["id"]) == next(iter(fake.drafts))


def test_unsafe_oauth_endpoints_are_refused(
    toolbox_app: FastAPI, client: TestClient, fake: FakeToolbox
) -> None:
    fake.token_endpoint = "http://evil.example.test/token"

    refused(client.post(f"{STATUS}/connect"), 422, "toolbox_rejected")
    assert ok(client.get(STATUS))["last_error"]["code"] == "toolbox_rejected"


def test_claimed_entries_are_left_to_their_pass(
    connected: TestClient, toolbox_app: FastAPI, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    validated(connected, prospect)
    ok(connected.post(f"{messages(prospect)}/contact/cancel", json={"expected_revision": 1}))
    factory: sessionmaker[Session] = toolbox_app.state.session_factory
    toolbox = toolbox_app.state.toolbox.mail_toolbox()
    seen: list[int] = []

    class Spy:
        """During the network delete the entry is claimed: another pass leaves it alone."""

        def delete_draft(self, draft_id: str) -> bool:
            seen.append(process_cleanups(factory, toolbox).processed)
            return bool(toolbox.delete_draft(draft_id))

    report = process_cleanups(factory, Spy())  # type: ignore[arg-type]

    assert (report.deleted, seen) == (1, [0])
    [entry] = queue(db_session)
    assert (entry.outcome, entry.attempts) == ("deleted", 1)
