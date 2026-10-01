"""Prospection counters and pages, Home and the Contact planning stay interactive on a synthetic
base far above V1 scale — whatever the planner's statistics say (ADR-0019).

The seed is uncommitted (the test transaction is rolled back), which production rows never are, so
each service is measured in the three planner states a real base goes through:

- **without statistics** — straight after a bulk load, before autoanalyze: the planner knows the
  tables' page counts and nothing about their columns;
- **emptied by a vacuum** — a VACUUM that runs while rows are being written counts none of them
  and records `reltuples = 0` on full pages: until the next ANALYZE the planner believes every
  table is empty. Autovacuum did exactly that to this test (the previous test's rolled-back rows
  made it vacuum the tables while this one's seed was uncommitted) and Home took 250-310 s. Here
  the VACUUM runs on purpose, from a second connection;
- **analyzed** — the steady state autoanalyze maintains in production.

Autovacuum may still run at any moment of the test; it can only produce the second state. The base
keeps its 20 000 prospects on CI: the plans this test guards against are quadratic, and a base ten
times smaller would hide them under the budget.
"""

import time
from collections.abc import Callable, Iterator

from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.orm import Session

PROSPECTS = 20_000
# Generous for shared CI runners; locally each call takes a few tens to hundreds of milliseconds.
BUDGET_SECONDS = 2.0
SEEDED_TABLES = "companies, prospects, emails, contact_tracking, contact_tracking_status_history"


def seed_base(db_session: Session) -> None:
    db_session.execute(
        text(
            "INSERT INTO companies (display_name)"
            " SELECT 'Entreprise synthétique ' || g FROM generate_series(1, 200) AS g"
        )
    )
    db_session.execute(
        text(
            "WITH numbered AS"
            " (SELECT id, row_number() OVER (ORDER BY display_name) - 1 AS n FROM companies)"
            " INSERT INTO prospects (company_id, first_name, last_name, activity_status,"
            " employment_verified_at)"
            " SELECT numbered.id, 'Prénom' || g, 'Nom' || (g % 997),"
            " (ARRAY['active', 'inactive', 'unknown'])[g % 3 + 1],"
            " CASE WHEN g % 2 = 0 THEN now() - (g % 400) * interval '1 day' END"
            " FROM generate_series(1, :rows) AS g JOIN numbered ON numbered.n = g % 200"
        ),
        {"rows": PROSPECTS},
    )
    db_session.execute(
        text(
            "INSERT INTO emails"
            " (prospect_id, address, is_primary, verification_status, origin_type)"
            " SELECT id, 'personne' || row_number() OVER () || '@exemple.example', true,"
            " (ARRAY['unverified', 'verified', 'invalid', 'unknown'])[(random() * 3)::int + 1],"
            " 'imported' FROM prospects"
        )
    )
    db_session.execute(
        text(
            "INSERT INTO contact_tracking (prospect_id, status)"
            " SELECT id, (ARRAY['neutral', 'neutral', 'response_received', 'appointment_obtained'])"
            "[(random() * 3)::int + 1] FROM prospects TABLESAMPLE BERNOULLI (60)"
        )
    )
    # Ten weekly cohorts; most prospects in one, with up to three real sends (sequences rework).
    db_session.execute(
        text(
            "INSERT INTO cohorts (code, starts_on)"
            " SELECT 'S' || g, current_date - g * 7 FROM generate_series(1, 10) AS g"
        )
    )
    db_session.execute(
        text(
            "INSERT INTO contact_sequences (prospect_id, cohort_id)"
            " SELECT p.id, c.id FROM prospects p"
            " JOIN cohorts c ON c.code = 'S' || (1 + abs(hashtext(p.id::text)) % 10)"
            " WHERE random() < 0.7"
        )
    )
    db_session.execute(
        text(
            "INSERT INTO contact_messages (prospect_id, sequence_id, rank, status, sent_at,"
            " sent_source) SELECT s.prospect_id, s.id, r, 'sent',"
            " now() - (5 - r) * interval '7 days', 'migration'"
            " FROM contact_sequences s CROSS JOIN generate_series(0, 2) AS r WHERE random() < 0.5"
        )
    )
    # Every tracking entered its stage at some point of the last 200 days.
    db_session.execute(
        text(
            "INSERT INTO contact_tracking_status_history"
            " (contact_tracking_id, to_status, changed_at, actor_type, actor_display)"
            " SELECT id, status, now() - (random() * 200)::int * interval '1 day', 'human',"
            " 'Opératrice synthétique' FROM contact_tracking"
        )
    )


