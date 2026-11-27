"""Migration 0061: the sends that did not leave before the upgrade show too (backfill from the
audit log), clean downgrade.

The down/up test migrates the shared `*_test` database, so it rebuilds the schema when it ends.
"""

import json
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from alembic import command
from sqlalchemy import Connection, Engine, text

from tests.support import alembic_config, reset_database
from tests.test_migration_remote_draft_cleanups import in_a_sequence

MOMENT = datetime(2026, 11, 24, 7, 0, tzinfo=UTC)


@pytest.fixture
def migration_database(engine: Engine, test_database_url: str) -> Iterator[str]:
    try:
        yield test_database_url
    finally:
        reset_database(engine, test_database_url)


def _message(connection: Connection, status: str, rank: int, sequence: object, p: object) -> object:
    extra = value = ""
    if status != "draft":
        extra = ", validated_revision, validated_at, validated_by_actor_id, validated_by_display"
        value = ", 1, now(), 'test', 'Test'"
    if status == "scheduled":
        extra += ", scheduled_at"
        value += ", now()"
    return connection.execute(
        text(
            f"INSERT INTO contact_messages (prospect_id, sequence_id, rank, status{extra}) "
            f"VALUES (:p, :s, :rank, :status{value}) RETURNING id"
        ),
        {"p": p, "s": sequence, "rank": rank, "status": status},
    ).scalar_one()


def _event(
    connection: Connection, message: object, action: str, reason: str | None, hours: int
) -> None:
    connection.execute(
        text(
            "INSERT INTO audit_log (id, occurred_at, actor_type, actor_display, entity_type, "
            "entity_id, action, changes, context) VALUES (gen_random_uuid(), "
            ":at + make_interval(hours => :hours), 'system', 'Test', 'contact_message', :id, "
            ":action, CAST(:changes AS jsonb), CAST(:context AS jsonb))"
        ),
        {
            "at": MOMENT,
            "hours": hours,
            "id": message,
            "action": action,
            "changes": json.dumps({"scheduled_at": {"before": MOMENT.isoformat(), "after": None}}),
            "context": json.dumps({"reason": reason} if reason else {}),
        },
    )


def test_0061_backfills_the_unsent_messages_and_downgrades(
    engine: Engine, migration_database: str
) -> None:
    config = alembic_config(migration_database)
    command.downgrade(config, "0060")
    with engine.begin() as connection:
        prospect = connection.execute(
            text("INSERT INTO prospects (last_name) VALUES ('Trace') RETURNING id")
        ).scalar_one()
        sequence = in_a_sequence(connection, prospect)
        lost = _message(connection, "validated", 0, sequence, prospect)
        _event(connection, lost, "contact_message.unscheduled", None, 0)
        _event(connection, lost, "contact_message.dispatch_failed", "send_draft_not_found", 1)
        taken_back = _message(connection, "draft", 1, sequence, prospect)
        _event(connection, taken_back, "contact_message.unscheduled", None, 0)
        rescheduled = _message(connection, "scheduled", 2, sequence, prospect)
        _event(connection, rescheduled, "contact_message.dispatch_failed", "dispatch_overdue", 0)
        # Unconfirmed, then rescheduled and taken back since: the doubt is an older event.
        edited = _message(connection, "draft", 3, sequence, prospect)
        _event(connection, edited, "contact_message.dispatch_failed", "send_not_confirmed", 0)
        _event(connection, edited, "contact_message.unscheduled", None, 2)
        stamps = text("SELECT id, updated_at FROM contact_messages")
        before = dict(connection.execute(stamps).tuples().all())

    command.upgrade(config, "0061")  # this revision alone: 0062 cancels the R3

    with engine.connect() as connection:
        rows = {
            row.id: (row.missed_reason, row.missed_scheduled_at)
            for row in connection.execute(
                text("SELECT id, missed_reason, missed_scheduled_at FROM contact_messages")
            )
        }
        doubts = dict(
            connection.execute(text("SELECT id, sent_doubt_reason FROM contact_messages"))
            .tuples()
            .all()
        )
        after = dict(connection.execute(stamps).tuples().all())
    assert after == before  # a backfill is not a change of the messages
    assert doubts == {
        lost: "send_draft_not_found",
        taken_back: None,
        rescheduled: None,
        edited: "send_not_confirmed",
    }
    assert rows[edited] == ("unscheduled_by_person", MOMENT)
    assert rows[lost] == ("send_draft_not_found", MOMENT)
    assert rows[taken_back] == ("unscheduled_by_person", MOMENT)
    assert rows[rescheduled] == (None, None)
