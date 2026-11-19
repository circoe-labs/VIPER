"""Members of the organisation are also in the prospect base.

`prospects.member_user_id` ties a prospect fiche to the login account it is; `companies.
represents_organization_id` marks the company that is the organisation itself (CIRCOE). The
fiches are created and matched by `services/member_prospects.py` (at start-up and when a member
joins), not here.

Revision ID: 0060
Revises: 0059
"""

import sqlalchemy as sa
from alembic import op

revision = "0060"
down_revision = "0059"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("prospects", sa.Column("member_user_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_prospects_member_user_id_users",
        "prospects",
        "users",
        ["member_user_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_unique_constraint("uq_prospects_member_user_id", "prospects", ["member_user_id"])
    op.add_column("companies", sa.Column("represents_organization_id", sa.Uuid(), nullable=True))
    op.create_foreign_key(
        "fk_companies_represents_organization_id_organizations",
        "companies",
        "organizations",
        ["represents_organization_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_unique_constraint(
        "uq_companies_represents_organization_id", "companies", ["represents_organization_id"]
    )


def downgrade() -> None:
    op.drop_constraint("uq_companies_represents_organization_id", "companies", type_="unique")
    op.drop_constraint(
        "fk_companies_represents_organization_id_organizations", "companies", type_="foreignkey"
    )
    op.drop_column("companies", "represents_organization_id")
    op.drop_constraint("uq_prospects_member_user_id", "prospects", type_="unique")
    op.drop_constraint("fk_prospects_member_user_id_users", "prospects", type_="foreignkey")
    op.drop_column("prospects", "member_user_id")
