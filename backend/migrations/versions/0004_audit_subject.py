"""Audit subject: the prospect/company whose history an event belongs to (Task 05, ADR-0006).

`entity_*` names the row that changed (an email); `subject_*` the record whose history shows it
(the email's prospect). Adding nullable columns rewrites no row, so the append-only triggers are
not involved.

Revision ID: 0004
Revises: 0003
Create Date: 2026-09-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("audit_log", sa.Column("subject_type", sa.String(64), nullable=True))
    op.add_column("audit_log", sa.Column("subject_id", sa.Uuid(), nullable=True))
    op.create_index(
        op.f("ix_audit_log_subject_type_subject_id_occurred_at"),
        "audit_log",
        ["subject_type", "subject_id", "occurred_at"],
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_audit_log_subject_type_subject_id_occurred_at"), "audit_log")
    op.drop_column("audit_log", "subject_id")
    op.drop_column("audit_log", "subject_type")
