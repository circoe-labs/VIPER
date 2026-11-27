"""Three e-mails per sequence: Contact, R1, R2.

- `app_settings.contact.max_follow_ups` above 2 becomes 2 (it can no longer be raised);
- every unsent message beyond R2 (draft, validated or scheduled) is cancelled with
  `cancel_reason = 'sequence_limit'`; its Infomaniak draft is queued for deletion and a
  scheduled one keeps its send moment in the `missed_*` trace, so the lists say it; one whose
  draft the last check did not find carries the may-have-left doubt (an earlier doubt stays);
- both are written to the audit log.

Untouched: sent messages (old R3/R4 stay in history), and a message claimed by the dispatcher
(its send may be running or unconfirmed: a person settles it, and « Remettre en Validé » then
cancels it).

The downgrade changes nothing: which messages were cancelled here stays readable in the data,
and bringing them back is not wanted.

Revision ID: 0062
Revises: 0061
"""

from alembic import op

revision = "0062"
down_revision = "0061"
branch_labels = None
depends_on = None

# The audit log shows this sentence; the message keeps the code.
AUDIT = "'system', '0062_three_emails', 'Migration 0062 (trois e-mails par séquence)'"
CONTEXT = (
    "jsonb_build_object('source', 'cli', 'reason', "
    "'Limite de trois e-mails par séquence : Contact, R1, R2')"
)

CANCEL = f"""
WITH target AS (
    SELECT id, prospect_id, status, remote_provider, remote_draft_id, draft_check
    FROM contact_messages
    WHERE rank > 2
      AND status IN ('draft', 'validated', 'scheduled')
      AND dispatch_claim_id IS NULL
    FOR UPDATE
), cleanup AS (
    INSERT INTO contact_message_remote_draft_cleanups
        (id, message_id, remote_provider, remote_draft_id, reason)
    SELECT gen_random_uuid(), id, remote_provider, remote_draft_id, 'cancelled'
    FROM target
    WHERE remote_provider IS NOT NULL AND remote_draft_id IS NOT NULL
    ON CONFLICT (remote_provider, remote_draft_id) DO NOTHING
), cancelled AS (
    UPDATE contact_messages AS message
    SET status = 'cancelled',
        cancelled_at = now(),
        cancel_reason = 'sequence_limit',
        missed_scheduled_at = CASE WHEN message.status = 'scheduled'
            THEN message.scheduled_at ELSE message.missed_scheduled_at END,
        missed_reason = CASE
            WHEN message.status = 'scheduled' OR message.missed_reason IS NOT NULL
            THEN 'sequence_limit' END,
        missed_at = CASE
            WHEN message.status = 'scheduled' OR message.missed_reason IS NOT NULL
            THEN now() END,
        remote_provider = NULL,
        remote_draft_id = NULL,
        draft_check = NULL,
        -- A scheduled mail whose draft is gone may have left (sent by hand): the same doubt as
        -- `contact_schedule_trace.leave_schedule`. The first reason stays.
        sent_doubt_reason = coalesce(message.sent_doubt_reason, CASE
            WHEN message.status = 'scheduled' AND message.draft_check = 'missing'
            THEN 'draft_missing' END),
        sent_doubt_at = coalesce(message.sent_doubt_at, CASE
            WHEN message.status = 'scheduled' AND message.draft_check = 'missing'
            THEN now() END),
        last_error_code = CASE WHEN message.last_error_code LIKE 'toolbox\\_%'
            THEN NULL ELSE message.last_error_code END,
        last_error_at = CASE WHEN message.last_error_code LIKE 'toolbox\\_%'
            THEN NULL ELSE message.last_error_at END,
        updated_at = now()
    FROM target
    WHERE message.id = target.id
    RETURNING message.id
)
INSERT INTO audit_log (id, actor_type, actor_id, actor_display, entity_type, entity_id,
                       subject_type, subject_id, action, changes, context)
SELECT gen_random_uuid(), {AUDIT}, 'contact_message', target.id, 'prospect', target.prospect_id,
       'contact_message.cancelled',
       jsonb_build_object('status', jsonb_build_object(
           'before', target.status, 'after', 'cancelled')),
       {CONTEXT}
FROM target
JOIN cancelled ON cancelled.id = target.id
"""

LOWER_SETTING = f"""
WITH target AS (
    SELECT id, value
    FROM app_settings
    WHERE key = 'contact.max_follow_ups'
      AND CASE WHEN jsonb_typeof(value) = 'number' THEN (value #>> '{{}}')::numeric > 2
          ELSE false END
    FOR UPDATE
), lowered AS (
    UPDATE app_settings AS setting
    SET value = to_jsonb(2), updated_at = now()
    FROM target
    WHERE setting.id = target.id
    RETURNING setting.id
)
INSERT INTO audit_log (id, actor_type, actor_id, actor_display, entity_type, entity_id,
                       action, changes, context)
SELECT gen_random_uuid(), {AUDIT}, 'app_setting', target.id, 'app_setting.updated',
       jsonb_build_object('value', jsonb_build_object('before', target.value, 'after', 2)),
       {CONTEXT}
FROM target
JOIN lowered ON lowered.id = target.id
"""


def upgrade() -> None:
    op.execute(LOWER_SETTING)
    op.execute(CANCEL)


def downgrade() -> None:
    """Data only, nothing to restore (see above)."""
