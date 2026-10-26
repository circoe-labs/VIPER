"""Agenda: `appointments`, the meetings booked by prospects (Calendly sync or manual).

Creates the table with its CHECKs, the unique Calendly event key, the FK / date indexes and the
`set_updated_at` trigger (function from 0002). Purely additive: the downgrade drops the table.

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-23
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen literals: migrations never import application code (ADR-0002).
SOURCES = ("calendly", "manual")
STATUSES = ("scheduled", "completed", "no_show", "cancelled")


def upgrade() -> None:
    op.create_table(
        "appointments",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("source", sa.String(32), nullable=False),
        sa.Column("calendly_event_uri", sa.String(300), nullable=True),
        sa.Column("calendly_invitee_uri", sa.String(300), nullable=True),
        sa.Column("prospect_id", sa.Uuid(), nullable=True),
        sa.Column("referent_id", sa.Uuid(), nullable=True),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("invitee_name", sa.String(300), nullable=False),
        sa.Column("invitee_email", sa.String(320), nullable=True),
        sa.Column("company_name", sa.String(300), nullable=True),
        sa.Column("host_name", sa.String(300), nullable=True),
        sa.Column("host_email", sa.String(320), nullable=True),
        sa.Column("starts_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ends_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("location", sa.String(1000), nullable=True),
        sa.Column("status", sa.String(32), server_default="scheduled", nullable=False),
        sa.Column("reschedule_count", sa.SmallInteger(), server_default="0", nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("ends_at >= starts_at", name=op.f("ck_appointments_ends_after_start")),
        sa.CheckConstraint(
            "btrim(invitee_name) <> ''", name=op.f("ck_appointments_invitee_name_valid")
        ),
        sa.CheckConstraint(
            "source IN (" + ", ".join(repr(value) for value in SOURCES) + ")",
            name=op.f("ck_appointments_source"),
        ),
        sa.CheckConstraint(
            "status IN (" + ", ".join(repr(value) for value in STATUSES) + ")",
            name=op.f("ck_appointments_status"),
        ),
        sa.ForeignKeyConstraint(
            ["prospect_id"],
            ["prospects.id"],
            ondelete="SET NULL",
            name=op.f("fk_appointments_prospect_id_prospects"),
        ),
        sa.ForeignKeyConstraint(
            ["referent_id"],
            ["internal_referents.id"],
            ondelete="SET NULL",
            name=op.f("fk_appointments_referent_id_internal_referents"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_appointments")),
        sa.UniqueConstraint("calendly_event_uri", name=op.f("uq_appointments_calendly_event_uri")),
    )
    op.create_index(op.f("ix_appointments_prospect_id"), "appointments", ["prospect_id"])
    op.create_index(op.f("ix_appointments_referent_id"), "appointments", ["referent_id"])
    op.create_index("ix_appointments_starts_at", "appointments", ["starts_at"])
    op.execute(
        "CREATE TRIGGER set_updated_at BEFORE UPDATE ON appointments "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )


def downgrade() -> None:
    op.drop_table("appointments")
