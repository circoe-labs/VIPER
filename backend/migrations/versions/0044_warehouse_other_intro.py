"""Remove the repeated "Je vous contacte au sujet de votre activité" sentence from unsent drafts.

Revision ID: 0044
Revises: 0043
"""
import re

import sqlalchemy as sa
from alembic import op

revision = '0044'
down_revision = '0043'
branch_labels = None
depends_on = None

_OLD = re.compile(
    r"Je vous contacte au sujet de votre activité(?: en tant que (?P<label>[^\n]+?))?, "
    r"et plus particulièrement de (?P<topic>[^\n]+?)\. "
)


def _replace(match: re.Match[str]) -> str:
    label, topic = match['label'], match['topic']
    focus = f"votre rôle de {label} me conduit à m’intéresser à {topic}" if label else f"je m’intéresse à {topic}"
    return f"Plus précisément, {focus}. "


def upgrade() -> None:
    bind = op.get_bind()
    rows = bind.execute(sa.text(
        "SELECT id, body FROM warehouse_drafts WHERE send_state NOT IN ('sending', 'uncertain', 'sent')"
    )).all()
    for draft_id, body in rows:
        new_body = _OLD.sub(_replace, body)
        if new_body != body:
            bind.execute(
                sa.text("UPDATE warehouse_drafts SET body = :body, revision = revision + 1 WHERE id = :id"),
                {'body': new_body, 'id': draft_id},
            )


def downgrade() -> None:
    pass
