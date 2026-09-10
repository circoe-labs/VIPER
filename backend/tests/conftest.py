"""Fixtures: a freshly migrated `*_test` database and one rolled-back transaction per test."""

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import Settings
from app.db.session import create_db_engine
from app.main import create_app
from tests.support import require_test_database, reset_database, rolled_back_session_factory


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
    with session_factory() as session:
        yield session


@pytest.fixture
def client(test_database_url: str, session_factory: sessionmaker[Session]) -> Iterator[TestClient]:
    """API client using the real per-request unit of work, inside the per-test transaction."""
    app = create_app(Settings(database_url=test_database_url))
    app.state.session_factory = session_factory
    with TestClient(app) as test_client:
        yield test_client
