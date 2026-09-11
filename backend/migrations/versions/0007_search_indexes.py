"""Global search (Task 17, ADR-0017): search keys and their trigram indexes.

`search_key(text)` folds a text for search — accents removed (`unaccent`) and lowercased, like
`label_key` without its whitespace clean-up, which made it about four times slower per row;
`person_search_key(first, last)` is the folded full name "first last". `pg_trgm` (contrib, trusted
since PostgreSQL 13) lets GIN indexes answer `LIKE '%…%'` (a word of 3+ characters anywhere) and
`LIKE 'ab%'` / `LIKE '% ab%'` (a shorter word starting a word) on those keys, on e-mail addresses
and on phone numbers, so a search reads the matching rows instead of folding every name of the base.

Revision ID: 0007
Revises: 0006
Create Date: 2026-09-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# SQL-standard bodies: parsed once, dependencies tracked, independent of search_path.
FUNCTIONS = (
    """
    CREATE FUNCTION search_key(value text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    RETURN lower(public.unaccent('public.unaccent'::regdictionary, value))
    """,
    """
    CREATE FUNCTION person_search_key(first_name text, last_name text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    RETURN public.search_key(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
    """,
)

# (index, table, indexed expression)
TRIGRAM_INDEXES = (
    (
        "ix_prospects_person_search_key_trgm",
        "prospects",
        "person_search_key(first_name, last_name)",
    ),
    ("ix_emails_address_trgm", "emails", "address"),
    ("ix_phones_number_trgm", "phones", "number"),
    ("ix_companies_display_name_search_key_trgm", "companies", "search_key(display_name)"),
    ("ix_companies_legal_name_search_key_trgm", "companies", "search_key(legal_name)"),
    ("ix_establishments_name_search_key_trgm", "establishments", "search_key(name)"),
    ("ix_establishments_city_search_key_trgm", "establishments", "search_key(city)"),
)


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm SCHEMA public")
    for function in FUNCTIONS:
        op.execute(function)
    for name, table, expression in TRIGRAM_INDEXES:
        op.create_index(
            op.f(name),
            table,
            [sa.literal_column(f"{expression} gin_trgm_ops")],
            postgresql_using="gin",
        )


def downgrade() -> None:
    for name, table, _ in reversed(TRIGRAM_INDEXES):
        op.drop_index(op.f(name), table)
    op.execute("DROP FUNCTION person_search_key(text, text)")
    op.execute("DROP FUNCTION search_key(text)")
    op.execute("DROP EXTENSION pg_trgm")
