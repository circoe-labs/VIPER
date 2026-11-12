"""Mission telemetry: `mission_agent_sessions` and the append-only `mission_agent_logs`.

Contract: `doc/architecture/mission-telemetry.md` (§3 sessions, §5 logs). One active session per
(run, agent) is a partial unique index; the log table refuses UPDATE, TRUNCATE and DELETE through a
trigger, except the cascade of a deleted mission, run or session (the parent is already gone when
the cascade reaches the child) and the `task_id` SET NULL of a deleted task.

Revision ID: 0038
Revises: 0037
Create Date: 2026-11-12
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0038"
down_revision: str | None = "0037"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SESSION_STATUSES = ("active", "ended", "timed_out")
DISCONNECT_REASONS = ("agent_ended", "run_finished", "mission_cancelled", "inactivity_timeout")
LOG_EVENTS = (
    "search",
    "source_opened",
    "observation",
    "verification",
    "progress",
    "warning",
    "error",
    "decision_summary",
)


def _values(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.create_table(
        "mission_agent_sessions",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("mission_id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("agent_id", sa.String(128), nullable=False),
        sa.Column("agent_label", sa.String(255), nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ended_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(32), server_default="active", nullable=False),
        sa.Column("disconnect_reason", sa.String(32), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "(status = 'active') = (ended_at IS NULL AND disconnect_reason IS NULL)",
            name=op.f("ck_mission_agent_sessions_end_matches_status"),
        ),
        sa.CheckConstraint(
            f"status IN ({_values(SESSION_STATUSES)})",
            name=op.f("ck_mission_agent_sessions_status"),
        ),
        sa.CheckConstraint(
            f"disconnect_reason IN ({_values(DISCONNECT_REASONS)})",
            name=op.f("ck_mission_agent_sessions_disconnect_reason"),
        ),
        sa.ForeignKeyConstraint(
            ["mission_id"],
            ["missions.id"],
            name=op.f("fk_mission_agent_sessions_mission_id_missions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["mission_runs.id"],
            name=op.f("fk_mission_agent_sessions_run_id_mission_runs"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_mission_agent_sessions")),
    )
    op.create_index(
        "uq_mission_agent_sessions_active",
        "mission_agent_sessions",
        ["run_id", "agent_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_index(
        "ix_mission_agent_sessions_active_last_seen",
        "mission_agent_sessions",
        ["last_seen_at"],
        postgresql_where=sa.text("status = 'active'"),
    )
    op.create_index(
        "ix_mission_agent_sessions_mission_started",
        "mission_agent_sessions",
        ["mission_id", "started_at"],
    )
    op.create_index(
        "ix_mission_agent_sessions_run_started", "mission_agent_sessions", ["run_id", "started_at"]
    )
    op.execute(
        "CREATE TRIGGER set_updated_at BEFORE UPDATE ON mission_agent_sessions "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )

    op.create_table(
        "mission_agent_logs",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("session_id", sa.Uuid(), nullable=False),
        sa.Column("mission_id", sa.Uuid(), nullable=False),
        sa.Column("run_id", sa.Uuid(), nullable=False),
        sa.Column("task_id", sa.Uuid(), nullable=True),
        sa.Column("agent_id", sa.String(128), nullable=False),
        sa.Column("event_type", sa.String(32), nullable=False),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("source_url", sa.String(2048), nullable=True),
        sa.Column("source_published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("metadata", JSONB, server_default=sa.text("'{}'::jsonb"), nullable=False),
        sa.CheckConstraint(
            "btrim(message) <> '' AND char_length(message) <= 1000",
            name=op.f("ck_mission_agent_logs_message_valid"),
        ),
        sa.CheckConstraint(
            "source_url IS NULL OR source_url ~ '^https?://'",
            name=op.f("ck_mission_agent_logs_source_url_http"),
        ),
        sa.CheckConstraint(
            f"event_type IN ({_values(LOG_EVENTS)})",
            name=op.f("ck_mission_agent_logs_event_type"),
        ),
        sa.ForeignKeyConstraint(
            ["session_id"],
            ["mission_agent_sessions.id"],
            name=op.f("fk_mission_agent_logs_session_id_mission_agent_sessions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["mission_id"],
            ["missions.id"],
            name=op.f("fk_mission_agent_logs_mission_id_missions"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"],
            ["mission_runs.id"],
            name=op.f("fk_mission_agent_logs_run_id_mission_runs"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["task_id"],
            ["agent_tasks.id"],
            name=op.f("fk_mission_agent_logs_task_id_agent_tasks"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_mission_agent_logs")),
    )
    for name, column in (
        ("ix_mission_agent_logs_mission_created", "mission_id"),
        ("ix_mission_agent_logs_run_created", "run_id"),
        ("ix_mission_agent_logs_session_created", "session_id"),
    ):
        op.create_index(
            name,
            "mission_agent_logs",
            [column, sa.text("created_at DESC"), sa.text("id DESC")],
        )
    op.create_index("ix_mission_agent_logs_task_id", "mission_agent_logs", ["task_id"])

    # Append-only (ADR-0002 audit style). A DELETE is allowed only as the cascade of a deleted
    # parent: the RI trigger of the parent runs after the parent row is gone, so a log whose
    # mission, run or session no longer exists is being cascaded. The only UPDATE allowed is the
    # `task_id` SET NULL of a deleted task (every other column unchanged).
    op.execute(
        """
        CREATE FUNCTION mission_agent_logs_guard() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
            IF TG_OP = 'DELETE' THEN
                IF NOT EXISTS (SELECT 1 FROM missions WHERE id = OLD.mission_id)
                   OR NOT EXISTS (SELECT 1 FROM mission_runs WHERE id = OLD.run_id)
                   OR NOT EXISTS (SELECT 1 FROM mission_agent_sessions WHERE id = OLD.session_id)
                THEN
                    RETURN OLD;
                END IF;
            ELSIF TG_OP = 'UPDATE' THEN
                IF OLD.task_id IS NOT NULL AND NEW.task_id IS NULL
                   AND to_jsonb(NEW) - 'task_id' = to_jsonb(OLD) - 'task_id'
                THEN
                    RETURN NEW;
                END IF;
            END IF;
            RAISE EXCEPTION 'mission_agent_logs is append-only: % rejected', TG_OP
                USING ERRCODE = 'restrict_violation';
        END $$
        """
    )
    op.execute(
        "CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON mission_agent_logs "
        "FOR EACH ROW EXECUTE FUNCTION mission_agent_logs_guard()"
    )
    op.execute(
        "CREATE TRIGGER no_truncate BEFORE TRUNCATE ON mission_agent_logs "
        "FOR EACH STATEMENT EXECUTE FUNCTION mission_agent_logs_guard()"
    )


def downgrade() -> None:
    # The append-only trigger goes with the table (dropping a table is not a DELETE).
    op.drop_table("mission_agent_logs")
    op.execute("DROP FUNCTION mission_agent_logs_guard()")
    op.drop_table("mission_agent_sessions")
