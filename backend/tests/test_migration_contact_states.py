"""Migration 0008 (Contact states) on seeded legacy rows: the handoff mapping, appended history,
audit events, the do-not-contact rule, the counts, and a best-effort downgrade then re-upgrade.

The test migrates the shared `*_test` database down and up with committed rows, so it rebuilds
the schema from scratch when it ends (every other test runs in a rolled-back transaction).
"""

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from alembic import command
from sqlalchemy import Connection, Engine, text
from sqlalchemy.exc import IntegrityError

from app.services.contact_workflow import CONTACT_STATES_MIGRATION_ID
from tests.support import alembic_config, reset_database

PLANNED = datetime(2026, 10, 5, tzinfo=UTC)
# (legacy status, do_not_contact, expected state)
CASES = [
    ("to_contact", False, "neutral"),
    ("contacted", False, "contacted"),
    ("follow_up_1", False, "r1"),
    ("follow_up_2", False, "r2"),
    ("response_received", False, "response_received"),
    ("appointment_obtained", False, "appointment_obtained"),
    ("quote_sent", False, "appointment_obtained"),
    ("quote_follow_up", False, "appointment_obtained"),
    ("won", False, "appointment_obtained"),
    ("not_interested", False, "failure"),
    ("not_interested", True, "ignored"),
    ("to_contact", True, "neutral"),  # an opposition never changes with the state
]


@pytest.fixture
def migration_database(engine: Engine, test_database_url: str) -> Iterator[str]:
    try:
        yield test_database_url
    finally:
        reset_database(engine, test_database_url)


def seed_legacy(connection: Connection) -> dict[int, uuid.UUID]:
    """One prospect + tracking per case, each with the legacy history row that created it."""
    trackings: dict[int, uuid.UUID] = {}
    for index, (status, blocked, _) in enumerate(CASES):
        prospect_id, tracking_id = uuid.uuid4(), uuid.uuid4()
        connection.execute(
            text(
                "INSERT INTO prospects (id, last_name, contactability_status, do_not_contact_at)"
                " VALUES (:id, :name, :status, :at)"
            ),
            {
                "id": prospect_id,
                "name": f"Migration{index}",
                "status": "do_not_contact" if blocked else "contactable",
                "at": datetime(2026, 1, 1, tzinfo=UTC) if blocked else None,
            },
        )
        connection.execute(
            text(
                "INSERT INTO contact_tracking (id, prospect_id, status, planned_contact_at)"
                " VALUES (:id, :prospect, :status, :planned)"
            ),
            {"id": tracking_id, "prospect": prospect_id, "status": status, "planned": PLANNED},
        )
        connection.execute(
            text(
                "INSERT INTO contact_tracking_status_history"
                " (contact_tracking_id, from_status, to_status, changed_at, actor_type,"
                " actor_display) VALUES (:id, NULL, :status, :at, 'human', 'Opératrice Test')"
            ),
            {"id": tracking_id, "status": status, "at": datetime(2026, 5, 4, tzinfo=UTC)},
        )
        trackings[index] = tracking_id
    return trackings


def statuses(connection: Connection) -> dict[object, object]:
    return {row[0]: row[1] for row in rows(connection, "SELECT id, status FROM contact_tracking")}


def rows(connection: Connection, sql: str, **params: object) -> list[tuple[object, ...]]:
    return [tuple(row) for row in connection.execute(text(sql), params)]


def test_0008_converts_legacy_statuses_and_keeps_history(
    engine: Engine, migration_database: str, capsys: pytest.CaptureFixture[str]
) -> None:
    config = alembic_config(migration_database)
    command.downgrade(config, "0007")
    with engine.begin() as connection:
        trackings = seed_legacy(connection)

    capsys.readouterr()
    command.upgrade(config, "0008")
    # alembic.ini logs `alembic.*` at INFO to stderr: codes and counts only.
    report = capsys.readouterr().err

    with engine.connect() as connection:
        for index, (legacy, blocked, expected) in enumerate(CASES):
            tracking_id = trackings[index]
            ((state, planned, contactability),) = rows(
                connection,
                "SELECT ct.status, ct.planned_contact_at, p.contactability_status"
                " FROM contact_tracking ct JOIN prospects p ON p.id = ct.prospect_id"
                " WHERE ct.id = :id",
                id=tracking_id,
            )
            assert state == expected, (legacy, blocked)
            # The next action survives, except on the terminal `ignored`.
            assert planned == (None if expected == "ignored" else PLANNED), legacy
            assert contactability == ("do_not_contact" if blocked else "contactable")
            history = rows(
                connection,
                "SELECT from_status, to_status, actor_type, actor_id"
                " FROM contact_tracking_status_history"
                " WHERE contact_tracking_id = :id ORDER BY changed_at",
                id=tracking_id,
            )
            # The old row is untouched; a conversion appends exactly one `system` row.
            migration = (legacy, expected, "system", CONTACT_STATES_MIGRATION_ID)
            appended = [] if legacy == expected else [migration]
            assert history == [
                (None, legacy, "human", None),
                *appended,
            ]
            events = rows(
                connection,
                "SELECT actor_type, actor_id, subject_type, action, changes, context"
                " FROM audit_log WHERE entity_type = 'contact_tracking' AND entity_id = :id",
                id=tracking_id,
            )
            if legacy == expected:
                assert events == []
                continue
            ((actor_type, actor_id, subject, action, changes, context),) = events
            assert (actor_type, actor_id, subject, action) == (
                "system",
                CONTACT_STATES_MIGRATION_ID,
                "prospect",
                "contact_tracking.status_changed",
            )
            assert isinstance(changes, dict) and isinstance(context, dict)
            assert changes["status"] == {"before": legacy, "after": expected}
            assert ("planned_contact_at" in changes) is (expected == "ignored")
            assert context["source"] == "cli"
        default = rows(
            connection,
            "SELECT column_default FROM information_schema.columns"
            " WHERE table_name = 'contact_tracking' AND column_name = 'status'",
        )
        assert default == [("'neutral'::character varying",)]
    assert "9 tracking row(s) converted" in report
    assert "'not_interested': 2" in report and "'failure': 1" in report
    # The opposed `to_contact` became neutral: listed for review, not changed.
    assert "1 do_not_contact prospect(s) neither ignored nor failure" in report


