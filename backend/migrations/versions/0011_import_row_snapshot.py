"""Import row snapshot (sequences rework, Slice S2; decision D10).

`import_row_metadata` keeps, for every source row of a committed import, the raw snapshot of all
its non-empty cells (`raw_cells`, `{letter: {"header", "value"}}`) — the rows excluded in the review
included (`excluded = true`), so nothing of the file is lost even when it does not feed the CRM.
Rows recorded before this revision have an empty snapshot (their unapplied values are in
`legacy_metadata`) and are not excluded.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-01
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "import_row_metadata",
        sa.Column(
            "raw_cells",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
    )
    op.add_column(
        "import_row_metadata",
        sa.Column("excluded", sa.Boolean(), server_default=sa.false(), nullable=False),
    )


def downgrade() -> None:
    # Excluded rows only existed for their snapshot: they go with it.
    op.execute("DELETE FROM import_row_metadata WHERE excluded")
    op.drop_column("import_row_metadata", "excluded")
    op.drop_column("import_row_metadata", "raw_cells")
