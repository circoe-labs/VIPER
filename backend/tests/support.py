"""Test-database helpers shared by fixtures and tests."""

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import Engine, make_url, text
from sqlalchemy.orm import Session, sessionmaker

BACKEND_DIR = Path(__file__).resolve().parents[1]
# API test clients use HTTPS: the session cookie is `Secure` by default.
TEST_BASE_URL = "https://testserver"


def alembic_config(database_url: str) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.attributes["database_url"] = database_url
    return config


def require_test_database(url: str) -> str:
    database = make_url(url).database or ""
    if not database.endswith("_test"):
        raise ValueError(
            f"Refusing to run tests against database {database!r}: its name must end with '_test'."
        )
    return url


def reset_database(engine: Engine, url: str) -> None:
    """Drop everything in `public` and migrate to head (test databases only)."""
    require_test_database(url)
    with engine.begin() as connection:
        connection.execute(text("DROP SCHEMA public CASCADE"))
        connection.execute(text("CREATE SCHEMA public"))
    command.upgrade(alembic_config(url), "head")


@contextmanager
def rolled_back_session_factory(engine: Engine) -> Iterator[sessionmaker[Session]]:
    """Session factory on one connection whose outer transaction is rolled back on exit.

    Sessions from it turn `commit()` (e.g. a unit of work) into a savepoint release, so tests can
    exercise real commit/rollback behaviour without leaking data. Same options as production
    (`create_session_factory`).
    """
    with engine.connect() as connection:
        transaction = connection.begin()
        try:
            yield sessionmaker(
                bind=connection, join_transaction_mode="create_savepoint", expire_on_commit=False
            )
        finally:
            transaction.rollback()


@contextmanager
def transactional_session(engine: Engine) -> Iterator[Session]:
    """Session whose work, even `commit()`ed, is rolled back on exit (commits become savepoints)."""
    with rolled_back_session_factory(engine) as session_factory, session_factory() as session:
        yield session
