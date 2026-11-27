"""Prospecting lifecycle: archive, temporary exclusion, departure reason.

`prospecting_holds` keeps every reversible removal of a prospect or a company from prospecting
(who, when, why, and who brought it back). `prospects.departure_reason` says why an `inactive`
person left.

Revision ID: 0063
Revises: 0062
"""

import sqlalchemy as sa
from alembic import op

revision = "0063"
down_revision = "0062"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("prospects", sa.Column("departure_reason", sa.String(32), nullable=True))
    op.create_check_constraint(
        op.f("ck_prospects_departure_reason"),
        "prospects",
        "departure_reason IN ('retired', 'left_company', 'other')",
    )
    moment = sa.DateTime(timezone=True)
    op.create_table(
        "prospecting_holds",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("prospect_id", sa.Uuid(), nullable=True),
        sa.Column("company_id", sa.Uuid(), nullable=True),
        sa.Column("kind", sa.String(32), nullable=False),
        sa.Column("reason", sa.Text(), nullable=True),
        sa.Column("placed_at", moment, server_default=sa.text("now()"), nullable=False),
        sa.Column("placed_by_display", sa.String(255), nullable=False),
        sa.Column("lifted_at", moment, nullable=True),
        sa.Column("lifted_by_display", sa.String(255), nullable=True),
        sa.Column("lift_reason", sa.Text(), nullable=True),
        sa.CheckConstraint(
            "kind IN ('archive', 'exclusion')", name=op.f("ck_prospecting_holds_kind")
        ),
        sa.CheckConstraint(
            "num_nonnulls(prospect_id, company_id) = 1",
            name=op.f("ck_prospecting_holds_exactly_one_subject"),
        ),
        sa.CheckConstraint(
            "kind <> 'exclusion' OR coalesce(btrim(reason), '') <> ''",
            name=op.f("ck_prospecting_holds_exclusion_reason"),
        ),
        sa.CheckConstraint(
            "(lifted_at IS NULL) = (lifted_by_display IS NULL)",
            name=op.f("ck_prospecting_holds_lift_complete"),
        ),
        sa.ForeignKeyConstraint(
            ["prospect_id"],
            ["prospects.id"],
            name=op.f("fk_prospecting_holds_prospect_id_prospects"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["company_id"],
            ["companies.id"],
            name=op.f("fk_prospecting_holds_company_id_companies"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_prospecting_holds")),
    )
    for subject in ("prospect", "company"):
        column = f"{subject}_id"
        op.create_index(op.f(f"ix_prospecting_holds_{column}"), "prospecting_holds", [column])
        op.create_index(
            f"uq_prospecting_holds_open_{subject}",
            "prospecting_holds",
            [column, "kind"],
            unique=True,
            postgresql_where=sa.text(f"lifted_at IS NULL AND {column} IS NOT NULL"),
        )


def downgrade() -> None:
    op.drop_table("prospecting_holds")
    op.drop_constraint(op.f("ck_prospects_departure_reason"), "prospects", type_="check")
    op.drop_column("prospects", "departure_reason")
