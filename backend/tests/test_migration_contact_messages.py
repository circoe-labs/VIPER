"""Migration 0009 (Contact messages): additive upgrade next to existing rows, clean downgrade
(table and trigger function gone, prospects untouched), and the SQL invariants of the table.

The down/up test migrates the shared `*_test` database with committed rows, so it rebuilds the
schema from scratch when it ends (every other test runs in a rolled-back transaction).
"""

import uuid
from collections.abc import Iterator

import pytest
from alembic import command
from sqlalchemy import Engine, text

from tests.support import alembic_config, reset_database


@pytest.fixture
def migration_database(engine: Engine, test_database_url: str) -> Iterator[str]:
    try:
        yield test_database_url
    finally:
        reset_database(engine, test_database_url)


def test_0009_is_additive_and_downgrades_cleanly(engine: Engine, migration_database: str) -> None:
    config = alembic_config(migration_database)
    prospect = uuid.uuid4()
    with engine.begin() as connection:
        connection.execute(
            text("INSERT INTO prospects (id, last_name) VALUES (:id, 'Migration')"),
            {"id": prospect},
        )
        connection.execute(
            text("INSERT INTO contact_messages (prospect_id, step) VALUES (:id, 'contact')"),
            {"id": prospect},
        )

    command.downgrade(config, "0008")
    with engine.connect() as connection:
        assert connection.execute(text("SELECT to_regclass('contact_messages')")).scalar() is None
        functions = connection.execute(
            text("SELECT count(*) FROM pg_proc WHERE proname = :name"),
            {"name": "contact_messages_reject_sent_change"},
        ).scalar_one()
        assert functions == 0
        assert connection.execute(text("SELECT count(*) FROM prospects")).scalar_one() == 1

    command.upgrade(config, "head")
    with engine.connect() as connection:
        row = connection.execute(
            text("SELECT count(*) FROM contact_messages WHERE prospect_id = :id"),
            {"id": prospect},
        ).scalar_one()
        assert row == 0


def test_0009_defaults_of_a_raw_insert(engine: Engine) -> None:
    with engine.connect() as connection, connection.begin() as transaction:
        prospect = connection.execute(
            text("INSERT INTO prospects (last_name) VALUES ('Brut') RETURNING id")
        ).scalar_one()
        row = connection.execute(
            text(
                "INSERT INTO contact_messages (prospect_id, step) VALUES (:id, 'r2') "
                "RETURNING status, revision, subject, body_text, to_recipients, dispatch_attempts"
            ),
            {"id": prospect},
        ).one()
        transaction.rollback()
    assert tuple(row) == ("draft", 1, "", "", [], 0)
