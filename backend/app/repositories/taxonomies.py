"""Taxonomy persistence (roles, commercial segments, activity categories).

Label comparisons go through the SQL function `label_key` (migration 0005), the same key the unique
indexes use, so a query and the database agree on what a duplicate is.
"""

import uuid
from collections.abc import Iterable, Sequence

from sqlalchemy import ColumnElement, SQLColumnExpression, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models import Company, Prospect, company_activity_categories
from app.models.taxonomies import ActivityCategory, CommercialSegment, Role, TaxonomyMixin

type TaxonomyModel = type[Role] | type[CommercialSegment] | type[ActivityCategory]
# Rows of any of them (their shared columns).
type TaxonomyRow = TaxonomyMixin

# The column referencing each taxonomy, and what its rows are called in usage diagnostics.
USAGE: dict[TaxonomyModel, tuple[SQLColumnExpression[uuid.UUID | None], str]] = {
    Role: (Prospect.role_id, "prospects"),
    CommercialSegment: (Company.commercial_segment_id, "companies"),
    ActivityCategory: (company_activity_categories.c.activity_category_id, "companies"),
}


def label_key(value: SQLColumnExpression[str | None] | str) -> ColumnElement[str]:
    return func.label_key(value)


def matches_words(value: SQLColumnExpression[str], search: str) -> list[ColumnElement[bool]]:
    """Every word of `search` appears in `value`, compared through `label_key`."""
    return [func.strpos(label_key(value), label_key(word)) > 0 for word in search.split()]


def usage_count(model: TaxonomyModel) -> ColumnElement[int]:
    column, _ = USAGE[model]
    return select(func.count()).where(column == model.id).scalar_subquery()


def list_values(
    session: Session, model: TaxonomyModel, *, search: str | None, active: bool | None
) -> Sequence[tuple[TaxonomyRow, int]]:
    """`(row, usage count)` ordered by label as compared (accents and case ignored)."""
    statement = select(model, usage_count(model)).order_by(label_key(model.label), model.id)
    if active is not None:
        statement = statement.where(model.active.is_(active))
    if search:
        statement = statement.where(*matches_words(model.label, search))
    return session.execute(statement).tuples().all()


def get_value(session: Session, model: TaxonomyModel, value_id: uuid.UUID) -> TaxonomyRow | None:
    return session.get(model, value_id)


def count_usage(session: Session, model: TaxonomyModel, value_id: uuid.UUID) -> int:
    column, _ = USAGE[model]
    return session.execute(select(func.count()).where(column == value_id)).scalar_one()


def find_by_label(
    session: Session, model: TaxonomyModel, label: str, *, exclude_id: uuid.UUID | None = None
) -> TaxonomyRow | None:
    statement = select(model).where(label_key(model.label) == label_key(label))
    if exclude_id is not None:
        statement = statement.where(model.id != exclude_id)
    return session.execute(statement).scalars().first()


def slug_base(session: Session, label: str) -> str:
    """`label` as a slug: its `label_key` with every run of other characters turned into `-`."""
    slug = func.regexp_replace(label_key(label), "[^a-z0-9]+", "-", "g")
    base: str = session.execute(select(func.btrim(slug, "-"))).scalar_one()
    return base


def slugs_starting_with(session: Session, model: TaxonomyModel, base: str) -> set[str]:
    statement = select(model.slug).where(
        or_(model.slug == base, model.slug.startswith(f"{base}-", autoescape=True))
    )
    return set(session.execute(statement).scalars())


def insert_missing(
    session: Session, model: TaxonomyModel, values: Iterable[tuple[str, str]]
) -> Sequence[tuple[uuid.UUID, str, str]]:
    """Insert `(slug, label)` pairs, skipping any that clash with an existing slug or label.

    Existing rows are never modified (they may have been renamed or deactivated). Returns the
    inserted `(id, slug, label)` rows.
    """
    rows = [{"slug": slug, "label": label} for slug, label in values]
    statement = (
        insert(model)
        .values(rows)
        .on_conflict_do_nothing()
        .returning(model.id, model.slug, model.label)
    )
    return session.execute(statement).tuples().all()
