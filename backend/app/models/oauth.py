"""OAuth 2.1 for the MCP endpoint: how ChatGPT, claude.ai and other connectors get an agent token.

A connector registers itself (`oauth_clients`, RFC 7591), sends the person to VIPER to approve
(`oauth_authorizations`: the pending request, then its one-time code), and trades the code for an
access token and a refresh token (`oauth_tokens`). An approval mints an ordinary `mcp_tokens` row:
the connector is one more agent, with the same scopes, audit identity and revocation as a token
made in the command line. Revoking that row ends every OAuth token derived from it.

Only SHA-256 hashes of secrets are stored (client secrets, codes, tokens), never the values.
Contract: `doc/architecture/mcp-server.md` §4.5.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin

HASH_LENGTH = 64
CLIENT_ID_MAX_LENGTH = 64
CLIENT_NAME_MAX_LENGTH = 100
URI_MAX_LENGTH = 2000
STATE_MAX_LENGTH = 2000
CHALLENGE_MAX_LENGTH = 128


class OAuthClient(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A connector that registered itself (dynamic client registration)."""

    __tablename__ = "oauth_clients"
    __table_args__ = (
        CheckConstraint(
            f"btrim(client_name) <> '' AND char_length(client_name) <= {CLIENT_NAME_MAX_LENGTH}",
            name="client_name_valid",
        ),
        CheckConstraint(
            "auth_method IN ('none', 'client_secret_post', 'client_secret_basic')",
            name="auth_method_valid",
        ),
        CheckConstraint(
            "(auth_method = 'none') = (secret_hash IS NULL)", name="secret_matches_auth_method"
        ),
    )

    client_id: Mapped[str] = mapped_column(String(CLIENT_ID_MAX_LENGTH), unique=True)
    client_name: Mapped[str] = mapped_column(String(CLIENT_NAME_MAX_LENGTH))
    redirect_uris: Mapped[list[Any]] = mapped_column(JSONB)
    auth_method: Mapped[str] = mapped_column(String(32))
    secret_hash: Mapped[str | None] = mapped_column(String(HASH_LENGTH))


class OAuthAuthorization(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One « Autoriser … ? » request: pending, then approved (with its one-time code) or denied."""

    __tablename__ = "oauth_authorizations"
    __table_args__ = (
        CheckConstraint("status IN ('pending', 'approved', 'denied', 'used')", name="status_valid"),
        CheckConstraint(
            "status NOT IN ('approved', 'used') OR (code_hash IS NOT NULL "
            "AND mcp_token_id IS NOT NULL)",
            name="approval_is_complete",
        ),
        Index("ix_oauth_authorizations_expires_at", "expires_at"),
    )

    client_pk: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("oauth_clients.id", ondelete="CASCADE"), index=True
    )
    redirect_uri: Mapped[str] = mapped_column(String(URI_MAX_LENGTH))
    state: Mapped[str | None] = mapped_column(String(STATE_MAX_LENGTH))
    code_challenge: Mapped[str] = mapped_column(String(CHALLENGE_MAX_LENGTH))
    scope: Mapped[str | None] = mapped_column(Text)
    resource: Mapped[str | None] = mapped_column(String(URI_MAX_LENGTH))
    status: Mapped[str] = mapped_column(String(16), server_default="pending")
    code_hash: Mapped[str | None] = mapped_column(String(HASH_LENGTH), unique=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    mcp_token_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("mcp_tokens.id", ondelete="CASCADE"), index=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class OAuthToken(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """An access token (short) or a refresh token (long, rotated at each use)."""

    __tablename__ = "oauth_tokens"
    __table_args__ = (
        CheckConstraint("kind IN ('access', 'refresh')", name="kind_valid"),
        Index("ix_oauth_tokens_expires_at", "expires_at"),
    )

    token_hash: Mapped[str] = mapped_column(String(HASH_LENGTH), unique=True)
    kind: Mapped[str] = mapped_column(String(16))
    client_pk: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("oauth_clients.id", ondelete="CASCADE"), index=True
    )
    mcp_token_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mcp_tokens.id", ondelete="CASCADE"), index=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
