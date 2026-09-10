"""Import batch provenance: the legal basis / collection context and the source reference the user
gave when committing the import (Task 09, ADR-0012).

Each prospect source of the batch also carries the legal basis; the batch keeps both values once so
the import history shows under which basis a file was imported. Nullable: batches recorded before
this revision (and failed attempts) have none.

Revision ID: 0006
Revises: 0005
Create Date: 2026-09-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "import_batches", sa.Column("legal_basis_or_collection_context", sa.Text(), nullable=True)
    )
    op.add_column("import_batches", sa.Column("source_reference", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("import_batches", "source_reference")
    op.drop_column("import_batches", "legal_basis_or_collection_context")
