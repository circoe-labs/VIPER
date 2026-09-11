"""The Excel export and the Database Explorer on 20 000 prospects, in the three planner states of
`test_prospection_performance` (ADR-0019): without statistics, emptied by a VACUUM, analyzed.

The export reads every row of the prospect tables. Loaded by batches of 500 ids (`selectinload`),
each batch became one scan of the child table once a VACUUM had left `reltuples = 0`: 154
statements and 8-11 s in the database instead of 0.8 s, growing with the square of the base
(Task 20, decision I-155). Each child collection is now one statement joined to its parents, planned
by `whole_base_plan` — the same join unguarded took 165 s in that state. Explorer reads are
single-table statements and stay around 40 ms in every state.
"""

import time
from collections.abc import Iterator
from contextlib import contextmanager

from fastapi.testclient import TestClient
from sqlalchemy import Engine, event, text
from sqlalchemy.orm import Session

from app.services.exports.projection import load_export_data
from tests.explorer_helpers import API, condition, get_rows, group
from tests.test_prospection_performance import (
    BUDGET_SECONDS,
    PROSPECTS,
    planner_states,
    seed_base,
    timed,
)

# The projection's statements whatever the size of the base (16 today, with the plan settings).
MAX_EXPORT_STATEMENTS = 20


@contextmanager
def database_time(session: Session) -> Iterator[list[float]]:
    """Seconds spent by each statement the block sends through `session`'s connection."""
    durations: list[float] = []
    started: list[float] = []
    connection = session.connection()

    def before(*args: object) -> None:
        started.append(time.perf_counter())

    def after(*args: object) -> None:
        durations.append(time.perf_counter() - started.pop())

    event.listen(connection, "before_cursor_execute", before)
    event.listen(connection, "after_cursor_execute", after)
    try:
        yield durations
    finally:
        event.remove(connection, "before_cursor_execute", before)
        event.remove(connection, "after_cursor_execute", after)


def seed_channels_and_sources(db_session: Session) -> None:
    db_session.execute(
        text(
            "INSERT INTO phones (prospect_id, number, type, is_primary, verification_status,"
            " origin_type) SELECT id, '+3361' || lpad((row_number() OVER ())::text, 7, '0'),"
            " 'mobile', true, 'unverified', 'imported' FROM prospects"
        )
    )
    db_session.execute(
        text(
            "INSERT INTO prospect_sources (prospect_id, source_type, source_reference,"
            " actor_type, actor_display) SELECT id, 'manual', 'Saisie synthétique', 'human',"
            " 'Opératrice synthétique' FROM prospects"
        )
    )


def test_export_reads_20k_prospects_in_a_few_statements_whatever_the_statistics(
    db_session: Session, engine: Engine
) -> None:
    seed_base(db_session)
    seed_channels_and_sources(db_session)

    for state in planner_states(db_session, engine):
        db_session.expunge_all()
        with database_time(db_session) as durations:
            data = load_export_data(db_session)

        assert len(data.prospects) == PROSPECTS
        assert all(record.primary_phone is not None for record in data.prospects[:100])
        assert len(durations) <= MAX_EXPORT_STATEMENTS, f"{state}: {len(durations)} statements"
        spent = sum(durations)
        assert spent < BUDGET_SECONDS, f"{state}: the export's reads took {spent:.2f}s"


def test_explorer_reads_on_20k_prospects(
    client: TestClient, db_session: Session, engine: Engine
) -> None:
    seed_base(db_session)
    node = group(condition("last_name", "contains", "7"))

    for state in planner_states(db_session, engine):
        page, page_elapsed = timed(
            lambda: get_rows(
                client, "prospects", node=node, sort=["-last_name"], offset=2_000, limit=200
            )
        )
        tables, tables_elapsed = timed(lambda: client.get(API))

        assert len(page["rows"]) == 200
        assert tables.status_code == 200
        assert page_elapsed < BUDGET_SECONDS, f"{state}: explorer page took {page_elapsed:.2f}s"
        assert tables_elapsed < BUDGET_SECONDS, f"{state}: table list took {tables_elapsed:.2f}s"
