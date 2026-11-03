"""MCP tokens: `mcp_tokens`, the machine credentials of the agent endpoint.

Stores only the SHA-256 of each token, its task-type scopes, its concurrency cap and its
revocation date. Purely additive: the downgrade drops the table.

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "mcp_tokens",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("label", sa.String(100), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column(
            "scopes", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
        sa.Column("max_concurrent", sa.SmallInteger(), server_default="3", nullable=False),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "btrim(label) <> '' AND char_length(label) <= 100",
            name=op.f("ck_mcp_tokens_label_valid"),
        ),
        sa.CheckConstraint(
            "char_length(token_hash) = 64", name=op.f("ck_mcp_tokens_token_hash_length")
        ),
        sa.CheckConstraint(
            "max_concurrent >= 1", name=op.f("ck_mcp_tokens_max_concurrent_positive")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_mcp_tokens")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_mcp_tokens_token_hash")),
    )
    op.execute(
        "CREATE TRIGGER set_updated_at BEFORE UPDATE ON mcp_tokens "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )


def downgrade() -> None:
    op.drop_table("mcp_tokens")
