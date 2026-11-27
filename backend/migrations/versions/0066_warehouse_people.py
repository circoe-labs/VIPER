"""Warehouse people become prospects.

`warehouse_people` links an entry of a warehouse listing to its prospect. `warehouse_drafts` gets
the prospect it was written to (`prospect_id`), the Contact step that accounts for its send
(`carried_message_id`) and the moment it left (`sent_at`, backfilled from the audit log).

No prospect is created here: people are linked one by one from the warehouse sheet, or by the
operator with `python -m app.cli warehouse-people` (dry run by default).

Revision ID: 0066
Revises: 0064
"""

import sqlalchemy as sa
from alembic import op

revision = "0066"
down_revision = "0064"
branch_labels = None
depends_on = None

TABLE = "warehouse_people"
DRAFTS = "warehouse_drafts"
LINKS = (("prospect_id", "prospects"), ("carried_message_id", "contact_messages"))
BACKFILL_SENT_AT = """
UPDATE warehouse_drafts AS draft
SET sent_at = event.sent_at
FROM (
    SELECT entity_id, max(occurred_at) AS sent_at
    FROM audit_log
    WHERE entity_type = 'warehouse_draft' AND action = 'warehouse_draft.sent'
    GROUP BY entity_id
) AS event
WHERE draft.id = event.entity_id AND draft.send_state = 'sent'
"""


def upgrade() -> None:
    op.create_table(
        TABLE,
        sa.Column("id", sa.Uuid(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("warehouse_id", sa.Uuid(), nullable=False),
        sa.Column("contact_key", sa.String(500), nullable=False),
        sa.Column("contact_name", sa.String(500), nullable=False),
        sa.Column("prospect_id", sa.Uuid(), nullable=False),
        sa.Column("linked_by_display", sa.String(255), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(
            ["warehouse_id"],
            ["warehouses.id"],
            name=op.f("fk_warehouse_people_warehouse_id_warehouses"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["prospect_id"],
            ["prospects.id"],
            name=op.f("fk_warehouse_people_prospect_id_prospects"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_warehouse_people")),
        sa.UniqueConstraint(
            "warehouse_id", "contact_key", name=op.f("uq_warehouse_people_warehouse_id_contact_key")
        ),
    )
    op.create_index(op.f("ix_warehouse_people_prospect_id"), TABLE, ["prospect_id"])
    op.add_column(DRAFTS, sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True))
    for column, target in LINKS:
        op.add_column(DRAFTS, sa.Column(column, sa.Uuid(), nullable=True))
        op.create_foreign_key(
            op.f(f"fk_{DRAFTS}_{column}_{target}"),
            DRAFTS,
            target,
            [column],
            ["id"],
            ondelete="SET NULL",
        )
        op.create_index(op.f(f"ix_{DRAFTS}_{column}"), DRAFTS, [column])
    op.execute(BACKFILL_SENT_AT)


def downgrade() -> None:
    for column, _ in LINKS:
        op.drop_index(op.f(f"ix_{DRAFTS}_{column}"), table_name=DRAFTS)
        op.drop_column(DRAFTS, column)  # its foreign key goes with it
    op.drop_column(DRAFTS, "sent_at")
    op.drop_table(TABLE)
