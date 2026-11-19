"""Kept versions of a step's text and saved mails (`contact_message_versions`).

Every AI generation, manual edit and restoration of a Contact message becomes a version, so a bad
generation can be cancelled and two texts compared; the optional *saved* facet (rating 0-10,
comment, saved by/at) makes a version a « mail sauvegardé » with the config it was generated with.
Nothing is deleted when a message is validated or removed: `message_id` just becomes NULL.

Revision ID: 0059
Revises: 0058
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0059"
down_revision = "0058"
branch_labels = None
depends_on = None

TABLE = "contact_message_versions"


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("prospect_id", sa.Uuid(), nullable=False),
        sa.Column("sequence_id", sa.Uuid(), nullable=False),
        sa.Column("rank", sa.Integer(), nullable=False),
        sa.Column(
            "message_id",
            sa.Uuid(),
            sa.ForeignKey("contact_messages.id", ondelete="SET NULL"),
        ),
        sa.Column("revision", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("source", sa.String(16), nullable=False),
        sa.Column("from_email", sa.String(320)),
        sa.Column(
            "to_recipients",
            postgresql.ARRAY(sa.String(320)),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column("subject", sa.String(998), server_default="", nullable=False),
        sa.Column("body_text", sa.Text(), server_default="", nullable=False),
        sa.Column(
            "config",
            postgresql.JSONB(),
            server_default=sa.text("'{}'::jsonb"),
            nullable=False,
        ),
        sa.Column("actor_type", sa.String(16), nullable=False),
        sa.Column("actor_display", sa.String(255), nullable=False),
        sa.Column("saved_at", sa.DateTime(timezone=True)),
        sa.Column("saved_by_display", sa.String(255)),
        sa.Column("rating", sa.SmallInteger()),
        sa.Column("comment", sa.Text()),
        sa.ForeignKeyConstraint(
            ["prospect_id", "sequence_id"],
            ["contact_sequences.prospect_id", "contact_sequences.id"],
            ondelete="CASCADE",
            name="fk_contact_message_versions_sequence",
        ),
        sa.CheckConstraint(
            "source IN ('ai', 'manual', 'restore')", name=op.f("ck_contact_message_versions_source")
        ),
        sa.CheckConstraint(
            "rating IS NULL OR rating BETWEEN 0 AND 10",
            name=op.f("ck_contact_message_versions_rating_range"),
        ),
        sa.CheckConstraint(
            "(saved_at IS NULL) = (rating IS NULL) AND (saved_at IS NULL) = "
            "(saved_by_display IS NULL)",
            name=op.f("ck_contact_message_versions_saved_complete"),
        ),
    )
    op.create_index(
        "ix_contact_message_versions_step",
        TABLE,
        ["prospect_id", "sequence_id", "rank", "created_at"],
    )
    op.create_index("ix_contact_message_versions_message_id", TABLE, ["message_id"])
    op.execute(
        f"CREATE TRIGGER set_updated_at BEFORE UPDATE ON {TABLE} "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )
    op.create_index(
        "ix_contact_message_versions_saved",
        TABLE,
        ["prospect_id", "saved_at"],
        postgresql_where=sa.text("saved_at IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_table(TABLE)
