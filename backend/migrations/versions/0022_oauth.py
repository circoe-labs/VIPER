"""OAuth for the MCP endpoint: `oauth_clients`, `oauth_authorizations`, `oauth_tokens`.

Connectors (ChatGPT, claude.ai…) register themselves, get the person's approval and trade a
one-time code for short access tokens and rotated refresh tokens. Only hashes are stored. Purely
additive: the downgrade drops the three tables.

Revision ID: 0022
Revises: 0021
Create Date: 2026-11-03
"""

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _timestamps() -> list[sa.Column[Any]]:
    return [
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    ]


def _trigger(table: str) -> None:
    op.execute(
        f"CREATE TRIGGER set_updated_at BEFORE UPDATE ON {table} "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )


def upgrade() -> None:
    op.create_table(
        "oauth_clients",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("client_id", sa.String(64), nullable=False),
        sa.Column("client_name", sa.String(100), nullable=False),
        sa.Column("redirect_uris", postgresql.JSONB(), nullable=False),
        sa.Column("auth_method", sa.String(32), nullable=False),
        sa.Column("secret_hash", sa.String(64), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "btrim(client_name) <> '' AND char_length(client_name) <= 100",
            name=op.f("ck_oauth_clients_client_name_valid"),
        ),
        sa.CheckConstraint(
            "auth_method IN ('none', 'client_secret_post', 'client_secret_basic')",
            name=op.f("ck_oauth_clients_auth_method_valid"),
        ),
        sa.CheckConstraint(
            "(auth_method = 'none') = (secret_hash IS NULL)",
            name=op.f("ck_oauth_clients_secret_matches_auth_method"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oauth_clients")),
        sa.UniqueConstraint("client_id", name=op.f("uq_oauth_clients_client_id")),
    )
    _trigger("oauth_clients")

    op.create_table(
        "oauth_authorizations",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("client_pk", sa.Uuid(), nullable=False),
        sa.Column("redirect_uri", sa.String(2000), nullable=False),
        sa.Column("state", sa.String(2000), nullable=True),
        sa.Column("code_challenge", sa.String(128), nullable=False),
        sa.Column("scope", sa.Text(), nullable=True),
        sa.Column("resource", sa.String(2000), nullable=True),
        sa.Column("status", sa.String(16), server_default="pending", nullable=False),
        sa.Column("code_hash", sa.String(64), nullable=True),
        sa.Column("user_id", sa.Uuid(), nullable=True),
        sa.Column("mcp_token_id", sa.Uuid(), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        *_timestamps(),
        sa.CheckConstraint(
            "status IN ('pending', 'approved', 'denied', 'used')",
            name=op.f("ck_oauth_authorizations_status_valid"),
        ),
        sa.CheckConstraint(
            "status NOT IN ('approved', 'used') OR (code_hash IS NOT NULL "
            "AND mcp_token_id IS NOT NULL)",
            name=op.f("ck_oauth_authorizations_approval_is_complete"),
        ),
        sa.ForeignKeyConstraint(
            ["client_pk"],
            ["oauth_clients.id"],
            name=op.f("fk_oauth_authorizations_client_pk_oauth_clients"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_oauth_authorizations_user_id_users"),
            ondelete="SET NULL",
        ),
        sa.ForeignKeyConstraint(
            ["mcp_token_id"],
            ["mcp_tokens.id"],
            name=op.f("fk_oauth_authorizations_mcp_token_id_mcp_tokens"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oauth_authorizations")),
        sa.UniqueConstraint("code_hash", name=op.f("uq_oauth_authorizations_code_hash")),
    )
    op.create_index(
        op.f("ix_oauth_authorizations_client_pk"), "oauth_authorizations", ["client_pk"]
    )
    op.create_index(op.f("ix_oauth_authorizations_user_id"), "oauth_authorizations", ["user_id"])
    op.create_index(
        op.f("ix_oauth_authorizations_mcp_token_id"), "oauth_authorizations", ["mcp_token_id"]
    )
    op.create_index("ix_oauth_authorizations_expires_at", "oauth_authorizations", ["expires_at"])
    _trigger("oauth_authorizations")

    op.create_table(
        "oauth_tokens",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("client_pk", sa.Uuid(), nullable=False),
        sa.Column("mcp_token_id", sa.Uuid(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "kind IN ('access', 'refresh')", name=op.f("ck_oauth_tokens_kind_valid")
        ),
        sa.ForeignKeyConstraint(
            ["client_pk"],
            ["oauth_clients.id"],
            name=op.f("fk_oauth_tokens_client_pk_oauth_clients"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["mcp_token_id"],
            ["mcp_tokens.id"],
            name=op.f("fk_oauth_tokens_mcp_token_id_mcp_tokens"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_oauth_tokens")),
        sa.UniqueConstraint("token_hash", name=op.f("uq_oauth_tokens_token_hash")),
    )
    op.create_index(op.f("ix_oauth_tokens_client_pk"), "oauth_tokens", ["client_pk"])
    op.create_index(op.f("ix_oauth_tokens_mcp_token_id"), "oauth_tokens", ["mcp_token_id"])
    op.create_index("ix_oauth_tokens_expires_at", "oauth_tokens", ["expires_at"])
    _trigger("oauth_tokens")


def downgrade() -> None:
    op.drop_table("oauth_tokens")
    op.drop_table("oauth_authorizations")
    op.drop_table("oauth_clients")
