"""Agent capabilities: `mcp_tokens.provider`, `mode` and `capabilities`.

A token stays the agent's identity (decision 2 of the ChatGPT handoff). Existing tokens become
workers with a worker's capabilities, so nothing changes for them; tokens minted by an OAuth
approval become interactive assistants with every capability (their effective set is then bounded
by the approving person's role), and their provider is read from the OAuth client's name.

Revision ID: 0025
Revises: 0024
Create Date: 2026-11-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen copies of `app.services.agent_capabilities` at this revision.
WORKER = '["tasks.work", "records.read", "records.propose"]'
INTERACTIVE = (
    '["tasks.work", "records.read", "records.propose", "dashboard.read", "missions.read", '
    '"missions.write", "missions.run", "missions.pause", "missions.cancel", "reviews.read", '
    '"contact.read", "contact.draft"]'
)


def upgrade() -> None:
    op.add_column(
        "mcp_tokens", sa.Column("provider", sa.String(32), server_default="other", nullable=False)
    )
    op.add_column(
        "mcp_tokens", sa.Column("mode", sa.String(32), server_default="worker", nullable=False)
    )
    op.add_column(
        "mcp_tokens",
        sa.Column(
            "capabilities",
            postgresql.JSONB(),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
    )
    op.create_check_constraint(
        op.f("ck_mcp_tokens_provider"),
        "mcp_tokens",
        "provider IN ('chatgpt', 'claude', 'chatx', 'other')",
    )
    op.create_check_constraint(
        op.f("ck_mcp_tokens_mode"), "mcp_tokens", "mode IN ('interactive', 'worker', 'scheduled')"
    )
    op.execute(f"UPDATE mcp_tokens SET capabilities = '{WORKER}'::jsonb")
    op.execute(
        f"""
        UPDATE mcp_tokens t
        SET mode = 'interactive',
            capabilities = '{INTERACTIVE}'::jsonb,
            provider = CASE
                WHEN lower(c.client_name) LIKE '%chatgpt%' OR lower(c.client_name) LIKE '%openai%'
                    THEN 'chatgpt'
                WHEN lower(c.client_name) LIKE '%chatx%' THEN 'chatx'
                WHEN lower(c.client_name) LIKE '%claude%' OR lower(c.client_name) LIKE '%anthropic%'
                    THEN 'claude'
                ELSE 'other'
            END
        FROM oauth_authorizations a
        JOIN oauth_clients c ON c.id = a.client_pk
        WHERE a.mcp_token_id = t.id
        """
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_mcp_tokens_mode"), "mcp_tokens", type_="check")
    op.drop_constraint(op.f("ck_mcp_tokens_provider"), "mcp_tokens", type_="check")
    op.drop_column("mcp_tokens", "capabilities")
    op.drop_column("mcp_tokens", "mode")
    op.drop_column("mcp_tokens", "provider")
