"""Separate individual human review from batch scheduling.

Revision ID: 0042
Revises: 0041
"""
import sqlalchemy as sa
from alembic import op

revision = '0042'
down_revision = '0041'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('warehouse_drafts', sa.Column(
        'human_validated', sa.Boolean(), nullable=False, server_default=sa.false(),
    ))
    # Preserve explicit human validations from the audit log; batch scheduling uses a
    # different action and must not count as a review. A later human edit requires review.
    op.execute("""
        UPDATE warehouse_drafts d SET human_validated = true
        WHERE EXISTS (
            SELECT 1 FROM audit_log v
            WHERE v.entity_type = 'warehouse_draft' AND v.entity_id = d.id
              AND v.action = 'warehouse_draft.validated' AND v.actor_type = 'human'
              AND NOT EXISTS (
                  SELECT 1 FROM audit_log e
                  WHERE e.entity_type = 'warehouse_draft' AND e.entity_id = d.id
                    AND e.action = 'warehouse_draft.updated' AND e.actor_type = 'human'
                    AND e.occurred_at > v.occurred_at
              )
        )
    """)


def downgrade() -> None:
    op.drop_column('warehouse_drafts', 'human_validated')
