"""Will a scheduled message really leave? (Contact port S9, Human report of 2026-10-02).

A message scheduled while the dispatcher was off (the S8 default) never left and nothing said so.
Now the sending is on by default once the Toolbox is connected — at startup and right after « Se
connecter à CIRCOE Toolbox » — and every screen reads `contact_dispatch_state`: the reason it is
inactive, how many scheduled messages wait and how many are already past their time. All against
the local fake Toolbox (P6)."""

import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.db.session import create_session_factory
from app.services.contact_dispatch_state import sending_reason
from app.services.integration_runtime import IntegrationRuntime
from app.services.toolbox.integration import ToolboxIntegration
from app.services.toolbox.token_store import MemoryTokenStore
from tests.fake_toolbox import FakeToolbox
from tests.test_contact_messages_api import FUTURE, SENDER, messages, ok, prospect_id
from tests.test_contact_remote_drafts import REDIRECT, toolbox_settings

DASHBOARD = "/api/contact/dashboard"
INTEGRATIONS = "/api/settings/integrations"
TOOLBOX = "/api/settings/toolbox"
DEFAULT_INTERVAL_MS: int = Settings.model_fields["contact_dispatch_interval_ms"].default


def schedule(client: TestClient, prospect: uuid.UUID, at: datetime = FUTURE) -> dict[str, Any]:
    path = f"{messages(prospect)}/contact"
    content = {"from_email": SENDER, "subject": "Objet", "body_text": "Corps"}
    ok(client.put(path, json=content), 201)
    ok(client.post(f"{path}/validate", json={"expected_revision": 1}))
    body = ok(
        client.post(
            f"{messages(prospect)}/contact/schedule",
            json={"expected_revision": 1, "scheduled_at": at.isoformat()},
        )
    )
    message: dict[str, Any] = body["message"]
    return message


def put(client: TestClient, **changes: Any) -> Any:
    version = ok(client.get(INTEGRATIONS))["version"]
    return ok(client.put(INTEGRATIONS, json={"version": version, **changes}))


def dispatch_of(client: TestClient) -> dict[str, Any]:
    body: dict[str, Any] = ok(client.get(DASHBOARD))["dispatch"]
    return body


# --- the default --------------------------------------------------------------------------------


def test_the_sending_is_on_by_default() -> None:
    settings = Settings()
    assert (settings.contact_dispatch_enabled, settings.contact_dispatch_interval_ms) == (
        True,
        30_000,
    )
    assert settings.contact_dispatch_on
    assert not Settings(contact_dispatch_enabled=False).contact_dispatch_on
    assert not Settings(contact_dispatch_interval_ms=0).contact_dispatch_on


def boot_state(
    app: FastAPI, engine: Engine, fake: FakeToolbox, tmp_path: Path, **overrides: Any
) -> SimpleNamespace:
    """The `app.state` of an API process starting with these settings and `app`'s token store."""
    store = app.state.toolbox.store
    settings = toolbox_settings(
        app.state.settings.database_url,
        tmp_path,
        contact_dispatch_interval_ms=DEFAULT_INTERVAL_MS,
        **overrides,
    )
    return SimpleNamespace(
        settings=settings,
        toolbox=ToolboxIntegration(settings, store=store, transport=fake.transport),
        toolbox_worker=None,
        contact_dispatcher=None,
        # The worker threads get their own sessions (never the per-test connection).
        session_factory=create_session_factory(engine),
    )


def test_at_startup_an_already_connected_toolbox_starts_the_sending_with_the_default(
    engine: Engine, toolbox_app: FastAPI, connected: TestClient, fake: FakeToolbox, tmp_path: Path
) -> None:
    state = boot_state(toolbox_app, engine, fake, tmp_path)
    runtime = IntegrationRuntime(state)
    runtime.start()
    try:
        assert state.contact_dispatcher is not None
        assert state.contact_dispatcher.interval_seconds == 30
        assert state.contact_dispatcher.status().active is True
        assert sending_reason(state) is None
    finally:
        runtime.stop()
    assert state.contact_dispatcher is None


def test_switched_off_nothing_starts_even_connected(
    engine: Engine, toolbox_app: FastAPI, connected: TestClient, fake: FakeToolbox, tmp_path: Path
) -> None:
    state = boot_state(toolbox_app, engine, fake, tmp_path, contact_dispatch_enabled=False)
    runtime = IntegrationRuntime(state)
    runtime.start()
    try:
        assert state.contact_dispatcher is None
        # The cleanup of obsolete drafts is not the sending: it still follows the connection.
        assert sending_reason(state) == "disabled"
    finally:
        runtime.stop()


