"""`mission_runs.config`: the rule a run was created under.

A task's claim payload and the checks of its result (`result_limit`, `period_days`) used to re-read
the live mission, so « Modifier la mission » changed the work of a run already made. Each run now
keeps the mission block of the payload as it was when the run started; a run made before this
revision (`config` NULL) keeps reading the live mission. Nothing is backfilled: the rule those runs
were created under is not known any more.

Revision ID: 0027
Revises: 0026
Create Date: 2026-11-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision: str = "0027"
down_revision: str | None = "0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("mission_runs", sa.Column("config", JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("mission_runs", "config")
