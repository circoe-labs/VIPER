"""Contact messages (Contact port, Slice S3): one durable mail per prospect and step.

Creates `contact_messages` (steps `contact`/`r1`/`r2`, statuses `draft`/`validated`/`scheduled`/
`sent`/`cancelled`) with its integrity CHECKs, the `set_updated_at` trigger (function from 0002),
the dispatcher/remote-draft/claim partial indexes, and the `reject_sent_change` trigger that makes
a sent message immutable (decision 21; deleting the prospect still cascades). Purely additive: no
existing table or row changes, so the downgrade simply drops the table and its function.

Revision ID: 0009
Revises: 0008
Create Date: 2026-09-30
"""

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen literals: migrations never import application code (ADR-0002).
STEPS = ("contact", "r1", "r2")
STATUSES = ("draft", "validated", "scheduled", "sent", "cancelled")
VALIDATED = "'validated', 'scheduled', 'sent'"


def _in(column: str, values: Sequence[str]) -> str:
    return f"{column} IN ({', '.join(repr(value) for value in values)})"


def _moment(name: str) -> sa.Column[Any]:
    return sa.Column(name, sa.DateTime(timezone=True), nullable=True)


def _recipients(name: str) -> sa.Column[Any]:
    return sa.Column(
        name, postgresql.ARRAY(sa.String(320)), server_default=sa.text("'{}'"), nullable=False
    )


def upgrade() -> None:
    op.create_table(
        "contact_messages",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("prospect_id", sa.Uuid(), nullable=False),
        sa.Column("step", sa.String(32), nullable=False),
        sa.Column("status", sa.String(32), server_default="draft", nullable=False),
        sa.Column("from_email", sa.String(320), nullable=True),
        _recipients("to_recipients"),
        _recipients("cc_recipients"),
        _recipients("bcc_recipients"),
        sa.Column("subject", sa.String(998), server_default="", nullable=False),
        sa.Column("body_text", sa.Text(), server_default="", nullable=False),
        sa.Column("revision", sa.Integer(), server_default=sa.text("1"), nullable=False),
        sa.Column("validated_revision", sa.Integer(), nullable=True),
        _moment("validated_at"),
        sa.Column("validated_by_actor_id", sa.String(128), nullable=True),
        sa.Column("validated_by_display", sa.String(255), nullable=True),
        _moment("scheduled_at"),
        _moment("sent_at"),
        _moment("cancelled_at"),
        sa.Column("cancel_reason", sa.String(64), nullable=True),
        sa.Column("generation_model", sa.String(200), nullable=True),
        sa.Column("generation_prompt_version", sa.String(200), nullable=True),
        _moment("generated_at"),
        sa.Column("remote_provider", sa.String(64), nullable=True),
        sa.Column("remote_draft_id", sa.String(255), nullable=True),
        sa.Column("remote_message_id", sa.String(255), nullable=True),
        sa.Column("dispatch_claim_id", sa.Uuid(), nullable=True),
        _moment("dispatch_claimed_at"),
        sa.Column("dispatch_attempts", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("last_error_code", sa.String(64), nullable=True),
        _moment("last_error_at"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(_in("step", STEPS), name=op.f("ck_contact_messages_step")),
        sa.CheckConstraint(_in("status", STATUSES), name=op.f("ck_contact_messages_status")),
        sa.CheckConstraint("revision >= 1", name=op.f("ck_contact_messages_revision_positive")),
        sa.CheckConstraint(
            "validated_revision IS NULL OR validated_revision <= revision",
            name=op.f("ck_contact_messages_validated_revision_known"),
        ),
        sa.CheckConstraint(
            "dispatch_attempts >= 0",
            name=op.f("ck_contact_messages_dispatch_attempts_non_negative"),
        ),
        sa.CheckConstraint(
            "status <> 'scheduled' OR scheduled_at IS NOT NULL",
            name=op.f("ck_contact_messages_scheduled_has_moment"),
        ),
        sa.CheckConstraint(
            "(status = 'sent') = (sent_at IS NOT NULL)",
            name=op.f("ck_contact_messages_sent_has_moment"),
        ),
        sa.CheckConstraint(
            "(status = 'cancelled') = (cancelled_at IS NOT NULL)",
            name=op.f("ck_contact_messages_cancelled_has_moment"),
        ),
        sa.CheckConstraint(
            f"status NOT IN ({VALIDATED}) OR (validated_at IS NOT NULL "
            "AND validated_by_actor_id IS NOT NULL AND validated_revision = revision)",
            name=op.f("ck_contact_messages_validation_current"),
        ),
        sa.CheckConstraint(
            "status <> 'draft' OR (validated_at IS NULL AND validated_by_actor_id IS NULL "
            "AND validated_revision IS NULL)",
            name=op.f("ck_contact_messages_draft_not_validated"),
        ),
        sa.CheckConstraint(
            f"remote_draft_id IS NULL OR (remote_provider IS NOT NULL AND status IN ({VALIDATED}))",
            name=op.f("ck_contact_messages_remote_draft_validated"),
        ),
        sa.CheckConstraint(
            "(dispatch_claim_id IS NULL) = (dispatch_claimed_at IS NULL)",
            name=op.f("ck_contact_messages_dispatch_claim_complete"),
        ),
        sa.CheckConstraint(
            "dispatch_claim_id IS NULL OR status IN ('scheduled', 'sent')",
            name=op.f("ck_contact_messages_dispatch_claim_scheduled"),
        ),
        sa.CheckConstraint(
            "(last_error_code IS NULL) = (last_error_at IS NULL)",
            name=op.f("ck_contact_messages_last_error_complete"),
        ),
        sa.ForeignKeyConstraint(
            ["prospect_id"],
            ["prospects.id"],
            ondelete="CASCADE",
            name=op.f("fk_contact_messages_prospect_id_prospects"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_contact_messages")),
        sa.UniqueConstraint(
            "prospect_id", "step", name=op.f("uq_contact_messages_prospect_id_step")
        ),
    )
    op.create_index(
        "ix_contact_messages_scheduled_at_due",
        "contact_messages",
        ["scheduled_at"],
        postgresql_where=sa.text("status = 'scheduled'"),
    )
    op.create_index(
        "uq_contact_messages_remote_draft",
        "contact_messages",
        ["remote_provider", "remote_draft_id"],
        unique=True,
        postgresql_where=sa.text("remote_draft_id IS NOT NULL"),
    )
    op.create_index(
        "uq_contact_messages_dispatch_claim_id",
        "contact_messages",
        ["dispatch_claim_id"],
        unique=True,
        postgresql_where=sa.text("dispatch_claim_id IS NOT NULL"),
    )
    op.execute(
        "CREATE TRIGGER set_updated_at BEFORE UPDATE ON contact_messages "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )
    # Decision 21: a sent message can be read, never changed (deleting the prospect still works).
    op.execute(
        """
        CREATE FUNCTION contact_messages_reject_sent_change() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            RAISE EXCEPTION 'contact message % is sent and cannot be changed', OLD.id
                USING ERRCODE = 'restrict_violation';
        END $$
        """
    )
    op.execute(
        "CREATE TRIGGER reject_sent_change BEFORE UPDATE ON contact_messages "
        "FOR EACH ROW WHEN (OLD.status = 'sent') "
        "EXECUTE FUNCTION contact_messages_reject_sent_change()"
    )


def downgrade() -> None:
    op.drop_table("contact_messages")
    op.execute("DROP FUNCTION contact_messages_reject_sent_change()")
