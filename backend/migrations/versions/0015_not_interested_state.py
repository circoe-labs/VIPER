"""« Non intéressé » contact state.

Adds `not_interested` to the writable commercial states: the CHECK of `contact_tracking.status`
accepts it. The history CHECKs already accept the code (it was a legacy code of 0008, now current
again). Purely additive for the upgrade; the downgrade moves the rows to `disqualified` (closed,
no opposition) and restores the previous CHECK.

Revision ID: 0015
Revises: 0014
Create Date: 2026-10-12
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen literals: migrations never import application code (ADR-0002).
TABLE = "contact_tracking"
BEFORE = ("neutral", "response_received", "appointment_obtained", "ignored", "disqualified")
AFTER = (*BEFORE[:3], "not_interested", *BEFORE[3:])


def _set_check(values: Sequence[str]) -> None:
    name = op.f(f"ck_{TABLE}_status")
    listed = ", ".join(f"'{value}'" for value in values)
    op.drop_constraint(name, TABLE, type_="check")
    op.create_check_constraint(name, TABLE, f"status IN ({listed})")


def upgrade() -> None:
    _set_check(AFTER)


def downgrade() -> None:
    op.execute(f"UPDATE {TABLE} SET status = 'disqualified' WHERE status = 'not_interested'")
    _set_check(BEFORE)
