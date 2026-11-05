"""Missions: the persistent rule, its executions, and the records it works on.

A **mission** is what a person writes once (« Nouveaux entrepôts — Normandie »): a name, a type, a
consigne, an agent, linked VIPER records, a recurrence and the expected result. A **run**
(`mission_runs`) is one occurrence of that rule — the unit the page shows as « dernière exécution :
7 résultats ». A **target** (`mission_targets`) links the mission to existing companies or
prospects by id; the consigne is never a copy of the record, so the agent can re-read the live row.

The tasks an agent claims stay `agent_tasks`; a task born from a run carries `run_id` and has no
`thread_id`. Nothing here writes to the domain: accepted results still go through
`app.services.agent_review`.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.actor import ActorType
from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin, text_enum
from app.models.enums import (
    MissionEndKind,
    MissionResultKind,
    MissionRunStatus,
    MissionRunTrigger,
    MissionStatus,
    MissionType,
    RecurrenceUnit,
)
from app.models.organizations import OrganizationOwnedMixin

NAME_MAX_LENGTH = 200
PROMPT_MAX_LENGTH = 5000
GEOGRAPHY_MAX_LENGTH = 200
AGENT_LABEL_MAX_LENGTH = 255
ACTOR_ID_MAX_LENGTH = 128
RESULT_LIMIT_MAX = 500
PERIOD_DAYS_MAX = 3650
INTERVAL_MAX = 1000
MAX_RUNS_MAX = 1000


class Mission(UUIDPrimaryKeyMixin, OrganizationOwnedMixin, TimestampMixin, Base):
    """The rule a person writes once: what to look for, on which records, how often."""

    __tablename__ = "missions"
    __table_args__ = (
        CheckConstraint(
            f"btrim(name) <> '' AND char_length(name) <= {NAME_MAX_LENGTH}", name="name_valid"
        ),
        CheckConstraint(
            f"btrim(prompt) <> '' AND char_length(prompt) <= {PROMPT_MAX_LENGTH}",
            name="prompt_valid",
        ),
        CheckConstraint(f"result_limit BETWEEN 1 AND {RESULT_LIMIT_MAX}", name="limit_range"),
        CheckConstraint(
            f"period_days IS NULL OR period_days BETWEEN 1 AND {PERIOD_DAYS_MAX}",
            name="period_range",
        ),
        CheckConstraint(f"interval_count BETWEEN 1 AND {INTERVAL_MAX}", name="interval_range"),
        CheckConstraint("end_kind <> 'date' OR ends_at IS NOT NULL", name="end_date_required"),
        CheckConstraint("end_kind <> 'after' OR max_runs IS NOT NULL", name="end_runs_required"),
        Index("ix_missions_status", "status"),
        Index("ix_missions_next_run_at", "next_run_at"),
    )

    name: Mapped[str] = mapped_column(String(NAME_MAX_LENGTH))
    type: Mapped[MissionType] = mapped_column(text_enum(MissionType, "type"))
    prompt: Mapped[str] = mapped_column(Text)
    status: Mapped[MissionStatus] = mapped_column(
        text_enum(MissionStatus, "status"), server_default=MissionStatus.ACTIVE.value
    )
    # NULL = « Automatique » : any agent whose scopes allow the generated task may take it.
    agent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("mcp_tokens.id", ondelete="SET NULL"), index=True
    )
    # Snapshotted so the card survives a revoked token.
    agent_label: Mapped[str | None] = mapped_column(String(AGENT_LABEL_MAX_LENGTH))
    is_recurring: Mapped[bool] = mapped_column(Boolean, server_default=text("false"))
    interval_count: Mapped[int] = mapped_column(SmallInteger, server_default="1")
    interval_unit: Mapped[RecurrenceUnit] = mapped_column(
        text_enum(RecurrenceUnit, "interval_unit"), server_default=RecurrenceUnit.DAYS.value
    )
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    end_kind: Mapped[MissionEndKind] = mapped_column(
        text_enum(MissionEndKind, "end_kind"), server_default=MissionEndKind.NEVER.value
    )
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    max_runs: Mapped[int | None] = mapped_column(Integer)
    result_kind: Mapped[MissionResultKind] = mapped_column(
        text_enum(MissionResultKind, "result_kind")
    )
    result_limit: Mapped[int] = mapped_column(SmallInteger, server_default="20")
    geography: Mapped[str | None] = mapped_column(String(GEOGRAPHY_MAX_LENGTH))
    period_days: Mapped[int | None] = mapped_column(SmallInteger)
    # Free-form advanced exclusions: {"known_companies": true, "domains": ["…"]}.
    exclusions: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_type: Mapped[ActorType] = mapped_column(text_enum(ActorType, "created_by_type"))
    created_by_id: Mapped[str | None] = mapped_column(String(ACTOR_ID_MAX_LENGTH))
    created_by_display: Mapped[str] = mapped_column(String(AGENT_LABEL_MAX_LENGTH))


class MissionTarget(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A linked VIPER record: a reference, never a copy of the row."""

    __tablename__ = "mission_targets"
    __table_args__ = (
        CheckConstraint("num_nonnulls(company_id, prospect_id) = 1", name="exactly_one_subject"),
        Index(
            "uq_mission_targets_company",
            "mission_id",
            "company_id",
            unique=True,
            postgresql_where=text("company_id IS NOT NULL"),
        ),
        Index(
            "uq_mission_targets_prospect",
            "mission_id",
            "prospect_id",
            unique=True,
            postgresql_where=text("prospect_id IS NOT NULL"),
        ),
    )

    mission_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("missions.id", ondelete="CASCADE"), index=True
    )
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True
    )
    prospect_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("prospects.id", ondelete="CASCADE"), index=True
    )


class MissionRun(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One occurrence of a mission: what the page shows as « exécution »."""

    __tablename__ = "mission_runs"
    __table_args__ = (Index("ix_mission_runs_mission_scheduled", "mission_id", "scheduled_at"),)

    mission_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("missions.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[MissionRunStatus] = mapped_column(
        text_enum(MissionRunStatus, "status"), server_default=MissionRunStatus.SCHEDULED.value
    )
    trigger: Mapped[MissionRunTrigger] = mapped_column(
        text_enum(MissionRunTrigger, "trigger"), server_default=MissionRunTrigger.MANUAL.value
    )
    scheduled_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    tasks_total: Mapped[int] = mapped_column(Integer, server_default="0")
    results_count: Mapped[int] = mapped_column(Integer, server_default="0")
    # Why a run could not start (an unsupported type today), readable on the card.
    note: Mapped[str | None] = mapped_column(Text)
