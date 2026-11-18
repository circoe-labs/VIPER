"""Score reassessment (S4): the `reassess_score` task type and `missions.task_type`.

A one-off mission bound to a prospect can force the task its run creates (`missions.task_type`);
`reassess_score` addresses a prospect (the company is not required).

Revision ID: 0056
Revises: 0055
"""

import sqlalchemy as sa
from alembic import op

revision = "0056"
down_revision = "0055"
branch_labels = None
depends_on = None

# Frozen literals: migrations never import application code (ADR-0002).
OLD_TYPES = (
    "update_company",
    "update_employee",
    "find_employees",
    "surveil_signals",
    "find_prospects",
)
NEW_TYPES = (*OLD_TYPES, "reassess_score")
COMPANY_TASK_TYPES = "('update_company', 'find_employees', 'surveil_signals')"
OLD_SUBJECT = (
    "("
    f"type IN {COMPANY_TASK_TYPES}"
    " AND company_id IS NOT NULL AND prospect_id IS NULL"
    ") OR (type = 'update_employee' AND prospect_id IS NOT NULL AND company_id IS NOT NULL"
    ") OR (type = 'find_prospects' AND company_id IS NULL AND prospect_id IS NULL)"
)
NEW_SUBJECT = OLD_SUBJECT[:-1] + ") OR (type = 'reassess_score' AND prospect_id IS NOT NULL)"


def _values(values: tuple[str, ...]) -> str:
    return ", ".join(repr(value) for value in values)


def _swap_task_checks(types: tuple[str, ...], subject: str) -> None:
    op.drop_constraint(op.f("ck_agent_tasks_type"), "agent_tasks", type_="check")
    op.drop_constraint(op.f("ck_agent_tasks_subject_per_type"), "agent_tasks", type_="check")
    op.create_check_constraint(
        op.f("ck_agent_tasks_type"), "agent_tasks", f"type IN ({_values(types)})"
    )
    op.create_check_constraint(op.f("ck_agent_tasks_subject_per_type"), "agent_tasks", subject)


def upgrade() -> None:
    _swap_task_checks(NEW_TYPES, NEW_SUBJECT)
    op.add_column("missions", sa.Column("task_type", sa.String(32), nullable=True))
    op.create_check_constraint(
        op.f("ck_missions_task_type"), "missions", f"task_type IN ({_values(NEW_TYPES)})"
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_missions_task_type"), "missions", type_="check")
    op.drop_column("missions", "task_type")
    op.execute("DELETE FROM agent_tasks WHERE type = 'reassess_score'")
    _swap_task_checks(OLD_TYPES, OLD_SUBJECT)
