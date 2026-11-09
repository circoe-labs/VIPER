"""Add human review and concurrency protection to warehouse drafts.

Revision ID: 0034
Revises: 0033
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0034"
down_revision: str | None = "0033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("warehouse_drafts", sa.Column("revision", sa.Integer(), nullable=False, server_default="1"))
    op.add_column("warehouse_drafts", sa.Column("validated_at", sa.DateTime(timezone=True)))
    op.add_column("warehouse_drafts", sa.Column("validated_by", sa.String(255)))


def downgrade() -> None:
    op.drop_column("warehouse_drafts", "validated_by")
    op.drop_column("warehouse_drafts", "validated_at")
    op.drop_column("warehouse_drafts", "revision")
