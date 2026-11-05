"""Self-service sign-up: an account asked for on the sign-in page waits for an admin's approval.

Revision ID: 0032
Revises: 0031
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0032"
down_revision: str | None = "0031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("users", sa.Column("signup_requested_at", sa.DateTime(timezone=True)))
    op.add_column("users", sa.Column("signup_token_hash", sa.String(64)))
    op.create_unique_constraint(op.f("uq_users_signup_token_hash"), "users", ["signup_token_hash"])


def downgrade() -> None:
    op.drop_constraint(op.f("uq_users_signup_token_hash"), "users", type_="unique")
    op.drop_column("users", "signup_token_hash")
    op.drop_column("users", "signup_requested_at")
