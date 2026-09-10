"""Fixtures: a freshly migrated `*_test` database, one rolled-back transaction per test, and API
clients — `client` signed in as the pilot user (default), `anonymous_client` without a session."""

from collections.abc import Iterator

import pytest
from alembic import command
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import Engine, make_url, text
from sqlalchemy.orm import Session, sessionmaker

from app.api.session_cookie import CSRF_HEADER, SESSION_COOKIE
from app.core.config import Settings
from app.core.security import csrf_token
from app.db.session import create_db_engine, unit_of_work
from app.main import create_app
from app.models import User
from app.services.auth import SessionPolicy, open_session
from tests.builders import add_user
from tests.support import TEST_BASE_URL, alembic_config, rolled_back_session_factory


@pytest.fixture(scope="session")
def test_database_url() -> str:
    url = Settings().test_database_url
    database = make_url(url).database or ""
    if not database.endswith("_test"):
        raise pytest.UsageError(
            f"Refusing to run tests against database {database!r}: its name must end with '_test'."
        )
    return url


@pytest.fixture(scope="session")
def engine(test_database_url: str) -> Iterator[Engine]:
    engine = create_db_engine(test_database_url)
    with engine.begin() as connection:
        connection.execute(text("DROP SCHEMA public CASCADE"))
        connection.execute(text("CREATE SCHEMA public"))
    command.upgrade(alembic_config(test_database_url), "head")
    yield engine
    engine.dispose()


@pytest.fixture
def session_factory(engine: Engine) -> Iterator[sessionmaker[Session]]:
    """Sessions sharing one per-test transaction that is rolled back at teardown."""
    with rolled_back_session_factory(engine) as factory:
        yield factory


@pytest.fixture
def db_session(session_factory: sessionmaker[Session]) -> Iterator[Session]:
    with session_factory() as session:
        yield session


@pytest.fixture
def app(test_database_url: str, session_factory: sessionmaker[Session]) -> FastAPI:
    """The real app, with the per-request unit of work running inside the per-test transaction."""
    app = create_app(Settings(database_url=test_database_url))
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
