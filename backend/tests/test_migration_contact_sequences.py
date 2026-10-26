"""Migration 0012 (cohorts and sequences) on seeded 0009 rows: former states become sends of a
sequence in a cohort created from the planning (to review), `failure` a sequence closed
`completed`, history appended (never rewritten), existing messages attached at their rank, audit
events written; then a best-effort downgrade and a new upgrade.

The test migrates the shared `*_test` database with committed rows, so it rebuilds the schema
from scratch when it ends (every other test runs in a rolled-back transaction).
"""

import uuid
from collections.abc import Iterator
from datetime import UTC, date, datetime

import pytest
from alembic import command
from sqlalchemy import Connection, Engine, text
from sqlalchemy.exc import IntegrityError

from app.services.contact_workflow import CONTACT_SEQUENCES_MIGRATION_ID
from tests.support import alembic_config, reset_database

# Monday 5 October 2026 at Paris midnight (ISO week 41).
PLANNED = datetime(2026, 10, 4, 22, 0, tzinfo=UTC)
CONTACTED_AT = datetime(2026, 9, 8, 9, 0, tzinfo=UTC)  # Tuesday of ISO week 37
R1_AT = datetime(2026, 9, 15, 9, 0, tzinfo=UTC)
# (state, planned week?) per case.
CASES = {
    "neutral_planned": ("neutral", True),
    "neutral_unplanned": ("neutral", False),
    "contacted": ("contacted", True),
    "r1": ("r1", True),
    "r2": ("r2", False),
    "failure": ("failure", False),
    "response": ("response_received", True),
}


@pytest.fixture
def migration_database(engine: Engine, test_database_url: str) -> Iterator[str]:
    try:
        yield test_database_url
    finally:
        reset_database(engine, test_database_url)


def rows(connection: Connection, sql: str, **params: object) -> list[tuple[object, ...]]:
    return [tuple(row) for row in connection.execute(text(sql), params)]


def pairs(connection: Connection, sql: str, **params: object) -> dict[object, object]:
    return {row[0]: row[1] for row in rows(connection, sql, **params)}


def seed_0009(connection: Connection) -> dict[str, uuid.UUID]:
    """One prospect + tracking per case, with the history of its human steps; `r1` also has a
    draft Contact message and a draft R2 message (no code sent anything before 0012)."""
    prospects: dict[str, uuid.UUID] = {}
    for name, (state, planned) in CASES.items():
        prospect, tracking = uuid.uuid4(), uuid.uuid4()
        connection.execute(
            text("INSERT INTO prospects (id, last_name) VALUES (:id, :name)"),
            {"id": prospect, "name": name},
        )
        connection.execute(
            text(
                "INSERT INTO contact_tracking (id, prospect_id, status, planned_contact_at)"
                " VALUES (:id, :prospect, :status, :planned)"
            ),
            {
                "id": tracking,
                "prospect": prospect,
                "status": state,
                "planned": PLANNED if planned else None,
            },
        )
        steps: list[tuple[str | None, str, datetime]] = [
            (None, "neutral", datetime(2026, 9, 1, tzinfo=UTC))
        ]
        if state in ("contacted", "r1", "r2"):
            steps.append(("neutral", "contacted", CONTACTED_AT))
        if state in ("r1", "r2"):
            steps.append(("contacted", "r1", R1_AT))
        if state != "neutral" and state not in ("contacted", "r1"):
            steps.append((steps[-1][1], state, datetime(2026, 9, 22, 9, tzinfo=UTC)))
        for before, after, at in steps:
            connection.execute(
                text(
                    "INSERT INTO contact_tracking_status_history (contact_tracking_id,"
                    " from_status, to_status, changed_at, actor_type, actor_display)"
                    " VALUES (:id, :before, :after, :at, 'human', 'Opératrice Test')"
                ),
                {"id": tracking, "before": before, "after": after, "at": at},
            )
        prospects[name] = prospect
    for step, subject in (("contact", "Objet"), ("r2", "")):
        connection.execute(
            text(
                "INSERT INTO contact_messages (prospect_id, step, subject, body_text)"
                " VALUES (:id, :step, :subject, :body)"
            ),
            {"id": prospects["r1"], "step": step, "subject": subject, "body": subject},
        )
    return prospects


def place(connection: Connection, prospect: uuid.UUID) -> tuple[object, ...] | None:
    found = rows(
        connection,
        "SELECT c.code, c.starts_on, c.needs_review, s.is_current, s.closed_at IS NOT NULL,"
        " s.end_reason FROM contact_sequences s JOIN cohorts c ON c.id = s.cohort_id"
        " WHERE s.prospect_id = :id",
        id=prospect,
    )
    return found[0] if found else None


def sends(connection: Connection, prospect: uuid.UUID) -> list[tuple[object, ...]]:
    return rows(
        connection,
        "SELECT rank, status, sent_source, sent_at, subject FROM contact_messages"
        " WHERE prospect_id = :id ORDER BY rank",
        id=prospect,
    )


