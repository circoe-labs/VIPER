"""Taxonomy persistence (roles, commercial segments, activity categories)."""

import uuid
from collections.abc import Iterable, Sequence

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.orm import Session

from app.models.taxonomies import ActivityCategory, CommercialSegment, Role

type TaxonomyModel = type[Role] | type[CommercialSegment] | type[ActivityCategory]


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
