"""Agent missions: the work VIPER hands to autonomous agents, and the results a person reviews.

A **thread** (`agent_threads`) is one « Analyse »: a company to complete, or a prospecting brief.
A **task** (`agent_tasks`) is one unit of work an agent claims under a lease — `claim_id` rotates
at each claim, `lease_expires_at` bounds it, `SKIP LOCKED` makes concurrent claims safe. A
**result** (`agent_task_results`) is one submission, immutable and kept per attempt; it is a
proposal until a person accepts it.

Nothing in this module writes to the domain: applying an accepted result is
`app.services.agent_missions`, through the ordinary company/prospect services, with the validating
person as actor. Contract and rationale: `doc/architecture/agent-missions.md`.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
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
    AgentResultStatus,
    AgentTaskStatus,
    AgentTaskType,
    AgentThreadKind,
    AgentThreadStatus,
)
from app.models.organizations import OrganizationOwnedMixin

THREAD_TITLE_MAX_LENGTH = 200
AGENT_LABEL_MAX_LENGTH = 255
ACTOR_ID_MAX_LENGTH = 128
FAILURE_CODE_MAX_LENGTH = 64
DIGEST_LENGTH = 64
PRIORITY_MIN = -100
PRIORITY_MAX = 100

# Statuses in which a task still occupies its subject: the creation-level duplicate guard.
OPEN_TASK_STATUSES = "('pending', 'claimed', 'submitted')"
_TASK_TYPES_WITH_COMPANY = "('update_company', 'find_employees', 'surveil_signals')"


class AgentThread(UUIDPrimaryKeyMixin, OrganizationOwnedMixin, TimestampMixin, Base):
    """One « Analyse » card: a company to complete, or a prospecting brief.

    `title` is a snapshot of the company's display name so the card survives a rename; the company
    stays the source of truth (`company_id`).
    """

    __tablename__ = "agent_threads"
    __table_args__ = (
        # A company review always names its company; a search brief never names one.
        CheckConstraint(
            "(kind = 'company_review') = (company_id IS NOT NULL)", name="kind_has_company"
        ),
        CheckConstraint(
            f"btrim(title) <> '' AND char_length(title) <= {THREAD_TITLE_MAX_LENGTH}",
            name="title_valid",
        ),
        CheckConstraint(
            f"priority BETWEEN {PRIORITY_MIN} AND {PRIORITY_MAX}", name="priority_range"
        ),
        # One open review per company: asking twice completes the same thread instead of opening a
        # second one (the first of the three duplicate guards, agent-missions.md §10).
        Index(
            "uq_agent_threads_open_company",
            "company_id",
            unique=True,
            postgresql_where=text("kind = 'company_review' AND status IN ('open', 'paused')"),
        ),
        Index("ix_agent_threads_status", "status"),
    )

    kind: Mapped[AgentThreadKind] = mapped_column(text_enum(AgentThreadKind, "kind"))
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), index=True
    )
    title: Mapped[str] = mapped_column(String(THREAD_TITLE_MAX_LENGTH))
    status: Mapped[AgentThreadStatus] = mapped_column(
        text_enum(AgentThreadStatus, "status"), server_default="open"
    )
    # `prospect_search` only: sector, geography, size, roles, the signal sought.
    brief: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    priority: Mapped[int] = mapped_column(SmallInteger, server_default="0")
    note: Mapped[str | None] = mapped_column(Text)
    # Who opened it: snapshotted, never a client-supplied value.
    created_by_type: Mapped[ActorType] = mapped_column(text_enum(ActorType, "created_by_type"))
    created_by_id: Mapped[str | None] = mapped_column(String(ACTOR_ID_MAX_LENGTH))
    created_by_display: Mapped[str] = mapped_column(String(AGENT_LABEL_MAX_LENGTH))


class AgentTask(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One unit of work, claimed under a lease by one agent.

    `attempts` counts the claims, not the successes: a task that keeps dying on its agent ends up
    `failed` instead of looping. A lease that expires returns the task to `pending` without
    touching `attempts` — the claim already counted it.
    """

    __tablename__ = "agent_tasks"
    __table_args__ = (
        # The subject each type addresses (agent-missions.md §4.2).
        CheckConstraint(
            "("
            f"type IN {_TASK_TYPES_WITH_COMPANY}"
            " AND company_id IS NOT NULL AND prospect_id IS NULL"
            ") OR (type = 'update_employee' AND prospect_id IS NOT NULL AND company_id IS NOT NULL"
            ") OR (type = 'find_prospects' AND company_id IS NULL AND prospect_id IS NULL)",
            name="subject_per_type",
        ),
        # A claim exists exactly while the task is claimed.
        CheckConstraint(
            "(status = 'claimed') = (claim_id IS NOT NULL)", name="claim_id_matches_status"
        ),
        CheckConstraint(
            "status <> 'claimed' OR (claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL"
            " AND claimed_by_label IS NOT NULL)",
            name="claim_is_complete",
        ),
        CheckConstraint("attempts >= 0 AND max_attempts >= 1", name="attempts_valid"),
        CheckConstraint(
            f"priority BETWEEN {PRIORITY_MIN} AND {PRIORITY_MAX}", name="priority_range"
        ),
        # Third duplicate guard: one open task per (type, subject). Three partial indexes instead
        # of one composite: PostgreSQL treats NULLs as distinct, so a single index would let two
        # company tasks coexist through their NULL `prospect_id`.
        Index(
            "uq_agent_tasks_open_company_task",
            "type",
            "company_id",
            unique=True,
            postgresql_where=text(
                f"status IN {OPEN_TASK_STATUSES} AND company_id IS NOT NULL AND prospect_id IS NULL"
                " AND run_id IS NULL"
            ),
        ),
        Index(
            "uq_agent_tasks_open_prospect_task",
            "prospect_id",
            unique=True,
            postgresql_where=text(
                f"status IN {OPEN_TASK_STATUSES} AND prospect_id IS NOT NULL AND run_id IS NULL"
            ),
        ),
        Index(
            "uq_agent_tasks_open_thread_task",
            "thread_id",
            unique=True,
            postgresql_where=text(
                f"status IN {OPEN_TASK_STATUSES} AND type = 'find_prospects' AND run_id IS NULL"
            ),
        ),
        Index("ix_agent_tasks_queue", "status", "priority", "created_at"),
    )

    # A legacy « Analyse » thread, or NULL for a task born from a mission run.
    thread_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("agent_threads.id", ondelete="CASCADE"), index=True
    )
    # The execution of a mission this task belongs to (NULL for a tool-mode proposal).
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("mission_runs.id", ondelete="SET NULL"), index=True
    )
    # When the mission names an agent, only that token may claim the task (« Automatique »: NULL).
    assigned_agent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("mcp_tokens.id", ondelete="SET NULL"), index=True
    )
    type: Mapped[AgentTaskType] = mapped_column(text_enum(AgentTaskType, "type"))
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True
    )
    prospect_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("prospects.id", ondelete="CASCADE"), index=True
    )
    status: Mapped[AgentTaskStatus] = mapped_column(
        text_enum(AgentTaskStatus, "status"), server_default="pending"
    )
    priority: Mapped[int] = mapped_column(SmallInteger, server_default="0")
    attempts: Mapped[int] = mapped_column(SmallInteger, server_default="0")
    max_attempts: Mapped[int] = mapped_column(SmallInteger, server_default="3")
    # Rotates at each claim: a submission must carry the current one (exactly-once submit).
    claim_id: Mapped[uuid.UUID | None] = mapped_column()
    claimed_by_id: Mapped[str | None] = mapped_column(String(ACTOR_ID_MAX_LENGTH))
    claimed_by_label: Mapped[str | None] = mapped_column(String(AGENT_LABEL_MAX_LENGTH))
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    failure_code: Mapped[str | None] = mapped_column(String(FAILURE_CODE_MAX_LENGTH))
    failure_message: Mapped[str | None] = mapped_column(Text)


