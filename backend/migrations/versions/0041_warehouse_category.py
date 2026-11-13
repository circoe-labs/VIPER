"""Add prospecting categories to warehouse sites.

Revision ID: 0041
Revises: 0040
"""
import sqlalchemy as sa
from alembic import op

revision = '0041'
down_revision = '0040'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('warehouses', sa.Column('prospecting_category', sa.String(20)))
    op.create_check_constraint(
        'ck_warehouses_prospecting_category', 'warehouses',
        "prospecting_category IS NULL OR prospecting_category IN ('sme', 'other')",
    )


def downgrade() -> None:
    op.drop_constraint('ck_warehouses_prospecting_category', 'warehouses', type_='check')
    op.drop_column('warehouses', 'prospecting_category')
