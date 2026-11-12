"""Mission telemetry: an agent's session in a run, and its append-only activity log.

Contract: `doc/architecture/mission-telemetry.md`. Telemetry observes agent work; it never decides,
applies or replaces a result. Neither table carries an `organization_id`: the organization of a row
is the organization of its `mission_id` (children inherit it, `OrganizationOwnedMixin` is for root
tables). Sessions and logs disappear only through the cascade of deleting their mission or run.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin, text_enum
from app.models.enums import (
    MissionAgentDisconnectReason,
    MissionAgentLogEvent,
    MissionAgentSessionStatus,
)

AGENT_ID_MAX_LENGTH = 128
AGENT_LABEL_MAX_LENGTH = 255
LOG_MESSAGE_MAX_LENGTH = 1000
LOG_SOURCE_URL_MAX_LENGTH = 2048


class MissionAgentSession(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One participation of one agent in one run; at most one `active` per (run, agent)."""

    __tablename__ = "mission_agent_sessions"
    __table_args__ = (
        # `active` <=> still open: no end date, no reason.
        CheckConstraint(
            "(status = 'active') = (ended_at IS NULL AND disconnect_reason IS NULL)",
            name="end_matches_status",
        ),
        # §3.2: the database, not the code alone, keeps one active session per (run, agent).
        Index(
            "uq_mission_agent_sessions_active",
            "run_id",
            "agent_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
        # The timeout sweep (§4) reads only active sessions, oldest activity first.
        Index(
            "ix_mission_agent_sessions_active_last_seen",
            "last_seen_at",
            postgresql_where=text("status = 'active'"),
        ),
        Index("ix_mission_agent_sessions_mission_started", "mission_id", "started_at"),
        Index("ix_mission_agent_sessions_run_started", "run_id", "started_at"),
    )

    mission_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("missions.id", ondelete="CASCADE"))
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mission_runs.id", ondelete="CASCADE"))
    # `McpToken.id` as a string (the `claimed_by_id` convention); label snapshotted at open.
    agent_id: Mapped[str] = mapped_column(String(AGENT_ID_MAX_LENGTH))
    agent_label: Mapped[str] = mapped_column(String(AGENT_LABEL_MAX_LENGTH))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # Last mission activity; drives the 3 h timeout. Never moves backwards.
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[MissionAgentSessionStatus] = mapped_column(
        text_enum(MissionAgentSessionStatus, "status"),
        server_default=MissionAgentSessionStatus.ACTIVE.value,
    )
    disconnect_reason: Mapped[MissionAgentDisconnectReason | None] = mapped_column(
        text_enum(MissionAgentDisconnectReason, "disconnect_reason")
    )


class MissionAgentLog(UUIDPrimaryKeyMixin, Base):
    """One factual event of an agent's work. Append-only: a database trigger refuses UPDATE,
    TRUNCATE and DELETE (except the cascade of a deleted mission, run or session, and the
    `task_id` SET NULL of a deleted task). A correction is a new row."""

    __tablename__ = "mission_agent_logs"
    __table_args__ = (
        CheckConstraint(
            f"btrim(message) <> '' AND char_length(message) <= {LOG_MESSAGE_MAX_LENGTH}",
            name="message_valid",
        ),
        CheckConstraint("source_url IS NULL OR source_url ~ '^https?://'", name="source_url_http"),
        # The mission stream, newest first (cursor pagination), and its per-run / per-session cuts.
        Index(
            "ix_mission_agent_logs_mission_created",
            "mission_id",
            text("created_at DESC"),
            text("id DESC"),
        ),
        Index(
            "ix_mission_agent_logs_run_created", "run_id", text("created_at DESC"), text("id DESC")
        ),
        Index(
            "ix_mission_agent_logs_session_created",
            "session_id",
            text("created_at DESC"),
            text("id DESC"),
        ),
        Index("ix_mission_agent_logs_task_id", "task_id"),
    )

    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mission_agent_sessions.id", ondelete="CASCADE")
    )
    # Denormalised from the session for mission-wide queries.
    mission_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("missions.id", ondelete="CASCADE"))
    run_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("mission_runs.id", ondelete="CASCADE"))
    task_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agent_tasks.id", ondelete="SET NULL")
    )
    # Copied from the session; never client-supplied.
    agent_id: Mapped[str] = mapped_column(String(AGENT_ID_MAX_LENGTH))
    event_type: Mapped[MissionAgentLogEvent] = mapped_column(
        text_enum(MissionAgentLogEvent, "event_type")
    )
    message: Mapped[str] = mapped_column(Text)
    source_url: Mapped[str | None] = mapped_column(String(LOG_SOURCE_URL_MAX_LENGTH))
    # The source's own stated date (§5.3): never invented, never the retrieval date.
    source_published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), sort_order=1
    )
    # `metadata` is reserved by SQLAlchemy's declarative base: the column keeps the contract name.
    details: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, server_default=text("'{}'::jsonb")
    )
