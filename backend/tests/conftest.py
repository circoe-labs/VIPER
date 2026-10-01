"""Fixtures: a freshly migrated `*_test` database, one rolled-back transaction per test, and API
clients — `client` signed in as the pilot user (default), `anonymous_client` without a session."""

import os
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.api.session_cookie import CSRF_HEADER, SESSION_COOKIE
from app.core.config import Settings
from app.core.security import csrf_token
from app.db.session import create_db_engine, unit_of_work
from app.main import create_app
from app.models import User
from app.services import audit
from app.services.auth import SessionPolicy, open_session
from tests.builders import FIXTURE_ACTOR, add_user
from tests.fake_toolbox import MCP_URL, FakeToolbox
from tests.support import (
    TEST_BASE_URL,
    require_test_database,
    reset_database,
    rolled_back_session_factory,
)

# The integration settings saved from the browser (S8) live in a private file: no test may read or
# write the person's `~/.viper/runtime-settings.json`. Every `Settings()` of the test session
# (the CLI, `create_app` without settings…) points at a fresh temporary file instead; the `app`
# fixture gives each test its own.
os.environ["VIPER_RUNTIME_SETTINGS_PATH"] = str(
    Path(tempfile.mkdtemp(prefix="viper-tests-")) / "runtime-settings.json"
)


@pytest.fixture(autouse=True)
def _no_real_toolbox(monkeypatch: pytest.MonkeyPatch) -> None:
    """The built-in Toolbox URL (S8 default) is never reached from a test (Contact port P6): a
    request to its host through the real HTTP transport fails the test."""
    import httpx2

    from app.core.config import CIRCOE_TOOLBOX_MCP_URL

    real_host = httpx2.URL(CIRCOE_TOOLBOX_MCP_URL).host
    handle = httpx2.HTTPTransport.handle_request

    def guarded(self: httpx2.HTTPTransport, request: httpx2.Request) -> httpx2.Response:
        assert request.url.host != real_host, "a test tried to reach the real CIRCOE Toolbox"
        return handle(self, request)

    monkeypatch.setattr(httpx2.HTTPTransport, "handle_request", guarded)


@pytest.fixture(scope="session")
def test_database_url() -> str:
    try:
        return require_test_database(Settings().test_database_url)
    except ValueError as error:
        raise pytest.UsageError(str(error)) from error


@pytest.fixture(scope="session")
def engine(test_database_url: str) -> Iterator[Engine]:
    engine = create_db_engine(test_database_url)
    reset_database(engine, test_database_url)
    yield engine
    engine.dispose()


@pytest.fixture
def session_factory(engine: Engine) -> Iterator[sessionmaker[Session]]:
    """Sessions sharing one per-test transaction that is rolled back at teardown."""
    with rolled_back_session_factory(engine) as factory:
        yield factory


@pytest.fixture
def db_session(session_factory: sessionmaker[Session]) -> Iterator[Session]:
    """Test session whose direct ORM writes are attributed to `FIXTURE_ACTOR` (audited tables
    refuse unattributed writes); tests rebind it, e.g. with `bind_operator`."""
    with session_factory() as session:
        audit.bind(session, FIXTURE_ACTOR)
        yield session


@pytest.fixture
def app(test_database_url: str, session_factory: sessionmaker[Session], tmp_path: Path) -> FastAPI:
    """The real app, with the per-request unit of work running inside the per-test transaction.

    The AI drafting and the CIRCOE Toolbox are never configured here, whatever `backend/.env`
    says: no test may reach OpenAI or the Toolbox (Contact port P6); generation tests inject a
    fake generator or a local fake server, Toolbox tests the fake of `tests/fake_toolbox.py`.
    Its browser-set integration settings (S8) live in the test's own temporary file."""
    app = create_app(
        Settings(
            database_url=test_database_url,
            openai_api_key=None,
            toolbox_mail_enabled=False,
            # Never the real Toolbox, even when a test turns the integration on (S8).
            toolbox_mcp_url=MCP_URL,
            runtime_settings_path=tmp_path / "runtime-settings.json",
        )
    )
    app.state.session_factory = session_factory
    return app


@pytest.fixture
def anonymous_client(app: FastAPI) -> Iterator[TestClient]:
    """API client without a session. HTTPS so the `Secure` session cookie round-trips."""
    with TestClient(app, base_url=TEST_BASE_URL) as test_client:
        yield test_client


@pytest.fixture
def pilot_user(session_factory: sessionmaker[Session]) -> User:
    with unit_of_work(session_factory) as session:
        return add_user(session)


@pytest.fixture
def client(
    app: FastAPI, session_factory: sessionmaker[Session], pilot_user: User
) -> Iterator[TestClient]:
    """API client signed in as `pilot_user`: session cookie plus the CSRF header on every call."""
    with unit_of_work(session_factory) as session:
        policy = SessionPolicy.from_settings(app.state.settings)
        token = open_session(session, pilot_user, policy).token
    with TestClient(
        app,
        base_url=TEST_BASE_URL,
        cookies={SESSION_COOKIE: token},
        headers={CSRF_HEADER: csrf_token(token)},
    ) as test_client:
        yield test_client


# --- CIRCOE Toolbox (S6/S7): the app against the local fake Toolbox, never a real one (P6) --------


@pytest.fixture
def fake() -> FakeToolbox:
    return FakeToolbox()


@pytest.fixture
def toolbox_app(app: FastAPI, fake: FakeToolbox, tmp_path: Path) -> FastAPI:
    """The app with the Toolbox enabled against `fake` (token in memory, no worker thread)."""
    from app.services.runtime_settings import RuntimeSettings
    from app.services.toolbox.integration import ToolboxIntegration
    from app.services.toolbox.token_store import MemoryTokenStore
    from tests.test_contact_remote_drafts import toolbox_settings

    settings = toolbox_settings(app.state.settings.database_url, tmp_path)
    app.state.runtime_settings = RuntimeSettings(settings)
    app.state.settings = settings
    store = MemoryTokenStore()
    # A save from Paramètres > Connexions (S8) rebuilds the integration: same store, same fake.
    app.state.integrations.toolbox_factory = lambda changed: ToolboxIntegration(
        changed, store=store, transport=fake.transport
    )
    app.state.toolbox = ToolboxIntegration(settings, store=store, transport=fake.transport)
    return app


@pytest.fixture
def connected(toolbox_app: FastAPI, client: TestClient, fake: FakeToolbox) -> TestClient:
    """`client` with the Toolbox connected through the real OAuth routes."""
    from tests.test_contact_remote_drafts import connect

    connect(client, fake)
    return client
