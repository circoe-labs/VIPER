"""Company kind: `companies.company_kind` (PME / grande entreprise / institutionnel).

Nullable (not classified yet) with its CHECK; purely additive: the downgrade drops the column.

Revision ID: 0025
Revises: 0024
Create Date: 2026-10-27
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Frozen literals: migrations never import application code (ADR-0002).
KINDS = ("sme", "large", "institutional")


def upgrade() -> None:
    op.add_column("companies", sa.Column("company_kind", sa.String(32), nullable=True))
    allowed = ", ".join(f"'{value}'" for value in KINDS)
    op.create_check_constraint(
        op.f("ck_companies_company_kind"), "companies", f"company_kind IN ({allowed})"
    )


def downgrade() -> None:
    op.drop_constraint(op.f("ck_companies_company_kind"), "companies", type_="check")
    op.drop_column("companies", "company_kind")
