"""Agent identity: an owner-relative instance number on every live MCP token (Slice 03).

`mcp_tokens.instance_number` is the `#N` of « Claude lucie #2 »: unique among the live tokens of
one (owner, provider); a revoked token keeps its number for history but frees it for the next one.
Live tokens are numbered by creation order.

Revision ID: 0048
Revises: 0047
"""
import sqlalchemy as sa
from alembic import op

revision = '0048'
down_revision = '0047'
branch_labels = None
depends_on = None

INDEX = 'uq_mcp_tokens_live_instance'


def upgrade() -> None:
    op.add_column('mcp_tokens', sa.Column('instance_number', sa.Integer(), nullable=True))
    op.create_check_constraint(
        op.f('ck_mcp_tokens_instance_number_positive'),
        'mcp_tokens',
        'instance_number IS NULL OR instance_number >= 1',
    )
    op.execute(
        """
        UPDATE mcp_tokens t SET instance_number = r.n
        FROM (
            SELECT id, row_number() OVER (
                PARTITION BY coalesce(owner_email, ''), provider ORDER BY created_at, id
            ) AS n
            FROM mcp_tokens WHERE revoked_at IS NULL
        ) r
        WHERE t.id = r.id
        """
    )
    op.create_index(
        INDEX,
        'mcp_tokens',
        [sa.text("coalesce(owner_email, '')"), 'provider', 'instance_number'],
        unique=True,
        postgresql_where=sa.text('revoked_at IS NULL AND instance_number IS NOT NULL'),
    )


def downgrade() -> None:
    op.drop_index(INDEX, table_name='mcp_tokens')
    op.drop_constraint(op.f('ck_mcp_tokens_instance_number_positive'), 'mcp_tokens', type_='check')
    op.drop_column('mcp_tokens', 'instance_number')