def test_0008_refuses_legacy_codes_after_the_upgrade(engine: Engine) -> None:
    with engine.connect() as connection:
        transaction = connection.begin()
        try:
            prospect_id = uuid.uuid4()
            connection.execute(
                text("INSERT INTO prospects (id, last_name) VALUES (:id, 'Refus')"),
                {"id": prospect_id},
            )
            with pytest.raises(IntegrityError, match="ck_contact_tracking_status"):
                connection.execute(
                    text(
                        "INSERT INTO contact_tracking (prospect_id, status)"
                        " VALUES (:id, 'follow_up_1')"
                    ),
                    {"id": prospect_id},
                )
        finally:
            transaction.rollback()


def test_0008_downgrade_maps_back_then_upgrade_again(
    engine: Engine, migration_database: str
) -> None:
    config = alembic_config(migration_database)
    command.downgrade(config, "0007")
    with engine.begin() as connection:
        trackings = seed_legacy(connection)
    command.upgrade(config, "0008")
    # A later human change on the converted `failure` row (new codes in history).
    with engine.begin() as connection:
        connection.execute(
            text("UPDATE contact_tracking SET status = 'r2' WHERE id = :id"), {"id": trackings[9]}
        )
        connection.execute(
            text(
                "INSERT INTO contact_tracking_status_history"
                " (contact_tracking_id, from_status, to_status, actor_type, actor_display)"
                " VALUES (:id, 'failure', 'r2', 'human', 'Opératrice Test')"
            ),
            {"id": trackings[9]},
        )

    command.downgrade(config, "0007")

    with engine.connect() as connection:
        states = statuses(connection)
        assert [states[trackings[index]] for index in range(len(CASES))] == [
            "to_contact",
            "contacted",
            "follow_up_1",
            "follow_up_2",
            "response_received",
            "appointment_obtained",
            "appointment_obtained",
            "appointment_obtained",
            "appointment_obtained",
            "follow_up_2",
            "not_interested",
            "to_contact",
        ]
        system_rows = rows(
            connection,
            "SELECT count(*) FROM contact_tracking_status_history WHERE actor_id = :id",
            id=CONTACT_STATES_MIGRATION_ID,
        )
        assert system_rows == [(0,)]
        later = rows(
            connection,
            "SELECT from_status, to_status FROM contact_tracking_status_history"
            " WHERE contact_tracking_id = :id ORDER BY changed_at",
            id=trackings[9],
        )
        assert later == [(None, "not_interested"), ("not_interested", "follow_up_2")]
        audit = rows(connection, "SELECT count(*) FROM audit_log")
        assert audit == [(9,)]  # append-only: the upgrade's events stay

    command.upgrade(config, "head")

    with engine.connect() as connection:
        states = statuses(connection)
        # Migration 0010 then turns the state `r2` into three sends of a sequence (`neutral`).
        assert states[trackings[9]] == "neutral"
        assert states[trackings[10]] == "ignored"
        converted = rows(
            connection,
            "SELECT count(*) FROM contact_tracking_status_history WHERE actor_id = :id",
            id=CONTACT_STATES_MIGRATION_ID,
        )
        assert converted == [(6,)]  # quotes and wins stayed `appointment_obtained`
        assert rows(
            connection,
            "SELECT count(*) FROM audit_log WHERE actor_id = :id",
            id=CONTACT_STATES_MIGRATION_ID,
        ) == [(15,)]  # 0010 then writes its own events
