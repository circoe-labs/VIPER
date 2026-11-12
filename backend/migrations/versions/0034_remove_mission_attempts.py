"""Remove mission attempt limits while keeping all submitted results."""

import sqlalchemy as sa
from alembic import op

revision = "0034"
down_revision = "0033"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_index("uq_agent_task_results_attempt", table_name="agent_task_results")
    op.create_index("ix_agent_task_results_task_id", "agent_task_results", ["task_id"])
    op.drop_constraint(
        op.f("ck_agent_task_results_attempt_positive"), "agent_task_results", type_="check"
    )
    op.drop_column("agent_task_results", "attempt")
    op.drop_constraint(op.f("ck_agent_tasks_attempts_valid"), "agent_tasks", type_="check")
    op.drop_column("agent_tasks", "max_attempts")
    op.drop_column("agent_tasks", "attempts")


def downgrade() -> None:
    op.add_column(
        "agent_tasks", sa.Column("attempts", sa.SmallInteger(), nullable=False, server_default="0")
    )
    op.add_column(
        "agent_tasks",
        sa.Column("max_attempts", sa.SmallInteger(), nullable=False, server_default="3"),
    )
    op.create_check_constraint(
        op.f("ck_agent_tasks_attempts_valid"), "agent_tasks", "attempts >= 0 AND max_attempts >= 1"
    )
    op.add_column("agent_task_results", sa.Column("attempt", sa.SmallInteger(), nullable=True))
    op.execute("""UPDATE agent_task_results AS r SET attempt = ranked.number
        FROM (SELECT id, row_number() OVER
                     (PARTITION BY task_id ORDER BY submitted_at, id) AS number
              FROM agent_task_results) AS ranked WHERE r.id = ranked.id""")
    op.alter_column("agent_task_results", "attempt", nullable=False)
    op.create_check_constraint(
        op.f("ck_agent_task_results_attempt_positive"), "agent_task_results", "attempt >= 1"
    )
    op.drop_index("ix_agent_task_results_task_id", table_name="agent_task_results")
    op.create_index(
        "uq_agent_task_results_attempt", "agent_task_results", ["task_id", "attempt"], unique=True
    )
