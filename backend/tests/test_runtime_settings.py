"""Integration settings set from the browser (Contact port S8): storage, precedence, validation
parity with the startup rules, write-only secret, live reconfiguration, concurrency."""

import json
import logging
import os
import uuid
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import Engine
from sqlalchemy.orm import Session

from app.api.routes.contact_messages import get_mail_generator
from app.core.actor import ActorContext, ActorType
from app.core.config import CIRCOE_TOOLBOX_MCP_URL, REPOSITORY_ROOT, Settings
from app.db.session import create_session_factory
from app.services.errors import ConflictError, InvalidFieldError
from app.services.runtime_settings import RuntimeSettings
from app.services.toolbox.integration import ToolboxIntegration
from app.services.toolbox.token_store import MemoryTokenStore
from tests.builders import audit_events
from tests.fake_toolbox import ORIGIN, FakeToolbox
from tests.test_contact_messages_api import messages, ok, prospect_id, refused

URL = "/api/settings/integrations"
TOOLBOX = "/api/settings/toolbox"
KEY = "sk-test-secret-key-abcd1234"
OTHER_KEY = "sk-test-other-key-wxyz9876"
REDIRECT = "http://localhost:5173/settings/connections"
PERSON = ActorContext(type=ActorType.HUMAN, display="Pilote Test", id=str(uuid.uuid4()))


def put(client: TestClient, **changes: Any) -> Any:
    version = ok(client.get(URL))["version"]
    return client.put(URL, json={"version": version, **changes})


def runtime(tmp_path: Path, **values: Any) -> RuntimeSettings:
    return RuntimeSettings(Settings(runtime_settings_path=tmp_path / "rs.json", **values))


# --- storage -----------------------------------------------------------------------------------


def test_the_file_is_written_atomically_outside_the_checkout(tmp_path: Path) -> None:
    settings = runtime(tmp_path)
    settings.update({"openai_model": "m-1"}, expected_revision=0, actor=PERSON)

    path = tmp_path / "rs.json"
    stored = json.loads(path.read_text(encoding="utf-8"))
    assert stored["revision"] == 1
    assert stored["values"]["openai_model"]["value"] == "m-1"
    assert stored["values"]["openai_model"]["updated_by"] == "Pilote Test"
    # No temporary file left behind (temporary file + os.replace).
    assert [p.name for p in tmp_path.iterdir()] == ["rs.json"]
    if os.name != "nt":  # Windows ignores POSIX modes: the profile's ACL applies (documented).
        assert path.stat().st_mode & 0o777 == 0o600
    with pytest.raises(ValidationError, match="outside the repository"):
        Settings(runtime_settings_path=REPOSITORY_ROOT / "backend" / "runtime-settings.json")


def test_the_default_file_is_in_the_user_profile() -> None:
    assert Settings(runtime_settings_path=None).runtime_settings_file == (
        Path.home() / ".viper" / "runtime-settings.json"
    )


@pytest.mark.parametrize(
    ("content", "error"),
    [
        ("{not json", "invalid"),
        ('{"version": 2, "values": {}}', "invalid"),
        # Valid JSON whose values break a rule (e.g. a hand edit): ignored, never half-applied.
        (
            '{"version": 1, "revision": 3, "values": {"openai_base_url": '
            '{"value": "ftp://x", "updated_at": "2026-10-01T00:00:00Z"}}}',
            "invalid",
        ),
    ],
)
def test_a_broken_file_is_reported_and_ignored(tmp_path: Path, content: str, error: str) -> None:
    (tmp_path / "rs.json").write_text(content, encoding="utf-8")
    settings = runtime(tmp_path)
    assert settings.load_error == error
    assert settings.effective.openai_base_url == "https://api.openai.com/v1"
    # The next save rewrites the file and clears the error.
    revision = settings.file.revision
    settings.update({"openai_model": "m"}, expected_revision=revision, actor=PERSON)
    assert settings.load_error is None
    assert RuntimeSettings(settings.base).effective.openai_model == "m"


def test_a_stored_value_is_reloaded_at_startup(tmp_path: Path) -> None:
    runtime(tmp_path).update(
        {"openai_api_key": KEY, "openai_model": "m"}, expected_revision=0, actor=PERSON
    )
    again = runtime(tmp_path)
    assert again.effective.generation_available
    assert again.secret_meta("openai_api_key").source == "ui"


