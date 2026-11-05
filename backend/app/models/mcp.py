"""Machine credentials: the tokens an agent uses to reach VIPER's MCP endpoint.

Only the SHA-256 of the token is stored, like `user_sessions` does for a cookie: a database dump
does not hand anyone a working credential. A token carries the task types it may claim and the
number of tasks it may hold at once — an agent scoped to `update_employee` never sees a company
task. `scopes = ["*"]` means every type.

Each token names the person it acts for (`owner_email`: who approved the OAuth connector, or the
`--owner-email` of the command line); every tool call is kept in `mcp_calls` under that address
(« Historique des appels », Paramètres > MCP).

A token is also the agent's identity (no separate principal table): `provider` says which platform
calls (ChatGPT, Claude…), `mode` the role it plays (`interactive`, `worker`, `scheduled`) and
`capabilities` what it may do, in the functional vocabulary of `app.services.agent_capabilities`.
`scopes` stays a filter on task types, distinct from the capabilities.

Tokens are minted by `python -m app.cli create-agent-token`, Paramètres > MCP, or an OAuth
approval, and revoked by setting `revoked_at`;
they are never exposed by the API, never audited (they are secrets) and never shown in the
explorer. Contract: `doc/architecture/mcp-server.md` §4.2.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin, text_enum
from app.models.enums import AgentMode, AgentProvider
from app.models.organizations import OrganizationOwnedMixin

TOKEN_HASH_LENGTH = 64
LABEL_MAX_LENGTH = 100
DEFAULT_MAX_CONCURRENT = 3
EMAIL_MAX_LENGTH = 320


class McpToken(UUIDPrimaryKeyMixin, OrganizationOwnedMixin, TimestampMixin, Base):
    __tablename__ = "mcp_tokens"
    __table_args__ = (
        CheckConstraint(
            f"btrim(label) <> '' AND char_length(label) <= {LABEL_MAX_LENGTH}",
            name="label_valid",
        ),
        CheckConstraint(f"char_length(token_hash) = {TOKEN_HASH_LENGTH}", name="token_hash_length"),
        CheckConstraint("max_concurrent >= 1", name="max_concurrent_positive"),
    )

    # What the person calls it in the interface (« Agent claude-01 »).
    label: Mapped[str] = mapped_column(String(LABEL_MAX_LENGTH))
    token_hash: Mapped[str] = mapped_column(String(TOKEN_HASH_LENGTH), unique=True)
    # Task types this token may claim; `["*"]` for all of them.
    scopes: Mapped[list[Any]] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))
    max_concurrent: Mapped[int] = mapped_column(
        SmallInteger, server_default=str(DEFAULT_MAX_CONCURRENT)
    )
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The person behind the agent: the history of calls is kept under this address.
    owner_email: Mapped[str | None] = mapped_column(String(EMAIL_MAX_LENGTH))
    # Which platform calls with this token, and the role the agent plays.
    provider: Mapped[AgentProvider] = mapped_column(
        text_enum(AgentProvider, "provider"), server_default=AgentProvider.OTHER.value
    )
    mode: Mapped[AgentMode] = mapped_column(
        text_enum(AgentMode, "mode"), server_default=AgentMode.WORKER.value
    )
    # What the agent may do (`app.services.agent_capabilities.CAPABILITIES`), before the
    # intersection with the delegated person's role.
    capabilities: Mapped[list[Any]] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))


class McpCall(UUIDPrimaryKeyMixin, OrganizationOwnedMixin, Base):
    """One `tools/call` on `/mcp`: who (the token's person and label), what, and how it ended.

    Write-once. The arguments are kept with long texts shortened (`app.services.mcp_calls`).
    """

    __tablename__ = "mcp_calls"
    __table_args__ = (
        CheckConstraint("outcome IN ('ok', 'refused', 'error')", name="outcome_valid"),
        Index("ix_mcp_calls_created_at", "created_at"),
        Index("ix_mcp_calls_user_email_created_at", "user_email", "created_at"),
    )

    # The moment of the call itself (several calls of one batch share a transaction).
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(UTC), server_default=func.now()
    )
    token_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("mcp_tokens.id", ondelete="SET NULL"), index=True
    )
    # Snapshots: the history reads the same after the token is revoked or deleted.
    token_label: Mapped[str] = mapped_column(String(LABEL_MAX_LENGTH))
    user_email: Mapped[str | None] = mapped_column(String(EMAIL_MAX_LENGTH))
    tool: Mapped[str] = mapped_column(String(100))
    arguments: Mapped[Any] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    outcome: Mapped[str] = mapped_column(String(16))
    error_code: Mapped[str | None] = mapped_column(String(64))
    error_message: Mapped[str | None] = mapped_column(String(500))
    duration_ms: Mapped[int] = mapped_column(Integer)
