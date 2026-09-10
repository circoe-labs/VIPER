"""Fixtures: a freshly migrated `*_test` database and one rolled-back transaction per test."""

from collections.abc import Iterator

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Engine, make_url, text
from sqlalchemy.orm import Session

from app.api.dependencies import get_session
from app.core.config import Settings
from app.db.session import create_db_engine
from app.main import create_app
from tests.support import alembic_config, transactional_session


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
def db_session(engine: Engine) -> Iterator[Session]:
    with transactional_session(engine) as session:
        yield session


@pytest.fixture
def client(test_database_url: str, db_session: Session) -> Iterator[TestClient]:
    app = create_app(Settings(database_url=test_database_url))
    app.dependency_overrides[get_session] = lambda: db_session
    with TestClient(app) as test_client:
        yield test_client
