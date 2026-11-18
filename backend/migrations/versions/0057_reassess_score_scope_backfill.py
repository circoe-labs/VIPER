"""Backfill the `reassess_score` scope on tokens that were scoped to every older task type.

Migration 0056 added the task type but left each `mcp_tokens.scopes` list as it was, so a worker
token created with the five original types listed explicitly (instead of `*`) never saw a
« Réévaluer le score » task: it stayed `pending` forever in the queue. A token that lists all
five original types meant « everything »; it gains the sixth. Narrower tokens are left alone
(a deliberate restriction).

Revision ID: 0057
Revises: 0056
"""

from alembic import op

revision = "0057"
down_revision = "0056"
branch_labels = None
depends_on = None

# Frozen literals: migrations never import application code (ADR-0002).
OLD_TYPES = (
    "'update_company', 'update_employee', 'find_employees', 'surveil_signals', 'find_prospects'"
)


BACKFILL_SQL = (
    "UPDATE mcp_tokens SET scopes = scopes || '[\"reassess_score\"]'::jsonb "
    "WHERE jsonb_typeof(scopes) = 'array' "
    "AND NOT (scopes ? 'reassess_score') AND NOT (scopes ? '*') "
    f"AND scopes ?& ARRAY[{OLD_TYPES}]"
)


def upgrade() -> None:
    op.execute(BACKFILL_SQL)


def downgrade() -> None:
    op.execute(
        "UPDATE mcp_tokens SET scopes = scopes - 'reassess_score' "
        "WHERE jsonb_typeof(scopes) = 'array' AND scopes ? 'reassess_score'"
    )
