"""A send that did not leave stays visible.

`contact_messages.missed_scheduled_at` / `missed_reason` / `missed_at` keep the send moment that
did not end in a send, why and when (`services/contact_schedule_trace.py`); `draft_check` the last
mailbox check of a scheduled message's draft. `warehouse_drafts.failure_code` / `failed_at` do the
same for the warehouse mails.

Backfill from the audit log: for every message that is neither scheduled nor sent, the latest event
that took its `scheduled_at` away says the moment, the reason and when; for every warehouse mail
`failed` / `uncertain`, its latest `warehouse_draft.failed` event says why and when. A cancelled
message that kept its `scheduled_at` is left as it is.

Revision ID: 0061
Revises: 0060
"""

import sqlalchemy as sa
from alembic import op

revision = "0061"
down_revision = "0060"
branch_labels = None
depends_on = None

BACKFILL_CONTACT = """
UPDATE contact_messages AS message
SET missed_scheduled_at = CAST(event.moment AS timestamptz),
    missed_at = event.occurred_at,
    missed_reason = left(
        CASE event.action
            WHEN 'contact_message.dispatch_failed'
                THEN coalesce(event.reason, 'dispatch_internal_error')
            WHEN 'contact_message.dispatch_released' THEN 'send_released_by_person'
            WHEN 'contact_message.unscheduled'
                THEN coalesce(event.reason, 'unscheduled_by_person')
            WHEN 'contact_message.cancelled' THEN 'cancelled'
            ELSE 'edited'
        END, 64)
FROM (
    SELECT DISTINCT ON (entity_id)
        entity_id,
        action,
        occurred_at,
        context ->> 'reason' AS reason,
        changes -> 'scheduled_at' ->> 'before' AS moment
    FROM audit_log
    WHERE entity_type = 'contact_message'
      AND changes -> 'scheduled_at' ->> 'before' IS NOT NULL
      AND changes -> 'scheduled_at' ->> 'after' IS NULL
    ORDER BY entity_id, occurred_at DESC
) AS event
WHERE message.id = event.entity_id
  AND message.status IN ('draft', 'validated', 'cancelled')
"""

BACKFILL_WAREHOUSE = """
UPDATE warehouse_drafts AS draft
SET failed_at = event.occurred_at,
    failure_code = left(event.reason, 255)
FROM (
    SELECT DISTINCT ON (entity_id)
        entity_id, occurred_at, context ->> 'reason' AS reason
    FROM audit_log
    WHERE entity_type = 'warehouse_draft' AND action = 'warehouse_draft.failed'
    ORDER BY entity_id, occurred_at DESC
) AS event
WHERE draft.id = event.entity_id AND draft.send_state IN ('failed', 'uncertain')
"""


def upgrade() -> None:
    moment = sa.DateTime(timezone=True)
    op.add_column("contact_messages", sa.Column("missed_scheduled_at", moment, nullable=True))
    op.add_column("contact_messages", sa.Column("missed_reason", sa.String(64), nullable=True))
    op.add_column("contact_messages", sa.Column("missed_at", moment, nullable=True))
    op.add_column("contact_messages", sa.Column("draft_check", sa.String(16), nullable=True))
    op.add_column("warehouse_drafts", sa.Column("failure_code", sa.String(255), nullable=True))
    op.add_column("warehouse_drafts", sa.Column("failed_at", moment, nullable=True))
    op.execute(BACKFILL_CONTACT)
    op.execute(BACKFILL_WAREHOUSE)


def downgrade() -> None:
    op.drop_column("warehouse_drafts", "failed_at")
    op.drop_column("warehouse_drafts", "failure_code")
    for column in ("draft_check", "missed_at", "missed_reason", "missed_scheduled_at"):
        op.drop_column("contact_messages", column)