def test_0012_turns_former_states_into_sequences_and_sends(
    engine: Engine, migration_database: str, capsys: pytest.CaptureFixture[str]
) -> None:
    config = alembic_config(migration_database)
    command.downgrade(config, "0009")
    with engine.begin() as connection:
        people = seed_0009(connection)

    capsys.readouterr()
    command.upgrade(config, "0012")
    report = capsys.readouterr().err

    with engine.connect() as connection:
        states = pairs(
            connection,
            "SELECT p.last_name, ct.status FROM contact_tracking ct"
            " JOIN prospects p ON p.id = ct.prospect_id",
        )
        assert states == {
            "neutral_planned": "neutral",
            "neutral_unplanned": "neutral",
            "contacted": "neutral",
            "r1": "neutral",
            "r2": "neutral",
            "failure": "neutral",
            "response": "response_received",
        }
        # The cohort comes from the first implied send (S37), else the planned week (S41).
        assert place(connection, people["neutral_planned"]) == (
            "S41",
            date(2026, 10, 5),
            True,
            True,
            False,
            None,
        )
        assert place(connection, people["neutral_unplanned"]) is None  # not validated
        assert place(connection, people["contacted"]) == (
            "S37",
            date(2026, 9, 7),
            True,
            True,
            False,
            None,
        )
        assert place(connection, people["response"]) == (
            "S41",
            date(2026, 10, 5),
            True,
            True,
            False,
            None,
        )
        assert place(connection, people["failure"])[3:] == (True, True, "completed")  # type: ignore[index]
        # contacted = 1 send, r1 = 2, r2 = 3, dated by the history; existing messages kept.
        assert sends(connection, people["contacted"]) == [
            (0, "sent", "migration", CONTACTED_AT, "")
        ]
        assert sends(connection, people["r1"]) == [
            (0, "sent", "migration", CONTACTED_AT, "Objet"),
            (1, "sent", "migration", R1_AT, ""),
            (2, "draft", None, None, ""),
        ]
        assert [send[:3] for send in sends(connection, people["r2"])] == [
            (rank, "sent", "migration") for rank in range(3)
        ]
        assert sends(connection, people["failure"]) == []
        # History: old rows untouched, one appended `system` row per converted state.
        appended = rows(
            connection,
            "SELECT from_status, to_status FROM contact_tracking_status_history"
            " WHERE actor_type = 'system' AND actor_id = :id ORDER BY from_status",
            id=CONTACT_SEQUENCES_MIGRATION_ID,
        )
        assert appended == [
            ("contacted", "neutral"),
            ("failure", "neutral"),
            ("r1", "neutral"),
            ("r2", "neutral"),
        ]
        assert rows(
            connection,
            "SELECT count(*) FROM contact_tracking_status_history WHERE actor_type = 'human'",
        ) == [(15,)]
        actions = pairs(
            connection,
            "SELECT action, count(*) FROM audit_log WHERE actor_id = :id GROUP BY action",
            id=CONTACT_SEQUENCES_MIGRATION_ID,
        )
        assert actions == {
            "cohort.created": 3,
            "contact_sequence.created": 6,
            "contact_message.sent": 6,
            "contact_tracking.status_changed": 4,
            "contact_tracking.updated": 2,  # planned weeks dropped (neutral, response)
        }
        # `failure` had neither send nor planned week: its first history row (week 36).
        assert rows(connection, "SELECT code FROM cohorts ORDER BY code") == [
            ("S0",),
            ("S36",),
            ("S37",),
            ("S41",),
        ]
        columns = rows(
            connection,
            "SELECT column_name FROM information_schema.columns"
            " WHERE table_name IN ('contact_tracking', 'contact_messages')"
            " AND column_name IN ('planned_contact_at', 'step')",
        )
        assert columns == []
    assert "'sequences': 6" in report and "'sends_created': 5" in report


def test_0012_refuses_former_states_and_keeps_sends_immutable(engine: Engine) -> None:
    with engine.connect() as connection:
        transaction = connection.begin()
        try:
            prospect = connection.execute(
                text("INSERT INTO prospects (last_name) VALUES ('Refus') RETURNING id")
            ).scalar_one()
            with (
                pytest.raises(IntegrityError, match="ck_contact_tracking_status"),
                connection.begin_nested(),
            ):
                connection.execute(
                    text(
                        "INSERT INTO contact_tracking (prospect_id, status)"
                        " VALUES (:id, 'contacted')"
                    ),
                    {"id": prospect},
                )
            cohort = connection.execute(
                text(
                    "INSERT INTO cohorts (code, starts_on) VALUES ('S99', '2026-10-05')"
                    " RETURNING id"
                )
            ).scalar_one()
            sequence = connection.execute(
                text(
                    "INSERT INTO contact_sequences (prospect_id, cohort_id) VALUES (:p, :c)"
                    " RETURNING id"
                ),
                {"p": prospect, "c": cohort},
            ).scalar_one()
            message = connection.execute(
                text(
                    "INSERT INTO contact_messages (prospect_id, sequence_id, rank, status, sent_at,"
                    " sent_source) VALUES (:p, :s, 0, 'sent', now(), 'manual') RETURNING id"
                ),
                {"p": prospect, "s": sequence},
            ).scalar_one()
            with (
                pytest.raises(Exception, match="is sent and cannot be changed"),
                connection.begin_nested(),
            ):
                connection.execute(
                    text("UPDATE contact_messages SET sent_at = now() WHERE id = :id"),
                    {"id": message},
                )
        finally:
            transaction.rollback()


