"""Add non-exclusive company service interests. Empty means no identified need.

Revision ID: 0026
Revises: 0025
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0026"
down_revision: str | None = "0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "companies",
        sa.Column(
            "proposed_services",
            postgresql.ARRAY(sa.String(32)),
            server_default="{}",
            nullable=False,
        ),
    )
    op.create_check_constraint(
        op.f("ck_companies_services_allowed"),
        "companies",
        "proposed_services <@ ARRAY['iguard','flexisme','transepteur',"
            "'iadvice','emailing']::varchar[] "
            "AND array_position(proposed_services, NULL) IS NULL",
    )
    op.create_index(
        "ix_companies_proposed_services", "companies", ["proposed_services"], postgresql_using="gin"
    )


def downgrade() -> None:
    op.drop_index("ix_companies_proposed_services", table_name="companies")
    op.drop_constraint(op.f("ck_companies_services_allowed"), "companies", type_="check")
    op.drop_column("companies", "proposed_services")
