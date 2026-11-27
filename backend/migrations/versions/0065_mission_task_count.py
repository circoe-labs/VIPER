"""Missions: « Nombre de tâches » replaces the objective, the result limit and the list switch.

A run now holds one task per wanted item (`missions.task_count`).

Existing missions:
- objective « a number of accepted items » (N): `task_count` = N;
- otherwise: the number of tasks a run already created (1, or one per linked company / record);
- finding people at linked companies: never fewer than one task per company.

Existing runs keep what they promised: each snapshot gets `items_per_task` (the old cap when the
list form was allowed, else 1), so a task already claimed submits as it was told to. A mission
whose running discovery runs chained one task at a time towards N items receives its missing tasks
once, in the latest of those runs.
One-off active missions with every task finished are closed (the new rule).

Revision ID: 0065
Revises: 0064
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0065"
down_revision = "0064"
branch_labels = None
depends_on = None

COMPANIES = (
    "(SELECT count(*) FROM mission_targets t "
    "WHERE t.mission_id = m.id AND t.company_id IS NOT NULL)"
)
TARGETS = "(SELECT count(*) FROM mission_targets t WHERE t.mission_id = m.id)"

TASK_COUNTS = f"""
UPDATE missions m SET task_count = LEAST(500, GREATEST(1,
    CASE
        WHEN m.is_deposit THEN 1
        WHEN m.type = 'prospection' THEN
            GREATEST(
                CASE WHEN m.objective->>'kind' = 'accepted_items'
                     THEN (m.objective->>'count')::int ELSE 1 END,
                {COMPANIES})
        WHEN {TARGETS} = 0 THEN
            CASE WHEN m.objective->>'kind' = 'accepted_items'
                 THEN (m.objective->>'count')::int ELSE 1 END
        WHEN m.type = 'signals' THEN {COMPANIES}
        ELSE {TARGETS}
    END))
"""

# The chain « one task after the other until N accepted items » no longer exists: a mission caught
# in it gets the tasks it still needs, once, in its most recent chaining run. N is deducted of the
# items already accepted and of the open tasks of all its runs (a recurring mission: of its
# chaining runs only, earlier occurrences had their own goal). A mission launched several times is
# therefore not topped up once per run.
TOP_UP = """
WITH chaining AS (
    SELECT r.id AS run_id, r.mission_id, r.scheduled_at, m.agent_id, m.is_recurring,
           LEAST(500, (COALESCE(r.config->'objective', m.objective)->>'count')::int) AS wanted
      FROM mission_runs r
      JOIN missions m ON m.id = r.mission_id
     WHERE r.status = 'running'
       AND m.status IN ('active', 'paused')
       AND COALESCE(r.config->'objective', m.objective)->>'kind' = 'accepted_items'
       AND EXISTS (SELECT 1 FROM agent_tasks t
                    WHERE t.run_id = r.id AND t.status IN ('pending', 'claimed', 'submitted'))
       AND NOT EXISTS (SELECT 1 FROM agent_tasks t
                        WHERE t.run_id = r.id AND t.type <> 'find_prospects')
), latest AS (
    SELECT DISTINCT ON (mission_id) *
      FROM chaining
     ORDER BY mission_id, scheduled_at DESC, run_id DESC
), shortfall AS (
    SELECT c.run_id, c.agent_id,
           c.wanted
           - (SELECT COALESCE(sum(jsonb_array_length(
                         COALESCE(res.accepted_items->'keys', '[]'::jsonb))), 0)
                FROM agent_task_results res
                JOIN agent_tasks t ON t.id = res.task_id
                JOIN mission_runs r ON r.id = t.run_id
               WHERE r.mission_id = c.mission_id AND res.status = 'accepted'
                 AND (NOT c.is_recurring OR r.id IN (SELECT run_id FROM chaining)))
           - (SELECT count(*) FROM agent_tasks t
                JOIN mission_runs r ON r.id = t.run_id
               WHERE r.mission_id = c.mission_id
                 AND t.status IN ('pending', 'claimed', 'submitted')
                 AND (NOT c.is_recurring OR r.id IN (SELECT run_id FROM chaining)))
           AS missing
      FROM latest c
)
INSERT INTO agent_tasks (run_id, type, status, priority, assigned_agent_id)
SELECT run_id, 'find_prospects', 'pending', 20, agent_id
  FROM shortfall, generate_series(1, GREATEST(shortfall.missing, 0))
"""

RUN_CONFIGS = """
UPDATE mission_runs r SET
    tasks_total = (SELECT count(*) FROM agent_tasks t WHERE t.run_id = r.id),
    config = CASE WHEN r.config IS NULL THEN NULL ELSE
        (r.config - 'result_limit' - 'allow_multiple' - 'objective')
        || jsonb_build_object(
            'task_count',
            GREATEST(1, (SELECT count(*) FROM agent_tasks t WHERE t.run_id = r.id)),
            'items_per_task',
            CASE WHEN COALESCE((r.config->>'allow_multiple')::boolean, true)
                 THEN COALESCE((r.config->>'result_limit')::int, 20) ELSE 1 END)
    END
"""

CLOSE_FINISHED = """
UPDATE missions m SET status = 'done', next_run_at = NULL
 WHERE m.status = 'active' AND NOT m.is_recurring AND NOT m.is_deposit
   AND m.next_run_at IS NULL
   AND EXISTS (SELECT 1 FROM agent_tasks t JOIN mission_runs r ON r.id = t.run_id
                WHERE r.mission_id = m.id)
   AND NOT EXISTS (SELECT 1 FROM agent_tasks t JOIN mission_runs r ON r.id = t.run_id
                    WHERE r.mission_id = m.id
                      AND t.status IN ('pending', 'claimed', 'submitted'))
"""


def upgrade() -> None:
    op.add_column(
        "missions", sa.Column("task_count", sa.SmallInteger(), server_default="1", nullable=False)
    )
    op.execute(TASK_COUNTS)
    op.create_check_constraint(
        op.f("ck_missions_task_count_range"), "missions", "task_count BETWEEN 1 AND 500"
    )
    op.execute(TOP_UP)
    op.execute(RUN_CONFIGS)
    op.execute(CLOSE_FINISHED)
    op.drop_constraint(op.f("ck_missions_limit_range"), "missions", type_="check")
    op.drop_column("missions", "result_limit")
    op.drop_column("missions", "allow_multiple")
    op.drop_column("missions", "objective")
    op.drop_column("mission_runs", "objective_met_at")


def downgrade() -> None:
    """The old columns come back with their defaults: the previous goals are not rebuilt."""
    op.add_column(
        "mission_runs", sa.Column("objective_met_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.add_column("missions", sa.Column("objective", postgresql.JSONB(), nullable=True))
    op.add_column(
        "missions",
        sa.Column("allow_multiple", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.add_column(
        "missions",
        sa.Column("result_limit", sa.SmallInteger(), server_default="20", nullable=False),
    )
    op.create_check_constraint(
        op.f("ck_missions_limit_range"), "missions", "result_limit BETWEEN 1 AND 500"
    )
    op.drop_constraint(op.f("ck_missions_task_count_range"), "missions", type_="check")
    op.drop_column("missions", "task_count")
