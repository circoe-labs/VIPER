"""Mission output contract: `allow_multiple`, the machine-evaluable objective, run objective stamp.

Revision ID: 0049
Revises: 0048

Slice 04 of `viper_mission_agent_configuration_v2`. Chain: 0046 -> 0047 (categories, Slice 01)
-> 0048 (agent identity, Slice 03) -> 0049 (this one). Independent of their tables.

Missions that exist keep the list envelope they always had (`allow_multiple = true`); a new
mission defaults to one item at a time.
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = '0049'
down_revision = '0048'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        'missions',
        sa.Column('allow_multiple', sa.Boolean(), server_default=sa.text('false'), nullable=False),
    )
    op.execute('UPDATE missions SET allow_multiple = true')
    op.add_column('missions', sa.Column('objective', postgresql.JSONB(), nullable=True))
    op.add_column(
        'mission_runs', sa.Column('objective_met_at', sa.DateTime(timezone=True), nullable=True)
    )


def downgrade() -> None:
    op.drop_column('mission_runs', 'objective_met_at')
    op.drop_column('missions', 'objective')
    op.drop_column('missions', 'allow_multiple')
