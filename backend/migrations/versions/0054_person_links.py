"""Relational links between prospects and members (`person_links`).

Undirected, scored 0-100, one per pair. The former « Connaît Robin » notes stay as notes: nothing is
converted, since a note carries no strength and the relation (family, friends…) was never recorded.

Revision ID: 0054
Revises: 0053
"""

import sqlalchemy as sa
from alembic import op

revision = "0054"
down_revision = "0053"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "person_links",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("a_prospect_id", sa.Uuid(), sa.ForeignKey("prospects.id", ondelete="CASCADE")),
        sa.Column("a_user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE")),
        sa.Column("b_prospect_id", sa.Uuid(), sa.ForeignKey("prospects.id", ondelete="CASCADE")),
        sa.Column("b_user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="CASCADE")),
        sa.Column("pair_key", sa.String(100), nullable=False, unique=True),
        sa.Column("relation", sa.String(80), nullable=False),
        sa.Column("score", sa.SmallInteger(), nullable=False),
        sa.Column("note", sa.Text()),
        sa.Column("created_by_user_id", sa.Uuid(), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.CheckConstraint("num_nonnulls(a_prospect_id, a_user_id) = 1", name=op.f("ck_person_links_one_a_side")),
        sa.CheckConstraint("num_nonnulls(b_prospect_id, b_user_id) = 1", name=op.f("ck_person_links_one_b_side")),
        sa.CheckConstraint("score BETWEEN 0 AND 100", name=op.f("ck_person_links_score_range")),
        sa.CheckConstraint(
            "btrim(relation) <> '' AND char_length(relation) <= 80", name=op.f("ck_person_links_relation_valid")
        ),
    )
    for column in ("a_prospect_id", "a_user_id", "b_prospect_id", "b_user_id", "created_by_user_id"):
        op.create_index(op.f(f"ix_person_links_{column}"), "person_links", [column])
    op.execute(
        "CREATE TRIGGER set_updated_at BEFORE UPDATE ON person_links "
        "FOR EACH ROW EXECUTE FUNCTION set_updated_at()"
    )


def downgrade() -> None:
    op.drop_table("person_links")