def test_connecting_from_the_page_starts_the_sending_without_any_setting(
    engine: Engine,
    app: FastAPI,
    client: TestClient,
    fake: FakeToolbox,
    tmp_path: Path,
    db_session: Session,
) -> None:
    """The Human's path: nothing chosen in « Envoi programmé », then « Se connecter »."""
    store = MemoryTokenStore()
    app.state.integrations.toolbox_factory = lambda settings: ToolboxIntegration(
        settings, store=store, transport=fake.transport
    )
    app.state.integrations.worker_session_factory = create_session_factory(engine)
    prospect = prospect_id(db_session)
    schedule(client, prospect)
    assert dispatch_of(client) == {
        "active": False,
        "reason": "toolbox_disabled",
        "scheduled_count": 1,
        "overdue_count": 0,
    }
    try:
        started = ok(client.post(f"{TOOLBOX}/connect", json={"redirect_uri": REDIRECT}))
        callback = fake.authorize(started["authorization_url"])
        ok(client.post(f"{TOOLBOX}/callback", json=callback))
        assert app.state.contact_dispatcher is not None
        assert app.state.contact_dispatcher.interval_seconds == DEFAULT_INTERVAL_MS / 1000
        assert dispatch_of(client)["active"] is True
        defaults = ok(client.get(messages(prospect)))["defaults"]
        assert (defaults["automatic_sending_active"], defaults["dispatch_reason"]) == (True, None)
        settings = ok(client.get(INTEGRATIONS))
        assert settings["fields"]["contact_dispatch_enabled"] == {
            "value": True,
            "source": "default",
            "fallback": True,
            "updated_at": None,
            "updated_by": None,
        }
        # Switched off by the person: stopped, and every screen says why.
        put(client, contact_dispatch_enabled=False)
        assert app.state.contact_dispatcher is None
        assert dispatch_of(client)["reason"] == "disabled"
        assert ok(client.get(INTEGRATIONS))["dispatch"] == {
            "running": False,
            "active": False,
            "reason": "disabled",
            "scheduled_count": 1,
            "overdue_count": 0,
        }
        defaults = ok(client.get(messages(prospect)))["defaults"]
        assert (defaults["automatic_sending_active"], defaults["dispatch_reason"]) == (
            False,
            "disabled",
        )
    finally:
        app.state.integrations.stop()


# --- the reasons and the counts -----------------------------------------------------------------


@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"contact_dispatch_enabled": False}, "disabled"),
        ({"contact_dispatch_interval_ms": 0}, "disabled"),
        ({"toolbox_mail_enabled": False}, "toolbox_disabled"),
        ({"toolbox_oauth_redirect_uri": None}, "toolbox_not_configured"),
        ({}, "toolbox_disconnected"),
    ],
)
def test_each_reason_without_a_connection(
    tmp_path: Path, fake: FakeToolbox, overrides: dict[str, Any], reason: str
) -> None:
    values: dict[str, Any] = {"contact_dispatch_interval_ms": DEFAULT_INTERVAL_MS} | overrides
    settings = toolbox_settings("postgresql+psycopg://u@localhost/x", tmp_path, **values)
    state = SimpleNamespace(
        settings=settings,
        toolbox=ToolboxIntegration(settings, store=MemoryTokenStore(), transport=fake.transport),
        contact_dispatcher=None,
    )
    assert sending_reason(state) == reason


def test_an_expired_connection_is_its_own_reason(
    toolbox_app: FastAPI, connected: TestClient, fake: FakeToolbox
) -> None:
    state = toolbox_app.state
    later = datetime.now(UTC) + timedelta(days=31)
    state.settings = state.settings.model_copy(
        update={"contact_dispatch_interval_ms": DEFAULT_INTERVAL_MS}
    )
    state.toolbox = ToolboxIntegration(
        state.settings, store=state.toolbox.store, transport=fake.transport, now=lambda: later
    )
    assert sending_reason(state) == "toolbox_expired"
    assert dispatch_of(connected)["reason"] == "toolbox_expired"


def test_connected_and_switched_on_but_no_worker_is_reported(
    toolbox_app: FastAPI, connected: TestClient
) -> None:
    state = toolbox_app.state
    state.settings = state.settings.model_copy(
        update={"contact_dispatch_interval_ms": DEFAULT_INTERVAL_MS}
    )
    assert state.contact_dispatcher is None
    assert sending_reason(state) == "not_running"


def test_the_dashboard_counts_scheduled_and_overdue_messages(
    client: TestClient, db_session: Session
) -> None:
    assert dispatch_of(client) == {
        "active": False,
        "reason": "toolbox_disabled",
        "scheduled_count": 0,
        "overdue_count": 0,
    }
    first = prospect_id(db_session)
    late = schedule(client, first)
    schedule(client, prospect_id(db_session))
    # Yesterday's message (the Human's case): its time has passed, nothing claimed it.
    db_session.execute(
        text("UPDATE contact_messages SET scheduled_at = :at WHERE id = :id"),
        {"at": datetime.now(UTC) - timedelta(hours=17), "id": uuid.UUID(late["id"])},
    )
    assert dispatch_of(client) == {
        "active": False,
        "reason": "toolbox_disabled",
        "scheduled_count": 2,
        "overdue_count": 1,
    }
    defaults = ok(client.get(messages(first)))["defaults"]
    assert (defaults["automatic_sending_active"], defaults["dispatch_reason"]) == (
        False,
        "toolbox_disabled",
    )
