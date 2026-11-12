"""Schedule warehouse drafts through the configured mail dispatcher.

Revision ID: 0035
Revises: 0034
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0035"
down_revision: str | None = "0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("warehouse_drafts", sa.Column("scheduled_at", sa.DateTime(timezone=True)))
    op.add_column("warehouse_drafts", sa.Column("send_state", sa.String(30)))
    op.add_column("warehouse_drafts", sa.Column("remote_draft_id", sa.String(255)))


def downgrade() -> None:
    op.drop_column("warehouse_drafts", "remote_draft_id")
    op.drop_column("warehouse_drafts", "send_state")
    op.drop_column("warehouse_drafts", "scheduled_at")
