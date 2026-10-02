"""Remote drafts of deleted messages (Contact port, Slice S6 QA rework M1).

Deleting a prospect cascades to its `contact_messages` (editor delete, prospecting reset,
Database Explorer row delete, any raw `DELETE`): an attached Infomaniak draft would be left behind
untracked. A `BEFORE DELETE` trigger on `contact_messages` queues it in
`contact_message_remote_draft_cleanups` with the new reason `deleted` (`message_id` NULL: the
message is going away), whatever the deleting path. A sent message is skipped: its draft left the
mailbox when it was sent. The downgrade drops the trigger and maps queued `deleted` rows to
`cancelled` before restoring the previous CHECK.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-01
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLE = "contact_message_remote_draft_cleanups"
CHECK = f"ck_{TABLE}_reason"


def upgrade() -> None:
    op.drop_constraint(op.f(CHECK), TABLE, type_="check")
    op.create_check_constraint(
        op.f(CHECK), TABLE, "reason IN ('edited', 'cancelled', 'replaced', 'deleted')"
    )
    op.execute(
        f"""
        CREATE FUNCTION contact_messages_queue_remote_draft() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
            INSERT INTO {TABLE} (message_id, remote_provider, remote_draft_id, reason)
            VALUES (NULL, OLD.remote_provider, OLD.remote_draft_id, 'deleted')
            ON CONFLICT (remote_provider, remote_draft_id) DO NOTHING;
            RETURN OLD;
        END $$
        """
    )
    op.execute(
        "CREATE TRIGGER queue_remote_draft_on_delete BEFORE DELETE ON contact_messages "
        "FOR EACH ROW WHEN (OLD.remote_draft_id IS NOT NULL AND OLD.remote_provider IS NOT NULL "
        "AND OLD.status <> 'sent') EXECUTE FUNCTION contact_messages_queue_remote_draft()"
    )


def downgrade() -> None:
    op.execute("DROP TRIGGER queue_remote_draft_on_delete ON contact_messages")
    op.execute("DROP FUNCTION contact_messages_queue_remote_draft()")
    op.execute(f"UPDATE {TABLE} SET reason = 'cancelled' WHERE reason = 'deleted'")
    op.drop_constraint(op.f(CHECK), TABLE, type_="check")
    op.create_check_constraint(op.f(CHECK), TABLE, "reason IN ('edited', 'cancelled', 'replaced')")
