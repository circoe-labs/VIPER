"""Settings values: case-, accent- and space-insensitive uniqueness (Task 06, ADR-0009).

`label_key(text)` is the comparison key of a Settings value: trimmed, inner whitespace collapsed,
accents removed (`unaccent` extension) and lowercased. Taxonomy labels become unique on it (instead
of `lower(label)`), so `Entrepôt` and ` entrepot ` cannot coexist whatever the write path (Settings,
inline creation, Database Explorer). Internal referents get the same rule on their full name, and
a plain unique e-mail (NULLs allowed).

Fails if existing rows already collide on the new keys: merge or rename them first.

Revision ID: 0005
Revises: 0004
Create Date: 2026-09-10
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TAXONOMY_TABLES = ("roles", "commercial_segments", "activity_categories")

# SQL-standard body: parsed once, so it depends on `unaccent` explicitly and ignores search_path.
LABEL_KEY = """
CREATE FUNCTION label_key(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
RETURN lower(public.unaccent('public.unaccent'::regdictionary,
                             regexp_replace(btrim(value), '\\s+', ' ', 'g')))
"""


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS unaccent SCHEMA public")
    op.execute(LABEL_KEY)
    for table in TAXONOMY_TABLES:
        op.drop_index(op.f(f"uq_{table}_lower_label"), table)
        op.create_index(
            op.f(f"uq_{table}_label_key"),
            table,
            [sa.literal_column("label_key(label)")],
            unique=True,
        )
    op.create_index(
        op.f("uq_internal_referents_name_key"),
        "internal_referents",
        [sa.literal_column("label_key(first_name)"), sa.literal_column("label_key(last_name)")],
        unique=True,
    )
    op.create_unique_constraint(
        op.f("uq_internal_referents_email"), "internal_referents", ["email"]
    )


def downgrade() -> None:
    op.drop_constraint(op.f("uq_internal_referents_email"), "internal_referents", type_="unique")
    op.drop_index(op.f("uq_internal_referents_name_key"), "internal_referents")
    for table in TAXONOMY_TABLES:
        op.drop_index(op.f(f"uq_{table}_label_key"), table)
        op.create_index(
            op.f(f"uq_{table}_lower_label"),
            table,
            [sa.literal_column("lower(label)")],
            unique=True,
        )
    op.execute("DROP FUNCTION label_key(text)")
    op.execute("DROP EXTENSION unaccent")
