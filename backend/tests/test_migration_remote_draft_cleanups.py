"""Migration 0010 (S6 remote draft cleanup queue): additive, clean downgrade, SQL invariants.

The down/up test migrates the shared `*_test` database, so it rebuilds the schema when it ends.
"""

import uuid
from collections.abc import Iterator

import pytest
from alembic import command
from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError

from tests.support import alembic_config, reset_database


@pytest.fixture
def migration_database(engine: Engine, test_database_url: str) -> Iterator[str]:
    try:
        yield test_database_url
    finally:
        reset_database(engine, test_database_url)


def test_0010_downgrades_and_upgrades_cleanly(engine: Engine, migration_database: str) -> None:
    config = alembic_config(migration_database)
    command.downgrade(config, "0009")
    with engine.connect() as connection:
        table = text("SELECT to_regclass('contact_message_remote_draft_cleanups')")
        assert connection.execute(table).scalar() is None
    command.upgrade(config, "head")
    with engine.connect() as connection:
        assert connection.execute(table).scalar() is not None


def test_0010_invariants(engine: Engine) -> None:
    with engine.connect() as connection, connection.begin() as transaction:
        prospect = connection.execute(
            text("INSERT INTO prospects (last_name) VALUES ('Queue') RETURNING id")
        ).scalar_one()
        message = connection.execute(
            text(
                "INSERT INTO contact_messages (prospect_id, step) VALUES (:p, 'contact') "
                "RETURNING id"
            ),
            {"p": prospect},
        ).scalar_one()
        insert = text(
            "INSERT INTO contact_message_remote_draft_cleanups "
            "(message_id, remote_provider, remote_draft_id, reason) "
            "VALUES (:m, 'circoe_toolbox', :d, :r) RETURNING attempts, next_attempt_at"
        )
        attempts, due = connection.execute(insert, {"m": message, "d": "d-1", "r": "edited"}).one()
        assert attempts == 0 and due is not None
        for values in ({"d": "d-1", "r": "edited"}, {"d": "d-2", "r": "unknown"}):
            with pytest.raises(IntegrityError), connection.begin_nested():
                connection.execute(insert, {"m": message} | values)
        with pytest.raises(IntegrityError), connection.begin_nested():
            connection.execute(
                text(
                    "UPDATE contact_message_remote_draft_cleanups SET completed_at = now() "
                    "WHERE remote_draft_id = 'd-1'"
                )
            )
        # Deleting the prospect (and its messages) keeps the id to delete remotely.
        connection.execute(text("DELETE FROM prospects WHERE id = :p"), {"p": prospect})
        orphan = connection.execute(
            text(
                "SELECT message_id FROM contact_message_remote_draft_cleanups "
                "WHERE remote_draft_id = 'd-1'"
            )
        ).one()
        assert orphan.message_id is None
        assert isinstance(message, uuid.UUID)
        transaction.rollback()
