"""Machine credentials: the tokens an agent uses to reach VIPER's MCP endpoint.

Only the SHA-256 of the token is stored, like `user_sessions` does for a cookie: a database dump
does not hand anyone a working credential. A token carries the task types it may claim and the
number of tasks it may hold at once — an agent scoped to `update_employee` never sees a company
task. `scopes = ["*"]` means every type.

Tokens are minted by `python -m app.cli create-agent-token` and revoked by setting `revoked_at`;
they are never exposed by the API, never audited (they are secrets) and never shown in the
explorer. Contract: `doc/architecture/mcp-server.md` §4.2.
"""

from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, SmallInteger, String, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin

TOKEN_HASH_LENGTH = 64
LABEL_MAX_LENGTH = 100
DEFAULT_MAX_CONCURRENT = 3


class McpToken(UUIDPrimaryKeyMixin, TimestampMixin, Base):
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
