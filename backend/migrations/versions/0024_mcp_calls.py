"""MCP call history: `mcp_calls`, and the person behind each agent token (`owner_email`).

`owner_email` of the tokens approved through OAuth is filled from the approving account; the
command-line tokens stay without one until set. Purely additive.

Revision ID: 0024
Revises: 0023
Create Date: 2026-11-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

CIRCOE_ID = "01a00000-0000-7000-8000-00000000c1c0"


def upgrade() -> None:
    op.add_column("mcp_tokens", sa.Column("owner_email", sa.String(320), nullable=True))
    op.execute(
        "UPDATE mcp_tokens t SET owner_email = u.email "
        "FROM oauth_authorizations a JOIN users u ON u.id = a.user_id "
        "WHERE a.mcp_token_id = t.id"
    )
    op.create_table(
        "mcp_calls",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column(
            "organization_id",
            sa.Uuid(),
            server_default=sa.text(f"'{CIRCOE_ID}'::uuid"),
            nullable=False,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("token_id", sa.Uuid(), nullable=True),
        sa.Column("token_label", sa.String(100), nullable=False),
        sa.Column("user_email", sa.String(320), nullable=True),
        sa.Column("tool", sa.String(100), nullable=False),
        sa.Column(
            "arguments", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False
        ),
        sa.Column("outcome", sa.String(16), nullable=False),
        sa.Column("error_code", sa.String(64), nullable=True),
        sa.Column("error_message", sa.String(500), nullable=True),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.CheckConstraint(
            "outcome IN ('ok', 'refused', 'error')", name=op.f("ck_mcp_calls_outcome_valid")
        ),
        sa.ForeignKeyConstraint(
            ["token_id"],
            ["mcp_tokens.id"],
            name=op.f("fk_mcp_calls_token_id_mcp_tokens"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["organizations.id"],
            name=op.f("fk_mcp_calls_organization_id_organizations"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_mcp_calls")),
    )
    op.create_index(op.f("ix_mcp_calls_token_id"), "mcp_calls", ["token_id"])
    op.create_index(op.f("ix_mcp_calls_organization_id"), "mcp_calls", ["organization_id"])
    op.create_index("ix_mcp_calls_created_at", "mcp_calls", ["created_at"])
    op.create_index("ix_mcp_calls_user_email_created_at", "mcp_calls", ["user_email", "created_at"])


def downgrade() -> None:
    op.drop_table("mcp_calls")
    op.drop_column("mcp_tokens", "owner_email")