def test_0012_downgrade_maps_back_then_upgrade_again(
    engine: Engine, migration_database: str
) -> None:
    config = alembic_config(migration_database)
    command.downgrade(config, "0009")
    with engine.begin() as connection:
        people = seed_0009(connection)
    command.upgrade(config, "0012")
    # After the upgrade: a person marks Défaillant and records a send by hand.
    with engine.begin() as connection:
        connection.execute(
            text("UPDATE contact_tracking SET status = 'disqualified' WHERE prospect_id = :id"),
            {"id": people["response"]},
        )
        connection.execute(
            text(
                "INSERT INTO contact_messages (prospect_id, sequence_id, rank, status, sent_at,"
                " sent_source) SELECT prospect_id, id, 1, 'sent', now(), 'manual'"
                " FROM contact_sequences WHERE prospect_id = :id"
            ),
            {"id": people["contacted"]},
        )

    command.downgrade(config, "0009")

    with engine.connect() as connection:
        states = pairs(
            connection,
            "SELECT p.last_name, ct.status FROM contact_tracking ct"
            " JOIN prospects p ON p.id = ct.prospect_id",
        )
        assert states == {
            "neutral_planned": "neutral",
            "neutral_unplanned": "neutral",
            "contacted": "r1",  # two sends now
            "r1": "r1",
            "r2": "r2",
            "failure": "failure",
            "response": "failure",  # Défaillant
        }
        planned = pairs(
            connection,
            "SELECT p.last_name, ct.planned_contact_at FROM contact_tracking ct"
            " JOIN prospects p ON p.id = ct.prospect_id",
        )
        assert planned["neutral_planned"] == PLANNED
        assert planned["failure"] is None and planned["response"] is None
        messages = rows(
            connection,
            "SELECT step, status, cancel_reason FROM contact_messages WHERE prospect_id = :id"
            " ORDER BY step",
            id=people["r1"],
        )
        # The send with a text is kept as a cancelled message; the bare send records are gone.
        assert messages == [("contact", "cancelled", "downgrade_0012"), ("r2", "draft", None)]
        assert rows(
            connection,
            "SELECT count(*) FROM contact_tracking_status_history WHERE actor_id = :id",
            id=CONTACT_SEQUENCES_MIGRATION_ID,
        ) == [(0,)]
        assert rows(connection, "SELECT to_regclass('cohorts')") == [(None,)]

    command.upgrade(config, "head")

    with engine.connect() as connection:
        assert len(sends(connection, people["contacted"])) == 2


def test_0012_merges_a_week_number_of_two_years_into_one_cohort_to_review(
    engine: Engine, migration_database: str, capsys: pytest.CaptureFixture[str]
) -> None:
    """Decision R-10 (Q1): the code has no year, so week 41 of 2025 and of 2026 make one cohort
    `S41`, dated by the oldest Monday and flagged for review."""
    config = alembic_config(migration_database)
    command.downgrade(config, "0009")
    planned = {
        "last_year": datetime(2025, 10, 5, 22, 0, tzinfo=UTC),  # Monday 6 October 2025, W41
        "this_year": PLANNED,  # Monday 5 October 2026, W41
    }
    with engine.begin() as connection:
        people = {}
        for name, moment in planned.items():
            prospect = connection.execute(
                text("INSERT INTO prospects (last_name) VALUES (:name) RETURNING id"),
                {"name": name},
            ).scalar_one()
            connection.execute(
                text(
                    "INSERT INTO contact_tracking (prospect_id, status, planned_contact_at)"
                    " VALUES (:id, 'neutral', :planned)"
                ),
                {"id": prospect, "planned": moment},
            )
            people[name] = prospect

    capsys.readouterr()
    command.upgrade(config, "0012")
    report = capsys.readouterr().err

    with engine.connect() as connection:
        assert rows(
            connection, "SELECT code, starts_on, needs_review FROM cohorts ORDER BY code"
        ) == [
            ("S0", None, False),
            ("S41", date(2025, 10, 6), True),
        ]
        for prospect in people.values():
            assert place(connection, prospect) == (
                "S41",
                date(2025, 10, 6),
                True,
                True,
                False,
                None,
            )
    assert "'codes_over_several_weeks': 1" in report
