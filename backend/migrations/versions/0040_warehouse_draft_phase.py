"""Separate the original warehouse drafts from the next selection phase.

Revision ID: 0040
Revises: 0039
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = '0040'
down_revision: str | None = '0039'
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # A local development database may already have received this column under the former
    # conflicting revision 0036. Preserve those draft phases when migrating that database.
    inspector = sa.inspect(op.get_bind())
    if 'phase' not in {column['name'] for column in inspector.get_columns('warehouse_drafts')}:
        op.add_column(
            'warehouse_drafts', sa.Column('phase', sa.Integer(), nullable=False, server_default='1')
        )
    constraints = inspector.get_check_constraints('warehouse_drafts')
    if not any('phase' in (constraint.get('sqltext') or '') for constraint in constraints):
        op.create_check_constraint('ck_warehouse_drafts_phase', 'warehouse_drafts', 'phase IN (1, 2)')


def downgrade() -> None:
    op.drop_constraint('ck_warehouse_drafts_phase', 'warehouse_drafts', type_='check')
    op.drop_column('warehouse_drafts', 'phase')
