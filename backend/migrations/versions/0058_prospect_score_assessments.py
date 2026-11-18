"""AI assessments of a prospect's commercial fit (`prospect_score_assessments`).

« Évaluer le score » now calls the LLM directly (no external-agent mission): each successful call is
one immutable row with the score, the rationale, the criteria and the provenance (model, prompt
hash, actor, duration). Migrations 0056/0057 (the retired `reassess_score` task type) stay as they
are: the type remains valid in the database.

Revision ID: 0058
Revises: 0057
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0058"
down_revision = "0057"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "prospect_score_assessments",
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column(
            "prospect_id",
            sa.Uuid(),
            sa.ForeignKey("prospects.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("score", sa.SmallInteger(), nullable=False),
        sa.Column("rationale", sa.Text(), nullable=False),
        sa.Column("criteria", postgresql.JSONB(), nullable=False),
        sa.Column("model", sa.String(200), nullable=False),
        sa.Column("prompt_hash", sa.String(64), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("actor_type", sa.String(16), nullable=False),
        sa.Column("actor_id", sa.String(128)),
        sa.Column("actor_display", sa.String(255), nullable=False),
        sa.CheckConstraint(
            "score BETWEEN 0 AND 100", name=op.f("ck_prospect_score_assessments_score_range")
        ),
    )
    op.create_index(
        "ix_prospect_score_assessments_prospect_created",
        "prospect_score_assessments",
        ["prospect_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_table("prospect_score_assessments")
