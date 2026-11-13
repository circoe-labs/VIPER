"""Drop the contact name from the subject of unsent warehouse drafts.

Revision ID: 0041
Revises: 0040
"""
from alembic import op

revision = '0041'
down_revision = '0040'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # "<name>, échangeons sur …" becomes "Échangeons sur …"; other (hand-written) subjects are untouched.
    op.execute("""
        UPDATE warehouse_drafts
        SET revision = revision + 1,
            subject = 'Échangeons sur ' || substring(subject FROM position(', échangeons sur ' IN subject) + 17)
        WHERE send_state NOT IN ('sending', 'uncertain', 'sent')
          AND subject LIKE '%, échangeons sur %'
    """)


def downgrade() -> None:
    pass
