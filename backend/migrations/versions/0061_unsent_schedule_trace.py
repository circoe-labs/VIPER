"""A send that did not leave stays visible.

`contact_messages.missed_scheduled_at` / `missed_reason` / `missed_at` keep the send moment that
did not end in a send, why and when (`services/contact_schedule_trace.py`); `draft_check` the last
mailbox check of a scheduled message's draft; `sent_doubt_reason` / `sent_doubt_at` that the mail
may have left, until a person checks. `warehouse_drafts.failure_code` / `failed_at` say why a
warehouse mail did not leave.

Backfill from the audit log (`updated_at` untouched): a message not sent that ever lost its send
moment to an unknown outcome or a gone draft carries the doubt; for every message that is neither
scheduled nor sent, the latest event that took its `scheduled_at` away says the moment, the reason
and when; for every warehouse mail `failed` / `uncertain`, its latest `warehouse_draft.failed`
event says why and when. A cancelled message that kept its `scheduled_at` is left as it is.

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

# The doubt (« may have left ») looks at **every** event that took a send moment away, not only
# the latest: a message edited, rescheduled or unscheduled after an unknown outcome keeps it.
BACKFILL_DOUBT = """
UPDATE contact_messages AS message
SET sent_doubt_reason = event.reason,
    sent_doubt_at = event.occurred_at
FROM (
    SELECT DISTINCT ON (entity_id)
        entity_id, occurred_at, context ->> 'reason' AS reason
    FROM audit_log
    WHERE entity_type = 'contact_message'
      AND changes -> 'scheduled_at' ->> 'before' IS NOT NULL
      AND changes -> 'scheduled_at' ->> 'after' IS NULL
      AND context ->> 'reason' IN
          ('send_not_confirmed', 'send_draft_not_found', 'send_probably_sent')
    ORDER BY entity_id, occurred_at
) AS event
WHERE message.id = event.entity_id AND message.status <> 'sent'
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
    op.add_column("contact_messages", sa.Column("sent_doubt_reason", sa.String(64), nullable=True))
    op.add_column("contact_messages", sa.Column("sent_doubt_at", moment, nullable=True))
    op.add_column("warehouse_drafts", sa.Column("failure_code", sa.String(255), nullable=True))
    op.add_column("warehouse_drafts", sa.Column("failed_at", moment, nullable=True))
    # A backfill is not a change of the messages: their `updated_at` stays.
    op.execute("ALTER TABLE contact_messages DISABLE TRIGGER set_updated_at")
    op.execute(BACKFILL_CONTACT)
    op.execute(BACKFILL_DOUBT)
    op.execute("ALTER TABLE contact_messages ENABLE TRIGGER set_updated_at")
    op.execute(BACKFILL_WAREHOUSE)


def downgrade() -> None:
    op.drop_column("warehouse_drafts", "failed_at")
    op.drop_column("warehouse_drafts", "failure_code")
    for column in (
        "sent_doubt_at",
        "sent_doubt_reason",
        "draft_check",
        "missed_at",
        "missed_reason",
        "missed_scheduled_at",
    ):
        op.drop_column("contact_messages", column)
