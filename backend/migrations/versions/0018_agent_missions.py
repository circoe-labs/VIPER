"""Agent missions: `agent_threads`, `agent_tasks`, `agent_task_results`.

Creates the three tables of the orchestration (`doc/architecture/agent-missions.md` §4): a thread
(« Analyse ») groups tasks, a task is claimed under a lease by one agent, a result is one immutable
submission a person accepts or rejects. Partial unique indexes carry the three duplicate guards:
one open thread per company, one open task per (type, subject), one result awaiting review per
task. Purist this way: nothing here writes to the domain; an accepted result is applied later by
`app.services.agent_missions`.

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-29
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen literals: migrations never import application code (ADR-0002).
THREAD_KINDS = ("company_review", "prospect_search")
THREAD_STATUSES = ("open", "paused", "done", "cancelled")
TASK_TYPES = (
    "update_company",
    "update_employee",
    "find_employees",
    "surveil_signals",
    "find_prospects",
)
TASK_STATUSES = ("pending", "claimed", "submitted", "accepted", "failed", "cancelled")
RESULT_STATUSES = ("pending_review", "accepted", "rejected", "superseded")
ACTOR_TYPES = ("human", "import", "system", "agent")

OPEN_TASK_STATUSES = "('pending', 'claimed', 'submitted')"
COMPANY_TASK_TYPES = "('update_company', 'find_employees', 'surveil_signals')"


def _values(values: Sequence[str]) -> str:
    return ", ".join(repr(value) for value in values)


def _updated_at_trigger(table: str) -> None:
    op.execute(
        f"CREATE TRIGGER set_updated_at BEFORE UPDATE ON {table} "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )


def upgrade() -> None:
    op.create_table(
        "agent_threads",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("company_id", sa.Uuid(), nullable=True),
        sa.Column("title", sa.String(200), nullable=False),
        sa.Column("status", sa.String(32), server_default="open", nullable=False),
        sa.Column(
            "brief", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False
        ),
        sa.Column("priority", sa.SmallInteger(), server_default="0", nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("created_by_type", sa.String(32), nullable=False),
        sa.Column("created_by_id", sa.String(128), nullable=True),
        sa.Column("created_by_display", sa.String(255), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "(kind = 'company_review') = (company_id IS NOT NULL)",
            name=op.f("ck_agent_threads_kind_has_company"),
        ),
        sa.CheckConstraint(
            "btrim(title) <> '' AND char_length(title) <= 200",
            name=op.f("ck_agent_threads_title_valid"),
        ),
        sa.CheckConstraint(
            "priority BETWEEN -100 AND 100", name=op.f("ck_agent_threads_priority_range")
        ),
        sa.CheckConstraint(
            f"kind IN ({_values(THREAD_KINDS)})", name=op.f("ck_agent_threads_kind")
        ),
        sa.CheckConstraint(
            f"status IN ({_values(THREAD_STATUSES)})", name=op.f("ck_agent_threads_status")
        ),
        sa.CheckConstraint(
            f"created_by_type IN ({_values(ACTOR_TYPES)})",
            name=op.f("ck_agent_threads_created_by_type"),
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            ondelete="RESTRICT",
            name=op.f("fk_agent_threads_company_id_companies"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_agent_threads")),
    )
    op.create_index(op.f("ix_agent_threads_company_id"), "agent_threads", ["company_id"])
    op.create_index("ix_agent_threads_status", "agent_threads", ["status"])
    op.create_index(
        "uq_agent_threads_open_company",
        "agent_threads",
        ["company_id"],
        unique=True,
        postgresql_where=sa.text("kind = 'company_review' AND status IN ('open', 'paused')"),
    )

    op.create_table(
        "agent_tasks",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("thread_id", sa.Uuid(), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("company_id", sa.Uuid(), nullable=True),
        sa.Column("prospect_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.String(32), server_default="pending", nullable=False),
        sa.Column("priority", sa.SmallInteger(), server_default="0", nullable=False),
        sa.Column("attempts", sa.SmallInteger(), server_default="0", nullable=False),
        sa.Column("max_attempts", sa.SmallInteger(), server_default="3", nullable=False),
        sa.Column("claim_id", sa.Uuid(), nullable=True),
        sa.Column("claimed_by_id", sa.String(128), nullable=True),
        sa.Column("claimed_by_label", sa.String(255), nullable=True),
        sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("lease_expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_heartbeat_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("failure_code", sa.String(64), nullable=True),
        sa.Column("failure_message", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "("
            f"type IN {COMPANY_TASK_TYPES}"
            " AND company_id IS NOT NULL AND prospect_id IS NULL"
            ") OR (type = 'update_employee' AND prospect_id IS NOT NULL AND company_id IS NOT NULL"
            ") OR (type = 'find_prospects' AND company_id IS NULL AND prospect_id IS NULL)",
            name=op.f("ck_agent_tasks_subject_per_type"),
        ),
        sa.CheckConstraint(
            "(status = 'claimed') = (claim_id IS NOT NULL)",
            name=op.f("ck_agent_tasks_claim_id_matches_status"),
        ),
        sa.CheckConstraint(
            "status <> 'claimed' OR (claimed_at IS NOT NULL AND lease_expires_at IS NOT NULL"
            " AND claimed_by_label IS NOT NULL)",
            name=op.f("ck_agent_tasks_claim_is_complete"),
        ),
        sa.CheckConstraint(
            "attempts >= 0 AND max_attempts >= 1", name=op.f("ck_agent_tasks_attempts_valid")
        ),
        sa.CheckConstraint(
            "priority BETWEEN -100 AND 100", name=op.f("ck_agent_tasks_priority_range")
        ),
        sa.CheckConstraint(f"type IN ({_values(TASK_TYPES)})", name=op.f("ck_agent_tasks_type")),
        sa.CheckConstraint(
            f"status IN ({_values(TASK_STATUSES)})", name=op.f("ck_agent_tasks_status")
        ),
        sa.ForeignKeyConstraint(
            ["thread_id"],
            ["agent_threads.id"],
            ondelete="CASCADE",
            name=op.f("fk_agent_tasks_thread_id_agent_threads"),
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            ondelete="CASCADE",
            name=op.f("fk_agent_tasks_company_id_companies"),
        ),
        sa.ForeignKeyConstraint(
            ["prospect_id"],
            ["prospects.id"],
            ondelete="CASCADE",
            name=op.f("fk_agent_tasks_prospect_id_prospects"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_agent_tasks")),
    )
    op.create_index(op.f("ix_agent_tasks_thread_id"), "agent_tasks", ["thread_id"])
    op.create_index(op.f("ix_agent_tasks_company_id"), "agent_tasks", ["company_id"])
    op.create_index(op.f("ix_agent_tasks_prospect_id"), "agent_tasks", ["prospect_id"])
    op.create_index("ix_agent_tasks_queue", "agent_tasks", ["status", "priority", "created_at"])
    op.create_index(
        "uq_agent_tasks_open_company_task",
        "agent_tasks",
        ["type", "company_id"],
        unique=True,
        postgresql_where=sa.text(
            f"status IN {OPEN_TASK_STATUSES} AND company_id IS NOT NULL AND prospect_id IS NULL"
        ),
    )
    op.create_index(
        "uq_agent_tasks_open_prospect_task",
        "agent_tasks",
        ["prospect_id"],
        unique=True,
        postgresql_where=sa.text(f"status IN {OPEN_TASK_STATUSES} AND prospect_id IS NOT NULL"),
    )
    op.create_index(
        "uq_agent_tasks_open_thread_task",
        "agent_tasks",
        ["thread_id"],
        unique=True,
        postgresql_where=sa.text(f"status IN {OPEN_TASK_STATUSES} AND type = 'find_prospects'"),
    )

    op.create_table(
        "agent_task_results",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("task_id", sa.Uuid(), nullable=False),
        sa.Column("attempt", sa.SmallInteger(), nullable=False),
        sa.Column("submitted_by_id", sa.String(128), nullable=True),
        sa.Column("submitted_by_label", sa.String(255), nullable=False),
        sa.Column(
            "submitted_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("raw", postgresql.JSONB(), nullable=False),
        sa.Column(
            "proposal", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False
        ),
        sa.Column("digest", sa.String(64), nullable=False),
        sa.Column("status", sa.String(32), server_default="pending_review", nullable=False),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decided_by_id", sa.String(128), nullable=True),
        sa.Column("decided_by_display", sa.String(255), nullable=True),
        sa.Column("decision_note", sa.Text(), nullable=True),
        sa.Column("accepted_items", postgresql.JSONB(), nullable=True),
        sa.Column("applied", postgresql.JSONB(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "(status = 'pending_review') = (decided_at IS NULL)",
            name=op.f("ck_agent_task_results_decision_matches_status"),
        ),
        sa.CheckConstraint("attempt >= 1", name=op.f("ck_agent_task_results_attempt_positive")),
        sa.CheckConstraint(
            "char_length(digest) = 64", name=op.f("ck_agent_task_results_digest_length")
        ),
        sa.CheckConstraint(
            f"status IN ({_values(RESULT_STATUSES)})",
            name=op.f("ck_agent_task_results_status"),
        ),
        sa.ForeignKeyConstraint(
            ["task_id"],
            ["agent_tasks.id"],
            ondelete="CASCADE",
            name=op.f("fk_agent_task_results_task_id_agent_tasks"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_agent_task_results")),
    )
    op.create_index(
        "uq_agent_task_results_attempt",
        "agent_task_results",
        ["task_id", "attempt"],
        unique=True,
    )
    op.create_index(
        "uq_agent_task_results_pending",
        "agent_task_results",
        ["task_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending_review'"),
    )
    op.create_index("ix_agent_task_results_submitted_at", "agent_task_results", ["submitted_at"])

    for table in ("agent_threads", "agent_tasks", "agent_task_results"):
        _updated_at_trigger(table)


def downgrade() -> None:
    op.drop_table("agent_task_results")
    op.drop_table("agent_tasks")
    op.drop_table("agent_threads")
