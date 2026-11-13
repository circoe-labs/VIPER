"""Password reset: the hash of the e-mailed token and its expiry, on the account.

Revision ID: 0039
Revises: 0038
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0039"
down_revision: str | None = "0038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("password_reset_token_hash", sa.String(64)))
    op.add_column("users", sa.Column("password_reset_expires_at", sa.DateTime(timezone=True)))
    op.create_unique_constraint(
        op.f("uq_users_password_reset_token_hash"), "users", ["password_reset_token_hash"]
    )


def downgrade() -> None:
    op.drop_constraint(op.f("uq_users_password_reset_token_hash"), "users", type_="unique")
    op.drop_column("users", "password_reset_expires_at")
    op.drop_column("users", "password_reset_token_hash")
