"""E-mail identity: a person's override of « this address names someone else ».

The doubt itself is computed from the current rows (nothing is rewritten here); this table only
keeps the explicit confirmations, per (person, address), with who and when.

Revision ID: 0064
Revises: 0063
"""

import sqlalchemy as sa
from alembic import op

revision = "0064"
down_revision = "0063"
branch_labels = None
depends_on = None

TABLE = "email_identity_confirmations"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("prospect_id", sa.Uuid(), nullable=True),
        sa.Column("person_key", sa.String(600), nullable=False),
        sa.Column("address", sa.String(320), nullable=False),
        sa.Column(
            "confirmed_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("confirmed_by_id", sa.String(128), nullable=True),
        sa.Column("confirmed_by_display", sa.String(255), nullable=False),
        sa.ForeignKeyConstraint(
            ["prospect_id"],
            ["prospects.id"],
            name=op.f("fk_email_identity_confirmations_prospect_id_prospects"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_email_identity_confirmations")),
        sa.UniqueConstraint(
            "person_key", "address", name=op.f("uq_email_identity_confirmations_person_key_address")
        ),
    )
    op.create_index(op.f("ix_email_identity_confirmations_prospect_id"), TABLE, ["prospect_id"])


def downgrade() -> None:
    op.drop_table(TABLE)
