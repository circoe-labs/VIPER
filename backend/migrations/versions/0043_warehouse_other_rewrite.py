"""Rewrite unsent "other companies" warehouse drafts with the reworded template.

Drafts a human has edited are left untouched.

Revision ID: 0043
Revises: 0042
"""
import sqlalchemy as sa
from alembic import op

revision = '0043'
down_revision = '0042'
branch_labels = None
depends_on = None


def upgrade() -> None:
    from app.services.warehouse_draft_text import draft_text

    bind = op.get_bind()
    rows = bind.execute(sa.text("""
        SELECT d.id, d.contact_name, d.warehouse_name, d.contact_role
        FROM warehouse_drafts d JOIN warehouses w ON w.id = d.warehouse_id
        WHERE w.prospecting_category IS DISTINCT FROM 'sme'
          AND d.send_state NOT IN ('sending', 'uncertain', 'sent')
          AND NOT EXISTS (
              SELECT 1 FROM audit_log e
              WHERE e.entity_type = 'warehouse_draft' AND e.entity_id = d.id
                AND e.action = 'warehouse_draft.updated' AND e.actor_type = 'human'
          )
    """)).all()
    for draft_id, name, warehouse, role in rows:
        bind.execute(
            sa.text("UPDATE warehouse_drafts SET body = :body, revision = revision + 1 WHERE id = :id"),
            {'body': draft_text(name, warehouse, role, 'other'), 'id': draft_id},
        )


def downgrade() -> None:
    pass
