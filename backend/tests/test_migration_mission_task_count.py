"""Migration 0065: objectives become a number of tasks, open runs keep what they promised, a
discovery run chaining towards N items receives the missing tasks, finished one-offs close.

The down/up test migrates the shared `*_test` database, so it rebuilds the schema when it ends.
"""

import json
from collections.abc import Iterator

import pytest
from alembic import command
from sqlalchemy import Connection, Engine, text

from tests.support import alembic_config, reset_database


@pytest.fixture
def migration_database(engine: Engine, test_database_url: str) -> Iterator[str]:
    try:
        yield test_database_url
    finally:
        reset_database(engine, test_database_url)


def _mission(
    connection: Connection,
    name: str,
    *,
    objective: dict[str, object] | None = None,
    allow_multiple: bool = False,
    recurring: bool = False,
    kind: str = "prospection",
    result_kind: str = "companies",
) -> object:
    return connection.execute(
        text(
            "INSERT INTO missions (name, type, prompt, result_kind, result_limit, "
            "allow_multiple, objective, is_recurring, created_by_type, created_by_display) "
            "VALUES (:name, :kind, 'Consigne', :result_kind, 20, :multiple, "
            "CAST(:objective AS jsonb), :recurring, 'system', 'Test') RETURNING id"
        ),
        {
            "name": name,
            "kind": kind,
            "result_kind": result_kind,
            "multiple": allow_multiple,
            "objective": json.dumps(objective) if objective else None,
            "recurring": recurring,
        },
    ).scalar_one()


def _run(connection: Connection, mission: object, config: dict[str, object], status: str) -> object:
    return connection.execute(
        text(
            "INSERT INTO mission_runs (mission_id, status, config) "
            "VALUES (:mission, :status, CAST(:config AS jsonb)) RETURNING id"
        ),
        {"mission": mission, "status": status, "config": json.dumps(config)},
    ).scalar_one()


def _task(connection: Connection, run: object, status: str) -> object:
    claim = ""
    values = ""
    if status == "claimed":
        claim = ", claim_id, claimed_at, lease_expires_at, claimed_by_label"
        values = ", gen_random_uuid(), now(), now() + interval '15 minutes', 'Agent'"
    return connection.execute(
        text(
            f"INSERT INTO agent_tasks (run_id, type, status{claim}) "
            f"VALUES (:run, 'find_prospects', :status{values}) RETURNING id"
        ),
        {"run": run, "status": status},
    ).scalar_one()


def test_0065_maps_the_objectives_and_keeps_open_runs_working(
    engine: Engine, migration_database: str
) -> None:
    config = alembic_config(migration_database)
    command.downgrade(config, "0063")
    goal = {"kind": "accepted_items", "count": 5}
    with engine.begin() as connection:
        chained = _mission(connection, "Chaîne", objective=goal)
        chained_run = _run(
            connection,
            chained,
            {"result_limit": 20, "allow_multiple": False, "objective": goal, "prompt": "p"},
            "running",
        )
        accepted = _task(connection, chained_run, "accepted")
        connection.execute(
            text(
                "INSERT INTO agent_task_results (task_id, submitted_by_label, raw, digest, "
                "status, decided_at, accepted_items) VALUES (:task, 'Agent', '{}', "
                "repeat('a', 64), 'accepted', now(), CAST(:items AS jsonb))"
            ),
            {"task": accepted, "items": json.dumps({"keys": ["a", "b"]})},
        )
        held = _task(connection, chained_run, "claimed")

        listed = _mission(connection, "Liste", allow_multiple=True)
        listed_run = _run(connection, listed, {"result_limit": 20, "allow_multiple": True}, "done")
        _task(connection, listed_run, "failed")

        recurring = _mission(connection, "Hebdomadaire", recurring=True)
        recurring_run = _run(connection, recurring, {"result_limit": 20}, "done")
        _task(connection, recurring_run, "accepted")

    command.upgrade(config, "0065")

    with engine.connect() as connection:
        missions = {
            row.name: (row.task_count, row.status)
            for row in connection.execute(text("SELECT name, task_count, status FROM missions"))
        }
        configs = dict(
            connection.execute(text("SELECT id, config FROM mission_runs")).tuples().all()
        )
        statuses = sorted(
            connection.execute(
                text("SELECT status FROM agent_tasks WHERE run_id = :run"), {"run": chained_run}
            ).scalars()
        )
        claim = connection.execute(
            text("SELECT status, claim_id FROM agent_tasks WHERE id = :id"), {"id": held}
        ).one()

    assert missions["Chaîne"] == (5, "active")
    assert missions["Liste"] == (1, "done")  # one-off, every task finished
    assert missions["Hebdomadaire"] == (1, "active")
    # 5 wanted, 2 already accepted, 1 held: 2 tasks added; the held claim is untouched.
    assert statuses == ["accepted", "claimed", "pending", "pending"]
    assert claim.status == "claimed" and claim.claim_id is not None
    assert configs[chained_run] == {"prompt": "p", "task_count": 4, "items_per_task": 1}
    assert configs[listed_run] == {"task_count": 1, "items_per_task": 20}
    # A snapshot without the switch predates it: the list form it was claimed under.
    assert configs[recurring_run] == {"task_count": 1, "items_per_task": 20}
