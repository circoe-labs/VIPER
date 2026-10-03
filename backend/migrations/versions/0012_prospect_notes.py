"""Prospect notes (prospect-contact-ux, S1): short dated facts, optionally scored.

Creates `prospect_notes` (fact text, optional business day, optional source type/label, optional
`score_delta` in -50..50) with its CHECKs, the FK index, and the `set_updated_at` trigger (function
from 0002). Notes cascade with their prospect. Purely additive: the downgrade drops the table.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen literals: migrations never import application code (ADR-0002).
SOURCE_TYPES = ("linkedin", "email", "phone", "meeting", "web", "other")


def upgrade() -> None:
    op.create_table(
        "prospect_notes",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("prospect_id", sa.Uuid(), nullable=False),
        sa.Column("fact_text", sa.Text(), nullable=False),
        sa.Column("noted_on", sa.Date(), nullable=True),
        sa.Column("source_type", sa.String(32), nullable=True),
        sa.Column("source_label", sa.String(200), nullable=True),
        sa.Column("score_delta", sa.SmallInteger(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "btrim(fact_text) <> '' AND char_length(fact_text) <= 1000",
            name=op.f("ck_prospect_notes_fact_text_valid"),
        ),
        sa.CheckConstraint(
            "score_delta IS NULL OR score_delta BETWEEN -50 AND 50",
            name=op.f("ck_prospect_notes_score_delta_range"),
        ),
        sa.CheckConstraint(
            "source_type IN (" + ", ".join(repr(value) for value in SOURCE_TYPES) + ")",
            name=op.f("ck_prospect_notes_source_type"),
        ),
        sa.ForeignKeyConstraint(
            ["prospect_id"],
            ["prospects.id"],
            ondelete="CASCADE",
            name=op.f("fk_prospect_notes_prospect_id_prospects"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_prospect_notes")),
    )
    op.create_index(op.f("ix_prospect_notes_prospect_id"), "prospect_notes", ["prospect_id"])
    op.execute(
        "CREATE TRIGGER set_updated_at BEFORE UPDATE ON prospect_notes "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )


def downgrade() -> None:
    op.drop_table("prospect_notes")
