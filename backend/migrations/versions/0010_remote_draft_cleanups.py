"""Remote draft cleanup queue (Contact port, Slice S6 — CIRCOE Toolbox).

Creates `contact_message_remote_draft_cleanups`: the Infomaniak drafts to delete through the
Toolbox after a message lost the validation they belonged to (edit), was cancelled, or got a draft
it could not attach (`replaced`). One row per remote draft (`UNIQUE (remote_provider,
remote_draft_id)`), the worker's pending index, the `set_updated_at` trigger (function from 0002).
Purely additive: the downgrade drops the table (pending deletions are lost with it — run
`python -m app.cli toolbox-cleanup --once` first if some are pending).

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "contact_message_remote_draft_cleanups"
# Frozen literals: migrations never import application code (ADR-0002).
REASONS = ("edited", "cancelled", "replaced")
OUTCOMES = ("deleted", "already_absent")


def _in(column: str, values: Sequence[str]) -> str:
    return f"{column} IN ({', '.join(repr(value) for value in values)})"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("message_id", sa.Uuid(), nullable=True),
        sa.Column("remote_provider", sa.String(64), nullable=False),
        sa.Column("remote_draft_id", sa.String(255), nullable=False),
        sa.Column("reason", sa.String(32), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column(
            "next_attempt_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("last_attempt_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error_code", sa.String(64), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("outcome", sa.String(32), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(_in("reason", REASONS), name=op.f(f"ck_{TABLE}_reason")),
        sa.CheckConstraint(_in("outcome", OUTCOMES), name=op.f(f"ck_{TABLE}_outcome")),
        sa.CheckConstraint("attempts >= 0", name=op.f(f"ck_{TABLE}_attempts_non_negative")),
        sa.CheckConstraint(
            "(completed_at IS NULL) = (outcome IS NULL)",
            name=op.f(f"ck_{TABLE}_completed_has_outcome"),
        ),
        sa.CheckConstraint(
            "(last_error_code IS NULL) OR (last_attempt_at IS NOT NULL)",
            name=op.f(f"ck_{TABLE}_error_has_attempt"),
        ),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["contact_messages.id"],
            ondelete="SET NULL",
            name=op.f(f"fk_{TABLE}_message_id_contact_messages"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{TABLE}")),
        sa.UniqueConstraint(
            "remote_provider",
            "remote_draft_id",
            name=op.f(f"uq_{TABLE}_remote_provider_remote_draft_id"),
        ),
    )
    op.create_index(op.f(f"ix_{TABLE}_message_id"), TABLE, ["message_id"])
    op.create_index(
        f"ix_{TABLE}_pending",
        TABLE,
        ["next_attempt_at"],
        postgresql_where=sa.text("completed_at IS NULL"),
    )
    op.execute(
        f"CREATE TRIGGER set_updated_at BEFORE UPDATE ON {TABLE} "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )


def downgrade() -> None:
    op.drop_table(TABLE)
