"""Missions: `missions`, `mission_targets`, `mission_runs`, and the run link of a task.

A mission is the persistent rule a person writes; a run is one occurrence; the targets are
references to existing companies/prospects. `agent_tasks` gains `run_id` and loses the `NOT NULL`
on `thread_id` (a mission task belongs to a run, not to a legacy « Analyse » thread).

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

MISSION_TYPES = ("prospection", "signals", "enrichment", "verification", "other")
MISSION_STATUSES = ("active", "paused", "done", "cancelled")
RUN_STATUSES = ("scheduled", "running", "done", "failed", "cancelled")
RUN_TRIGGERS = ("manual", "schedule")
RECURRENCE_UNITS = ("hours", "days", "weeks", "months")
END_KINDS = ("never", "date", "after")
RESULT_KINDS = ("companies", "prospects", "signals", "enrichment")
ACTOR_TYPES = ("human", "import", "system", "agent")


def _values(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def _timestamps() -> list[sa.Column]:
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
        "missions",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("type", sa.String(32), nullable=False),
        sa.Column("prompt", sa.Text(), nullable=False),
        sa.Column("status", sa.String(32), server_default="active", nullable=False),
        sa.Column("agent_id", sa.Uuid(), nullable=True),
        sa.Column("agent_label", sa.String(255), nullable=True),
        sa.Column("is_recurring", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("interval_count", sa.SmallInteger(), server_default="1", nullable=False),
        sa.Column("interval_unit", sa.String(32), server_default="days", nullable=False),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("end_kind", sa.String(32), server_default="never", nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("max_runs", sa.Integer(), nullable=True),
        sa.Column("result_kind", sa.String(32), nullable=False),
        sa.Column("result_limit", sa.SmallInteger(), server_default="20", nullable=False),
        sa.Column("geography", sa.String(200), nullable=True),
        sa.Column("period_days", sa.SmallInteger(), nullable=True),
        sa.Column(
            "exclusions", postgresql.JSONB(), server_default=sa.text("'{}'::jsonb"), nullable=False
        ),
        sa.Column("next_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_run_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by_type", sa.String(32), nullable=False),
        sa.Column("created_by_id", sa.String(128), nullable=True),
        sa.Column("created_by_display", sa.String(255), nullable=False),
        *_timestamps(),
        sa.CheckConstraint(
            "btrim(name) <> '' AND char_length(name) <= 200", name=op.f("ck_missions_name_valid")
        ),
        sa.CheckConstraint(
            "btrim(prompt) <> '' AND char_length(prompt) <= 5000",
            name=op.f("ck_missions_prompt_valid"),
        ),
        sa.CheckConstraint("result_limit BETWEEN 1 AND 500", name=op.f("ck_missions_limit_range")),
        sa.CheckConstraint(
            "period_days IS NULL OR period_days BETWEEN 1 AND 3650",
            name=op.f("ck_missions_period_range"),
        ),
        sa.CheckConstraint(
            "interval_count BETWEEN 1 AND 1000", name=op.f("ck_missions_interval_range")
        ),
        sa.CheckConstraint(
            "end_kind <> 'date' OR ends_at IS NOT NULL",
            name=op.f("ck_missions_end_date_required"),
        ),
        sa.CheckConstraint(
            "end_kind <> 'after' OR max_runs IS NOT NULL",
            name=op.f("ck_missions_end_runs_required"),
        ),
        sa.CheckConstraint(
            f"type IN ({_values(MISSION_TYPES)})", name=op.f("ck_missions_type")
        ),
        sa.CheckConstraint(
            f"status IN ({_values(MISSION_STATUSES)})", name=op.f("ck_missions_status")
        ),
        sa.CheckConstraint(
            f"interval_unit IN ({_values(RECURRENCE_UNITS)})",
            name=op.f("ck_missions_interval_unit"),
        ),
        sa.CheckConstraint(
            f"end_kind IN ({_values(END_KINDS)})", name=op.f("ck_missions_end_kind")
        ),
        sa.CheckConstraint(
            f"result_kind IN ({_values(RESULT_KINDS)})", name=op.f("ck_missions_result_kind")
        ),
        sa.CheckConstraint(
            f"created_by_type IN ({_values(ACTOR_TYPES)})",
            name=op.f("ck_missions_created_by_type"),
        ),
        sa.ForeignKeyConstraint(
            ["agent_id"], ["mcp_tokens.id"], name=op.f("fk_missions_agent_id_mcp_tokens"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_missions")),
    )
    op.create_index(op.f("ix_missions_agent_id"), "missions", ["agent_id"])
    op.create_index("ix_missions_status", "missions", ["status"])
    op.create_index("ix_missions_next_run_at", "missions", ["next_run_at"])
    _trigger("missions")

    op.create_table(
        "mission_targets",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("mission_id", sa.Uuid(), nullable=False),
        sa.Column("company_id", sa.Uuid(), nullable=True),
        sa.Column("prospect_id", sa.Uuid(), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            "num_nonnulls(company_id, prospect_id) = 1",
            name=op.f("ck_mission_targets_exactly_one_subject"),
        ),
        sa.ForeignKeyConstraint(
            ["mission_id"], ["missions.id"], name=op.f("fk_mission_targets_mission_id_missions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["company_id"], ["companies.id"],
            name=op.f("fk_mission_targets_company_id_companies"), ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["prospect_id"], ["prospects.id"],
            name=op.f("fk_mission_targets_prospect_id_prospects"), ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_mission_targets")),
    )
    op.create_index(op.f("ix_mission_targets_mission_id"), "mission_targets", ["mission_id"])
    op.create_index(op.f("ix_mission_targets_company_id"), "mission_targets", ["company_id"])
    op.create_index(op.f("ix_mission_targets_prospect_id"), "mission_targets", ["prospect_id"])
    op.create_index(
        "uq_mission_targets_company",
        "mission_targets",
        ["mission_id", "company_id"],
        unique=True,
        postgresql_where=sa.text("company_id IS NOT NULL"),
    )
    op.create_index(
        "uq_mission_targets_prospect",
        "mission_targets",
        ["mission_id", "prospect_id"],
        unique=True,
        postgresql_where=sa.text("prospect_id IS NOT NULL"),
    )
    _trigger("mission_targets")

    op.create_table(
        "mission_runs",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("mission_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(32), server_default="scheduled", nullable=False),
        sa.Column("trigger", sa.String(32), server_default="manual", nullable=False),
        sa.Column(
            "scheduled_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("tasks_total", sa.Integer(), server_default="0", nullable=False),
        sa.Column("results_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        *_timestamps(),
        sa.CheckConstraint(
            f"status IN ({_values(RUN_STATUSES)})", name=op.f("ck_mission_runs_status")
        ),
        sa.CheckConstraint(
            f"trigger IN ({_values(RUN_TRIGGERS)})", name=op.f("ck_mission_runs_trigger")
        ),
        sa.ForeignKeyConstraint(
            ["mission_id"], ["missions.id"], name=op.f("fk_mission_runs_mission_id_missions"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_mission_runs")),
    )
    op.create_index(op.f("ix_mission_runs_mission_id"), "mission_runs", ["mission_id"])
    op.create_index(
        "ix_mission_runs_mission_scheduled", "mission_runs", ["mission_id", "scheduled_at"]
    )
    _trigger("mission_runs")

    op.alter_column("agent_tasks", "thread_id", existing_type=sa.Uuid(), nullable=True)
    op.add_column("agent_tasks", sa.Column("run_id", sa.Uuid(), nullable=True))
    op.create_index(op.f("ix_agent_tasks_run_id"), "agent_tasks", ["run_id"])
    op.create_foreign_key(
        op.f("fk_agent_tasks_run_id_mission_runs"),
        "agent_tasks",
        "mission_runs",
        ["run_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.add_column("agent_tasks", sa.Column("assigned_agent_id", sa.Uuid(), nullable=True))
    op.create_index(op.f("ix_agent_tasks_assigned_agent_id"), "agent_tasks", ["assigned_agent_id"])
    op.create_foreign_key(
        op.f("fk_agent_tasks_assigned_agent_id_mcp_tokens"),
        "agent_tasks",
        "mcp_tokens",
        ["assigned_agent_id"],
        ["id"],
        ondelete="SET NULL",
    )
    # A mission run may target a record that another run (or a legacy thread) already targets:
    # the creation-level duplicate guards now only cover the legacy, thread-based tasks.
    op.drop_index("uq_agent_tasks_open_company_task", table_name="agent_tasks")
    op.create_index(
        "uq_agent_tasks_open_company_task",
        "agent_tasks",
        ["type", "company_id"],
        unique=True,
        postgresql_where=sa.text(
            "status IN ('pending', 'claimed', 'submitted') AND company_id IS NOT NULL"
            " AND prospect_id IS NULL AND run_id IS NULL"
        ),
    )
    op.drop_index("uq_agent_tasks_open_prospect_task", table_name="agent_tasks")
    op.create_index(
        "uq_agent_tasks_open_prospect_task",
        "agent_tasks",
        ["prospect_id"],
        unique=True,
        postgresql_where=sa.text(
            "status IN ('pending', 'claimed', 'submitted') AND prospect_id IS NOT NULL"
            " AND run_id IS NULL"
        ),
    )
    op.drop_index("uq_agent_tasks_open_thread_task", table_name="agent_tasks")
    op.create_index(
        "uq_agent_tasks_open_thread_task",
        "agent_tasks",
        ["thread_id"],
        unique=True,
        postgresql_where=sa.text(
            "status IN ('pending', 'claimed', 'submitted') AND type = 'find_prospects'"
            " AND run_id IS NULL"
        ),
    )


def downgrade() -> None:
    op.drop_index("uq_agent_tasks_open_thread_task", table_name="agent_tasks")
    op.create_index(
        "uq_agent_tasks_open_thread_task",
        "agent_tasks",
        ["thread_id"],
        unique=True,
        postgresql_where=sa.text(
            "status IN ('pending', 'claimed', 'submitted') AND type = 'find_prospects'"
        ),
    )
    op.drop_index("uq_agent_tasks_open_prospect_task", table_name="agent_tasks")
    op.create_index(
        "uq_agent_tasks_open_prospect_task",
        "agent_tasks",
        ["prospect_id"],
        unique=True,
        postgresql_where=sa.text(
            "status IN ('pending', 'claimed', 'submitted') AND prospect_id IS NOT NULL"
        ),
    )
    op.drop_index("uq_agent_tasks_open_company_task", table_name="agent_tasks")
    op.create_index(
        "uq_agent_tasks_open_company_task",
        "agent_tasks",
        ["type", "company_id"],
        unique=True,
        postgresql_where=sa.text(
            "status IN ('pending', 'claimed', 'submitted') AND company_id IS NOT NULL"
            " AND prospect_id IS NULL"
        ),
    )
    op.drop_constraint(
        op.f("fk_agent_tasks_assigned_agent_id_mcp_tokens"), "agent_tasks", type_="foreignkey"
    )
    op.drop_index(op.f("ix_agent_tasks_assigned_agent_id"), table_name="agent_tasks")
    op.drop_column("agent_tasks", "assigned_agent_id")
    op.drop_constraint(
        op.f("fk_agent_tasks_run_id_mission_runs"), "agent_tasks", type_="foreignkey"
    )
    op.drop_index(op.f("ix_agent_tasks_run_id"), table_name="agent_tasks")
    op.drop_column("agent_tasks", "run_id")
    op.alter_column("agent_tasks", "thread_id", existing_type=sa.Uuid(), nullable=False)
    op.drop_table("mission_runs")
    op.drop_table("mission_targets")
    op.drop_table("missions")