def seed_audit_log(db_session: Session) -> None:
    """The events such a base leaves: human saves on some prospects, then an import event for
    every seeded prospect, e-mail and tracking — newer than every save Home's feed looks for."""
    event = (
        "INSERT INTO audit_log (occurred_at, actor_type, actor_id, actor_display, entity_type,"
        " entity_id, subject_type, subject_id, action, changes, context)"
    )
    db_session.execute(
        text(
            f"{event} SELECT now() - interval '1 day' + row_number() OVER () * interval '1 second',"
            " 'human', 'synthetic-user', 'Opératrice synthétique', 'prospect', id, 'prospect', id,"
            " 'update', jsonb_build_object('exact_job_title',"
            " jsonb_build_object('before', null, 'after', 'Poste')),"
            " jsonb_build_object('source', 'ui', 'request_id', CAST(id AS text))"
            " FROM prospects TABLESAMPLE BERNOULLI (1)"
        )
    )
    for table, entity_type, subject in (
        ("prospects", "prospect", "id"),
        ("emails", "email", "prospect_id"),
        ("contact_tracking", "contact_tracking", "prospect_id"),
    ):
        db_session.execute(
            text(
                f"{event} SELECT clock_timestamp(), 'import', 'synthetic-batch',"
                f" 'Import synthétique.xlsx', '{entity_type}', id, 'prospect', {subject},"
                " 'create', '{}', jsonb_build_object('source', 'import')"
                f" FROM {table}"
            )
        )


def planner_states(db_session: Session, engine: Engine) -> Iterator[str]:
    """Yields once per planner state of the seeded rows (see the module docstring)."""
    yield "without statistics"
    with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as connection:
        connection.execute(text(f"VACUUM {SEEDED_TABLES}"))
    yield "emptied by a vacuum"
    db_session.execute(text(f"ANALYZE {SEEDED_TABLES}"))
    yield "analyzed"


def timed[T](call: Callable[[], T]) -> tuple[T, float]:
    started = time.perf_counter()
    response = call()
    return response, time.perf_counter() - started


def test_counters_and_deep_page_on_20k_prospects(
    client: TestClient, db_session: Session, engine: Engine
) -> None:
    seed_base(db_session)

    for state in planner_states(db_session, engine):
        counters, counters_elapsed = timed(
            lambda: client.get("/api/prospection/counters", params={"q": "nom1"})
        )
        page, page_elapsed = timed(
            lambda: client.get(
                "/api/prospection/prospects",
                params={
                    "segment": "contacted",
                    "sort": "planned_contact",
                    "offset": 5_000,
                    "limit": 50,
                },
            )
        )

        assert counters.status_code == page.status_code == 200
        assert counters.json()["counts"]["all"] > 0
        assert len(page.json()["items"]) == 50
        assert counters_elapsed < BUDGET_SECONDS, f"{state}: counters took {counters_elapsed:.2f}s"
        assert page_elapsed < BUDGET_SECONDS, f"{state}: page took {page_elapsed:.2f}s"


def test_home_on_20k_prospects(client: TestClient, db_session: Session, engine: Engine) -> None:
    seed_base(db_session)
    seed_audit_log(db_session)

    for state in planner_states(db_session, engine):
        home, elapsed = timed(lambda: client.get("/api/home"))

        assert home.status_code == 200
        assert sum(month["contacted"] for month in home.json()["progress"]["months"]) > 0
        assert len(home.json()["recent_edits"]) == 8
        assert elapsed < BUDGET_SECONDS, f"{state}: home took {elapsed:.2f}s"


def test_contact_planning_on_20k_prospects(
    client: TestClient, db_session: Session, engine: Engine
) -> None:
    """The weekly planning (sequences rework S3): its counts, cohorts and weeks in four
    statements, and a deep page of a list, over the same base (ten cohorts, up to three sends)."""
    seed_base(db_session)

    for state in planner_states(db_session, engine):
        planning, planning_elapsed = timed(lambda: client.get("/api/contact/dashboard"))
        page, page_elapsed = timed(
            lambda: client.get(
                "/api/contact/prospects",
                params={"category": "in_sequence", "offset": 2_000, "limit": 50},
            )
        )

        assert planning.status_code == page.status_code == 200
        assert planning.json()["to_send"]["total"] > 0
        assert len(planning.json()["cohorts"]) == 10
        assert len(page.json()["items"]) == 50
        assert planning_elapsed < BUDGET_SECONDS, f"{state}: planning took {planning_elapsed:.2f}s"
        assert page_elapsed < BUDGET_SECONDS, f"{state}: page took {page_elapsed:.2f}s"
