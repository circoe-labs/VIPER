"""A warehouse is a building (establishment) of a company.

`warehouses.establishment_id` links a warehouse of the directory to the `establishments` row it is
(nullable, `ON DELETE SET NULL`: deleting a building never deletes the warehouse). The company
follows from the building. Existing warehouses are linked when their SIRET equals an
establishment's SIRET (both are unique per establishment); the others stay unlinked and are
linked by a person from the warehouse sheet.

Downgrade drops the column.

Revision ID: 0051
Revises: 0050
"""

import sqlalchemy as sa
from alembic import op

revision = "0051"
down_revision = "0050"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "warehouses",
        sa.Column(
            "establishment_id",
            sa.Uuid(),
            sa.ForeignKey(
                "establishments.id", name="fk_warehouses_establishment_id", ondelete="SET NULL"
            ),
            nullable=True,
        ),
    )
    op.create_index("ix_warehouses_establishment_id", "warehouses", ["establishment_id"])
    op.execute(
        """
        UPDATE warehouses AS w
        SET establishment_id = e.id
        FROM establishments AS e
        WHERE w.siret IS NOT NULL AND w.siret <> '' AND e.siret = w.siret
        """
    )


def downgrade() -> None:
    op.drop_index("ix_warehouses_establishment_id", table_name="warehouses")
    op.drop_column("warehouses", "establishment_id")
