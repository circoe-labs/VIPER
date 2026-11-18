"""The special « Dépôt » mission: where an agent drops work nobody asked for as a mission.

Revision ID: 0055
Revises: 0054
"""

import sqlalchemy as sa
from alembic import op

revision = "0055"
down_revision = "0054"
branch_labels = None
depends_on = None

DEPOSIT_NAME = "Dépôt"
DEPOSIT_PROMPT = (
    "Mission permanente : les agents y déposent les données qu’une personne leur a "
    "demandées directement, hors de toute mission (par exemple « ajoute ce contact »). "
    "Chaque dépôt est relu avant d’entrer dans la base."
)


def upgrade() -> None:
    op.add_column(
        "missions",
        sa.Column("is_deposit", sa.Boolean(), server_default=sa.text("false"), nullable=False),
    )
    op.create_index(
        "uq_missions_deposit",
        "missions",
        ["is_deposit"],
        unique=True,
        postgresql_where=sa.text("is_deposit"),
    )
    op.execute(
        sa.text(
            "INSERT INTO missions (name, type, prompt, status, is_deposit, result_kind, "
            "result_limit, allow_multiple, created_by_type, created_by_display) "
            "VALUES (:name, 'other', :prompt, 'active', true, 'enrichment', 50, true, "
            "'system', 'VIPER')"
        ).bindparams(name=DEPOSIT_NAME, prompt=DEPOSIT_PROMPT)
    )


def downgrade() -> None:
    op.execute("DELETE FROM missions WHERE is_deposit")
    op.drop_index("uq_missions_deposit", table_name="missions")
    op.drop_column("missions", "is_deposit")
