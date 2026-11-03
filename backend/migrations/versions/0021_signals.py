"""Signals: `prospect_notes` gains a company subject, a source URL and an agent origin.

A note stays the person's dated fact; a **signal** is the same row with a `kind`, a `source_url`,
an `observed_on` date, a `valid_until` and an `origin` (`agent` when a person accepted an agent's
proposal). Keeping one table keeps the score's source unique. Company-only rows (no prospect) are
the new shape; existing rows are untouched.

Revision ID: 0021
Revises: 0020
Create Date: 2026-10-30
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SIGNAL_KINDS = (
    "hiring",
    "funding",
    "news",
    "social_post",
    "event",
    "product_launch",
    "partnership",
    "tech_change",
    "need_expressed",
    "other",
)
ORIGINS = ("manual", "agent")


def _values(values: tuple[str, ...]) -> str:
    return ", ".join(f"'{value}'" for value in values)


def upgrade() -> None:
    op.alter_column(
        "prospect_notes", "prospect_id", existing_type=sa.Uuid(), nullable=True
    )
    op.add_column("prospect_notes", sa.Column("company_id", sa.Uuid(), nullable=True))
    op.add_column("prospect_notes", sa.Column("source_url", sa.Text(), nullable=True))
    op.add_column("prospect_notes", sa.Column("kind", sa.String(32), nullable=True))
    op.add_column(
        "prospect_notes",
        sa.Column("origin", sa.String(32), server_default="manual", nullable=False),
    )
    op.add_column("prospect_notes", sa.Column("observed_on", sa.Date(), nullable=True))
    op.add_column("prospect_notes", sa.Column("valid_until", sa.Date(), nullable=True))
    op.add_column("prospect_notes", sa.Column("relevance", sa.SmallInteger(), nullable=True))
    op.add_column("prospect_notes", sa.Column("sentiment", sa.String(16), nullable=True))
    op.add_column("prospect_notes", sa.Column("task_result_id", sa.Uuid(), nullable=True))

    op.create_foreign_key(
        op.f("fk_prospect_notes_company_id_companies"),
        "prospect_notes",
        "companies",
        ["company_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_foreign_key(
        op.f("fk_prospect_notes_task_result_id_agent_task_results"),
        "prospect_notes",
        "agent_task_results",
        ["task_result_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_check_constraint(
        op.f("ck_prospect_notes_exactly_one_subject"),
        "prospect_notes",
        "num_nonnulls(prospect_id, company_id) = 1",
    )
    op.create_check_constraint(
        op.f("ck_prospect_notes_agent_needs_source"),
        "prospect_notes",
        "origin <> 'agent' OR source_url IS NOT NULL",
    )
    op.create_check_constraint(
        op.f("ck_prospect_notes_kind"),
        "prospect_notes",
        f"kind IS NULL OR kind IN ({_values(SIGNAL_KINDS)})",
    )
    op.create_check_constraint(
        op.f("ck_prospect_notes_origin"),
        "prospect_notes",
        f"origin IN ({_values(ORIGINS)})",
    )
    op.create_check_constraint(
        op.f("ck_prospect_notes_relevance"),
        "prospect_notes",
        "relevance IS NULL OR relevance BETWEEN 0 AND 100",
    )
    op.create_index(op.f("ix_prospect_notes_company_id"), "prospect_notes", ["company_id"])
    op.create_index(
        op.f("ix_prospect_notes_task_result_id"), "prospect_notes", ["task_result_id"]
    )
    op.create_index(
        "uq_prospect_notes_company_source",
        "prospect_notes",
        ["company_id", "source_url"],
        unique=True,
        postgresql_where=sa.text("source_url IS NOT NULL AND company_id IS NOT NULL"),
    )
    op.create_index(
        "uq_prospect_notes_prospect_source",
        "prospect_notes",
        ["prospect_id", "source_url"],
        unique=True,
        postgresql_where=sa.text("source_url IS NOT NULL AND prospect_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.execute("DELETE FROM prospect_notes WHERE prospect_id IS NULL")
    op.drop_index("uq_prospect_notes_prospect_source", table_name="prospect_notes")
    op.drop_index("uq_prospect_notes_company_source", table_name="prospect_notes")
    op.drop_index(op.f("ix_prospect_notes_task_result_id"), table_name="prospect_notes")
    op.drop_index(op.f("ix_prospect_notes_company_id"), table_name="prospect_notes")
    op.drop_constraint(
        op.f("ck_prospect_notes_relevance"), "prospect_notes", type_="check"
    )
    op.drop_constraint(op.f("ck_prospect_notes_origin"), "prospect_notes", type_="check")
    op.drop_constraint(op.f("ck_prospect_notes_kind"), "prospect_notes", type_="check")
    op.drop_constraint(
        op.f("ck_prospect_notes_agent_needs_source"), "prospect_notes", type_="check"
    )
    op.drop_constraint(
        op.f("ck_prospect_notes_exactly_one_subject"), "prospect_notes", type_="check"
    )
    op.drop_constraint(
        op.f("fk_prospect_notes_task_result_id_agent_task_results"),
        "prospect_notes",
        type_="foreignkey",
    )
    op.drop_constraint(
        op.f("fk_prospect_notes_company_id_companies"), "prospect_notes", type_="foreignkey"
    )
    for column in (
        "task_result_id",
        "sentiment",
        "relevance",
        "valid_until",
        "observed_on",
        "origin",
        "kind",
        "source_url",
        "company_id",
    ):
        op.drop_column("prospect_notes", column)
    op.alter_column(
        "prospect_notes", "prospect_id", existing_type=sa.Uuid(), nullable=False
    )