class AgentTaskResult(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One submission: what the agent sent, what VIPER made of it, and the person's decision.

    `raw` is kept exactly as validated; `proposal` is VIPER's normalised reading (field changes,
    items to create, signals). `digest` binds the review to the payload that was submitted.
    """

    __tablename__ = "agent_task_results"
    __table_args__ = (
        # One submission per attempt, and at most one awaiting review at a time.
        Index("uq_agent_task_results_attempt", "task_id", "attempt", unique=True),
        Index(
            "uq_agent_task_results_pending",
            "task_id",
            unique=True,
            postgresql_where=text("status = 'pending_review'"),
        ),
        # A decision exists exactly when the result is no longer awaiting one.
        CheckConstraint(
            "(status = 'pending_review') = (decided_at IS NULL)", name="decision_matches_status"
        ),
        CheckConstraint("attempt >= 1", name="attempt_positive"),
        CheckConstraint(f"char_length(digest) = {DIGEST_LENGTH}", name="digest_length"),
        Index("ix_agent_task_results_submitted_at", "submitted_at"),
    )

    # Covered by `uq_agent_task_results_attempt`, which starts with this column.
    task_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("agent_tasks.id", ondelete="CASCADE"))
    attempt: Mapped[int] = mapped_column(SmallInteger)
    submitted_by_id: Mapped[str | None] = mapped_column(String(ACTOR_ID_MAX_LENGTH))
    submitted_by_label: Mapped[str] = mapped_column(String(AGENT_LABEL_MAX_LENGTH))
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    raw: Mapped[dict[str, Any]] = mapped_column(JSONB)
    proposal: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    digest: Mapped[str] = mapped_column(String(DIGEST_LENGTH))
    status: Mapped[AgentResultStatus] = mapped_column(
        text_enum(AgentResultStatus, "status"), server_default="pending_review"
    )
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decided_by_id: Mapped[str | None] = mapped_column(String(ACTOR_ID_MAX_LENGTH))
    decided_by_display: Mapped[str | None] = mapped_column(String(AGENT_LABEL_MAX_LENGTH))
    decision_note: Mapped[str | None] = mapped_column(Text)
    # The item keys accepted, with the person's overrides; `applied` what was really written.
    accepted_items: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    applied: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
