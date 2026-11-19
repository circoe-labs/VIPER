"""Migration 0059 (versions of a step's text and saved mails): additive, clean downgrade, SQL
invariants (rating 0-10, a complete saved facet, a closed set of sources).

The down/up test migrates the shared `*_test` database, so it rebuilds the schema when it ends.
"""

from collections.abc import Iterator

import pytest
from alembic import command
from sqlalchemy import Engine, text
from sqlalchemy.exc import IntegrityError

from tests.support import alembic_config, reset_database
from tests.test_migration_remote_draft_cleanups import in_a_sequence


@pytest.fixture
def migration_database(engine: Engine, test_database_url: str) -> Iterator[str]:
    try:
        yield test_database_url
    finally:
        reset_database(engine, test_database_url)


def test_0059_downgrades_and_upgrades_cleanly(engine: Engine, migration_database: str) -> None:
    config = alembic_config(migration_database)
    command.downgrade(config, "0058")
    with engine.connect() as connection:
        table = text("SELECT to_regclass('contact_message_versions')")
        assert connection.execute(table).scalar() is None
    command.upgrade(config, "head")
    with engine.connect() as connection:
        assert connection.execute(table).scalar() is not None


INSERT = text(
    "INSERT INTO contact_message_versions (prospect_id, sequence_id, rank, revision, source, "
    "actor_type, actor_display, saved_at, saved_by_display, rating) "
    "VALUES (:p, :s, 0, 1, :source, 'human', 'Test', :saved_at, :saved_by, :rating)"
)


def test_0059_invariants(engine: Engine) -> None:
    with engine.connect() as connection, connection.begin() as transaction:
        prospect = connection.execute(
            text("INSERT INTO prospects (last_name) VALUES ('Versions') RETURNING id")
        ).scalar_one()
        sequence = in_a_sequence(connection, prospect)
        base = {"p": prospect, "s": sequence, "source": "ai"}

        def rejected(**fields: object) -> None:
            with connection.begin_nested() as savepoint:
                with pytest.raises(IntegrityError):
                    connection.execute(INSERT, {**base, **fields})
                savepoint.rollback()

        plain = {"saved_at": None, "saved_by": None, "rating": None}
        connection.execute(INSERT, {**base, **plain})
        connection.execute(
            INSERT, {**base, "saved_at": "2026-11-19T10:00:00Z", "saved_by": "Test", "rating": 0}
        )
        rejected(**plain, source="robot")
        rejected(saved_at="2026-11-19T10:00:00Z", saved_by="Test", rating=11)
        rejected(saved_at="2026-11-19T10:00:00Z", saved_by="Test", rating=None)
        rejected(saved_at=None, saved_by=None, rating=5)
        transaction.rollback()