# --- precedence --------------------------------------------------------------------------------


def test_the_browser_overrides_the_variable_and_a_reset_falls_back(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VIPER_OPENAI_MODEL", "env-model")
    settings = runtime(tmp_path)
    assert (settings.effective.openai_model, settings.source("openai_model")) == (
        "env-model",
        "env",
    )
    assert settings.source("contact_booking_url") == "default"

    settings.update({"openai_model": "ui-model"}, expected_revision=0, actor=PERSON)
    assert (settings.effective.openai_model, settings.source("openai_model")) == ("ui-model", "ui")
    assert settings.fallback("openai_model") == "env-model"

    settings.update({"openai_model": None}, expected_revision=1, actor=PERSON)
    assert (settings.effective.openai_model, settings.source("openai_model")) == (
        "env-model",
        "env",
    )


def test_an_empty_text_means_none_even_over_a_variable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("VIPER_CONTACT_BOOKING_URL", "https://rdv.exemple.example/x")
    settings = runtime(tmp_path)
    settings.update({"contact_booking_url": ""}, expected_revision=0, actor=PERSON)
    assert settings.effective.contact_booking_url is None
    assert settings.source("contact_booking_url") == "ui"


def test_the_api_reports_values_sources_and_fallbacks(client: TestClient) -> None:
    body = ok(client.get(URL))
    assert body["version"] == 0
    assert body["fields"]["openai_base_url"] == {
        "value": "https://api.openai.com/v1",
        "source": "default",
        "fallback": "https://api.openai.com/v1",
        "updated_at": None,
        "updated_by": None,
    }
    assert body["openai_api_key"] == {
        "set": False,
        "last4": None,
        "source": None,
        "updated_at": None,
        "updated_by": None,
    }
    assert body["generation_available"] is False
    assert body["toolbox"] == {"enabled": False, "state": "disabled", "configured": False}
    assert body["dispatch"] == {"running": False, "active": False}
    # Environment-only settings are not exposed.
    assert set(body["fields"]) == {
        "openai_model",
        "openai_base_url",
        "openai_timeout_ms",
        "openai_max_retries",
        "contact_booking_url",
        "default_outbound_email",
        "toolbox_mail_enabled",
        "toolbox_mcp_url",
        "toolbox_oauth_redirect_uri",
        "contact_dispatch_interval_ms",
        "infomaniak_send_allowlist",
    }

    body = ok(put(client, contact_booking_url="https://rdv.exemple.example/a"))
    booking = body["fields"]["contact_booking_url"]
    assert (booking["value"], booking["source"], booking["updated_by"]) == (
        "https://rdv.exemple.example/a",
        "ui",
        "Pilote Test",
    )
    assert body["version"] == 1


# --- validation parity -------------------------------------------------------------------------

INVALID = [
    ("openai_base_url", "ftp://api.example.test/v1"),
    ("openai_base_url", "javascript:alert(1)"),
    ("contact_booking_url", "pas une url"),
    ("openai_timeout_ms", 10),
    ("openai_max_retries", 9),
    ("default_outbound_email", "sans-arobase"),
    ("toolbox_mcp_url", "http://toolbox.example.test/mcp"),
    ("toolbox_oauth_redirect_uri", "ftp://x.test/cb"),
    ("contact_dispatch_interval_ms", 100),
    ("contact_dispatch_interval_ms", -1),
    ("infomaniak_send_allowlist", "pas-une-adresse"),
]


@pytest.mark.parametrize(("field", "value"), INVALID)
def test_the_startup_rules_refuse_the_same_values(
    client: TestClient, field: str, value: Any
) -> None:
    with pytest.raises(ValidationError):
        Settings(**{field: value})
    detail = refused(put(client, **{field: value}), 422, "invalid")
    assert detail["field"] == field
    # Nothing was saved.
    assert ok(client.get(URL))["version"] == 0


def test_a_key_needs_a_model_as_at_startup(client: TestClient) -> None:
    with pytest.raises(ValidationError, match="VIPER_OPENAI_MODEL is required"):
        Settings(openai_api_key=KEY)
    detail = refused(put(client, openai_api_key=KEY), 422, "invalid")
    assert detail["field"] == "openai_model"
    assert KEY not in json.dumps(detail)
    refused(put(client, openai_api_key="   "), 422, "invalid")


def test_the_loopback_rule_and_the_disabled_interval_are_accepted(client: TestClient) -> None:
    body = ok(
        put(
            client,
            toolbox_mcp_url="http://127.0.0.1:9/mcp",
            contact_dispatch_interval_ms=0,
            infomaniak_send_allowlist="A@x.example, @y.example",
        )
    )
    assert body["fields"]["contact_dispatch_interval_ms"]["value"] == 0
    assert body["fields"]["toolbox_mcp_url"]["value"] == "http://127.0.0.1:9/mcp"


def test_unknown_or_environment_only_fields_are_refused(client: TestClient) -> None:
    for field in ("database_url", "toolbox_token_store_path", "runtime_settings_path"):
        assert put(client, **{field: "x"}).status_code == 422
    with pytest.raises(InvalidFieldError):
        RuntimeSettings(client.app.state.runtime_settings.base).update(  # type: ignore[attr-defined]
            {"database_url": "x"}, expected_revision=0, actor=PERSON
        )


# --- the write-only secret ---------------------------------------------------------------------


def test_the_key_never_leaves_the_server(
    client: TestClient, db_session: Session, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    response = put(client, openai_api_key=KEY, openai_model="m-1")
    body = ok(response)
    assert body["openai_api_key"]["set"] is True
    assert body["openai_api_key"]["last4"] == "1234"
    assert body["openai_api_key"]["source"] == "ui"
    assert body["openai_api_key"]["updated_by"] == "Pilote Test"
    assert body["generation_available"] is True
    replaced = put(client, openai_api_key=OTHER_KEY)
    cleared = put(client, openai_api_key=None)
    assert ok(cleared)["openai_api_key"]["set"] is False

    for text in (response.text, replaced.text, cleared.text, client.get(URL).text, caplog.text):
        assert KEY not in text
        assert OTHER_KEY not in text
    events = audit_events(db_session, action="settings.integrations_changed")
    assert len(events) == 3
    stored = " ".join(f"{event.changes} {event.context}" for event in events)
    assert KEY not in stored and OTHER_KEY not in stored
    assert "openai_api_key" not in str([event.changes for event in events])
    assert [event.context["reason"] for event in events] == [
        "openai_api_key: replaced",
        "openai_api_key: replaced",
        "openai_api_key: removed",
    ]
    assert events[0].changes["openai_model"] == {"before": None, "after": "m-1"}
    assert repr(client.app.state.runtime_settings.file).count("sk-") == 0  # type: ignore[attr-defined]


def test_a_save_that_changes_nothing_is_not_audited(
    client: TestClient, db_session: Session
) -> None:
    ok(put(client))
    ok(put(client, openai_model="m"))
    ok(put(client, openai_model="m"))
    assert len(audit_events(db_session, action="settings.integrations_changed")) == 1
    # Setting the default value explicitly changes its source: recorded.
    ok(put(client, openai_base_url="https://api.openai.com/v1"))
    assert len(audit_events(db_session, action="settings.integrations_changed")) == 2


# --- concurrency and access --------------------------------------------------------------------


def test_a_stale_version_is_refused(client: TestClient) -> None:
    ok(client.put(URL, json={"version": 0, "openai_model": "a"}))
    refused(client.put(URL, json={"version": 0, "openai_model": "b"}), 409, "conflict")
    assert ok(client.get(URL))["fields"]["openai_model"]["value"] == "a"


def test_the_service_checks_the_revision(tmp_path: Path) -> None:
    settings = runtime(tmp_path)
    with pytest.raises(ConflictError):
        settings.update({"openai_model": "m"}, expected_revision=4, actor=PERSON)


def test_the_routes_need_a_session_and_the_csrf_token(
    app: FastAPI, anonymous_client: TestClient, client: TestClient
) -> None:
    assert anonymous_client.get(URL).status_code == 401
    assert anonymous_client.put(URL, json={"version": 0}).status_code == 401
    assert anonymous_client.post(f"{URL}/openai/check").status_code == 401
    without_csrf = client.put(URL, json={"version": 0}, headers={"X-CSRF-Token": ""})
    assert without_csrf.status_code == 403


# --- live application --------------------------------------------------------------------------


def test_a_saved_key_drafts_without_a_restart(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session)
    assert ok(client.get(messages(prospect)))["defaults"]["generation_available"] is False
    seen: list[str] = []

    def openai(request: httpx2.Request) -> httpx2.Response:
        seen.append(request.headers["authorization"])
        text = json.dumps({"subject": "Objet IA", "body": "Bonjour,\n\nCorps IA."})
        return httpx2.Response(
            200,
            json={
                "status": "completed",
                "model": "m-ui",
                "output": [{"type": "message", "content": [{"type": "output_text", "text": text}]}],
            },
        )

    app.state.openai_transport = httpx2.MockTransport(openai)
    ok(
        put(
            client,
            openai_api_key=KEY,
            openai_model="m-ui",
            openai_base_url="http://127.0.0.1:9/v1",
            default_outbound_email="ui@exemple.example",
        )
    )
    defaults = ok(client.get(messages(prospect)))["defaults"]
    assert defaults["generation_available"] is True
    assert defaults["from_email"] == "ui@exemple.example"
    generated = client.post(f"{messages(prospect)}/contact/generate", json={})
    assert ok(generated, 201)["message"]["subject"] == "Objet IA"
    assert seen == [f"Bearer {KEY}"]

    ok(put(client, openai_api_key=None))
    assert ok(client.get(messages(prospect)))["defaults"]["generation_available"] is False
    assert get_mail_generator not in app.dependency_overrides  # the real adapter answered
    refused(client.post(f"{messages(prospect)}/r1/generate", json={}), 503, "ai_not_configured")


@pytest.fixture
def fake_toolbox(app: FastAPI, engine: Engine) -> FakeToolbox:
    fake = FakeToolbox()
    store = MemoryTokenStore()
    app.state.integrations.toolbox_factory = lambda settings: ToolboxIntegration(
        settings, store=store, transport=fake.transport
    )
    # The worker threads get their own sessions (never the per-test connection).
    app.state.integrations.worker_session_factory = create_session_factory(engine)
    return fake


def test_connecting_from_the_page_turns_the_toolbox_on_then_starts_the_workers(
    app: FastAPI, client: TestClient, fake_toolbox: FakeToolbox, db_session: Session
) -> None:
    state = app.state
    ok(put(client, contact_dispatch_interval_ms=30_000))
    assert (state.toolbox_worker, state.contact_dispatcher) == (None, None)

    # « Se connecter à CIRCOE Toolbox » from a fresh install: no switch, no URL to type.
    started = ok(client.post(f"{TOOLBOX}/connect", json={"redirect_uri": REDIRECT}))
    assert started["authorization_url"].startswith(ORIGIN)
    body = ok(client.get(URL))
    assert body["toolbox"] == {"enabled": True, "state": "disconnected", "configured": True}
    redirect = body["fields"]["toolbox_oauth_redirect_uri"]
    assert (redirect["value"], redirect["source"]) == (REDIRECT, "ui")
    # Not connected yet: no worker.
    assert (state.toolbox_worker, state.contact_dispatcher) == (None, None)
    events = audit_events(db_session, action="settings.integrations_changed")
    assert set(events[-1].changes) == {"toolbox_mail_enabled", "toolbox_oauth_redirect_uri"}

    connected = ok(
        client.post(
            f"{TOOLBOX}/callback", json=fake_toolbox.authorize(started["authorization_url"])
        )
    )
    assert connected["state"] == "connected"
    assert connected["dispatch"]["running"] is True
    assert state.toolbox_worker is not None and state.contact_dispatcher is not None
    assert ok(client.get(URL))["dispatch"]["active"] is True

    # Another interval: a new dispatcher, the same integration (still connected).
    integration, dispatcher = state.toolbox, state.contact_dispatcher
    ok(put(client, contact_dispatch_interval_ms=10_000))
    assert state.toolbox is integration
    assert state.contact_dispatcher is not dispatcher
    assert state.contact_dispatcher.interval_seconds == 10
    assert dispatcher.status().running is False
    ok(put(client, infomaniak_send_allowlist="@exemple.example"))
    assert state.contact_dispatcher._dispatcher.config.allowlist == ("@exemple.example",)

    # « Désactivé »: no dispatcher; the cleanup worker stays.
    ok(put(client, contact_dispatch_interval_ms=0))
    assert state.contact_dispatcher is None and state.toolbox_worker is not None

    # « Se déconnecter »: token forgotten, integration off, workers stopped.
    worker = state.toolbox_worker
    body = ok(client.post(f"{TOOLBOX}/forget"))
    assert body["state"] == "disabled"
    assert (state.toolbox_worker, state.contact_dispatcher) == (None, None)
    assert worker._thread is None  # stopped, not abandoned
    assert ok(client.get(URL))["fields"]["toolbox_mail_enabled"]["value"] is False


def test_a_typed_return_address_is_kept_an_automatic_one_follows_the_page(
    app: FastAPI, client: TestClient, fake_toolbox: FakeToolbox
) -> None:
    ok(client.post(f"{TOOLBOX}/connect", json={"redirect_uri": REDIRECT}))
    other = "https://viper.exemple.example/settings/connections"
    ok(client.post(f"{TOOLBOX}/connect", json={"redirect_uri": other}))
    assert ok(client.get(URL))["fields"]["toolbox_oauth_redirect_uri"]["value"] == other

    typed = "https://typed.exemple.example/settings/connections"
    ok(put(client, toolbox_oauth_redirect_uri=typed))
    ok(client.post(f"{TOOLBOX}/connect", json={"redirect_uri": REDIRECT}))
    assert ok(client.get(URL))["fields"]["toolbox_oauth_redirect_uri"]["value"] == typed


def test_a_page_address_off_the_rules_is_refused(
    app: FastAPI, client: TestClient, fake_toolbox: FakeToolbox
) -> None:
    detail = refused(
        client.post(f"{TOOLBOX}/connect", json={"redirect_uri": "http://192.0.2.10/settings"}),
        422,
        "invalid",
    )
    assert detail["field"] == "toolbox_oauth_redirect_uri"
    assert ok(client.get(URL))["toolbox"]["enabled"] is False


def test_the_built_in_toolbox_url_is_the_circoe_one_and_never_reached_in_tests() -> None:
    fields = Settings.model_fields
    assert fields["toolbox_mcp_url"].default == CIRCOE_TOOLBOX_MCP_URL
    assert fields["contact_dispatch_interval_ms"].default == 0
    with pytest.raises(AssertionError, match="real CIRCOE Toolbox"):
        httpx2.Client().get(CIRCOE_TOOLBOX_MCP_URL)


# --- « Tester la clé » -------------------------------------------------------------------------


def check(app: FastAPI, client: TestClient, status: int, body: dict[str, Any]) -> dict[str, Any]:
    seen: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(status, json=body)

    app.state.openai_transport = httpx2.MockTransport(handler)
    result = ok(client.post(f"{URL}/openai/check"))
    if seen:
        assert seen[0].method == "GET"
        assert str(seen[0].url) == "http://127.0.0.1:9/v1/models/m-1"
        assert seen[0].headers["authorization"] == f"Bearer {KEY}"
    return result


def test_the_key_check(app: FastAPI, client: TestClient) -> None:
    assert ok(client.post(f"{URL}/openai/check"))["code"] == "ai_not_configured"
    ok(put(client, openai_api_key=KEY, openai_model="m-1", openai_base_url="http://127.0.0.1:9/v1"))

    passed = check(app, client, 200, {"id": "m-1", "object": "model"})
    assert (passed["ok"], passed["model"], passed["code"]) == (True, "m-1", None)
    error = {"error": {"code": "invalid_api_key"}}
    assert check(app, client, 401, error)["code"] == "ai_auth_failed"
    assert check(app, client, 404, {"error": {"code": "model_not_found"}})["code"] == (
        "ai_model_not_found"
    )
    assert check(app, client, 429, {"error": {"code": "insufficient_quota"}})["code"] == (
        "ai_rate_limited"
    )
    assert check(app, client, 500, {})["code"] == "ai_upstream_error"


def test_the_key_check_reports_an_unreachable_service(app: FastAPI, client: TestClient) -> None:
    ok(put(client, openai_api_key=KEY, openai_model="m-1"))

    def down(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ConnectError("refused", request=request)

    app.state.openai_transport = httpx2.MockTransport(down)
    result = ok(client.post(f"{URL}/openai/check"))
    assert (result["ok"], result["code"]) == (False, "ai_upstream_error")
