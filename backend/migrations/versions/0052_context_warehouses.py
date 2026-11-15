"""A mission may link a warehouse sheet as read-only context.

`mission_context_refs.warehouse_id` (FK warehouses, ON DELETE CASCADE) joins company_id and
prospect_id: exactly one of the three is set. Downgrade removes the warehouse links.

Revision ID: 0052
Revises: 0051
"""

import sqlalchemy as sa
from alembic import op

revision = "0052"
down_revision = "0051"
branch_labels = None
depends_on = None

TABLE = "mission_context_refs"
CHECK = "ck_mission_context_refs_exactly_one_record"


def upgrade() -> None:
    op.add_column(
        TABLE,
        sa.Column("warehouse_id", sa.Uuid(), sa.ForeignKey("warehouses.id", ondelete="CASCADE")),
    )
    op.create_index(op.f("ix_mission_context_refs_warehouse_id"), TABLE, ["warehouse_id"])
    op.create_index(
        "uq_mission_context_refs_warehouse",
        TABLE,
        ["mission_id", "warehouse_id"],
        unique=True,
        postgresql_where=sa.text("warehouse_id IS NOT NULL"),
    )
    op.drop_constraint(op.f(CHECK), TABLE, type_="check")
    op.create_check_constraint(
        op.f(CHECK), TABLE, "num_nonnulls(company_id, prospect_id, warehouse_id) = 1"
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM {TABLE} WHERE warehouse_id IS NOT NULL")
    op.drop_constraint(op.f(CHECK), TABLE, type_="check")
    op.create_check_constraint(op.f(CHECK), TABLE, "num_nonnulls(company_id, prospect_id) = 1")
    op.drop_index("uq_mission_context_refs_warehouse", table_name=TABLE)
    op.drop_index(op.f("ix_mission_context_refs_warehouse_id"), table_name=TABLE)
    op.drop_column(TABLE, "warehouse_id")
