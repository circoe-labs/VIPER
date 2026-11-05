"""Warehouse directory with source contacts; existing prospect records are untouched.

Revision ID: 0025
Revises: 0024
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "warehouses",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("name", sa.String(500), nullable=False),
        sa.Column("owner_name", sa.String(500)),
        sa.Column("owner_role", sa.String(1000)),
        sa.Column("owner_email", sa.Text()),
        sa.Column("owner_linkedin", sa.Text()),
        sa.Column("address", sa.Text()),
        sa.Column("postal_code", sa.String(16)),
        sa.Column("city", sa.String(255)),
        sa.Column("siret", sa.String(14)),
        sa.Column("notes", sa.Text()),
        sa.Column(
            "contacts", postgresql.JSONB(), server_default=sa.text("'[]'::jsonb"), nullable=False
        ),
        sa.Column("source_reference", sa.Text()),
        sa.Column("source_key", sa.String(64)),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_warehouses")),
        sa.UniqueConstraint("source_key", name=op.f("uq_warehouses_source_key")),
        sa.CheckConstraint("btrim(name) <> ''", name=op.f("ck_warehouses_name_not_blank")),
        sa.CheckConstraint(
            "jsonb_typeof(contacts) = 'array'", name=op.f("ck_warehouses_contacts_array")
        ),
    )
    op.execute(
        "CREATE TRIGGER warehouses_set_updated_at BEFORE UPDATE ON warehouses "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )


def downgrade() -> None:
    op.drop_table("warehouses")
