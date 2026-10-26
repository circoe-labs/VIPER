"""A person's verdict on a Contact message's text (« relu : correct / à revoir »).

Adds `review_verdict`, `reviewed_revision`, `reviewed_at` and `reviewed_by_display` to
`contact_messages`, with their checks: a verdict is `correct` or `to_revise`, and its revision and
moment come with it. Purely additive; the downgrade drops the columns.

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-14
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen literal: migrations never import application code (ADR-0002).
TABLE = "contact_messages"


def upgrade() -> None:
    op.add_column(TABLE, sa.Column("review_verdict", sa.String(16), nullable=True))
    op.add_column(TABLE, sa.Column("reviewed_revision", sa.Integer(), nullable=True))
    op.add_column(TABLE, sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(TABLE, sa.Column("reviewed_by_display", sa.String(255), nullable=True))
    op.create_check_constraint(
        op.f(f"ck_{TABLE}_review_verdict"),
        TABLE,
        "review_verdict IN ('correct', 'to_revise') OR review_verdict IS NULL",
    )
    op.create_check_constraint(
        op.f(f"ck_{TABLE}_review_complete"),
        TABLE,
        "(review_verdict IS NULL) = (reviewed_revision IS NULL) "
        "AND (review_verdict IS NULL) = (reviewed_at IS NULL)",
    )


def downgrade() -> None:
    op.drop_constraint(op.f(f"ck_{TABLE}_review_complete"), TABLE, type_="check")
    op.drop_constraint(op.f(f"ck_{TABLE}_review_verdict"), TABLE, type_="check")
    for column in ("reviewed_by_display", "reviewed_at", "reviewed_revision", "review_verdict"):
        op.drop_column(TABLE, column)
