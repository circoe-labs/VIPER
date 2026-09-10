"""Test-database helpers shared by fixtures and tests."""

from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from alembic.config import Config
from sqlalchemy import Engine
from sqlalchemy.orm import Session

BACKEND_DIR = Path(__file__).resolve().parents[1]


def alembic_config(database_url: str) -> Config:
    config = Config(str(BACKEND_DIR / "alembic.ini"))
    config.attributes["database_url"] = database_url
    return config


@contextmanager
def transactional_session(engine: Engine) -> Iterator[Session]:
    """Session whose work, even `commit()`ed, is rolled back on exit (commits become savepoints)."""
    with engine.connect() as connection:
        transaction = connection.begin()
        try:
            with Session(bind=connection, join_transaction_mode="create_savepoint") as session:
                yield session
        finally:
            transaction.rollback()
