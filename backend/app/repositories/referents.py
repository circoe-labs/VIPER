"""Internal referent persistence (Circoe people named on contact tracking; not login accounts)."""

import uuid
from collections.abc import Sequence

from sqlalchemy import ColumnElement, func, select
from sqlalchemy.orm import Session

from app.models import ContactTracking, InternalReferent
from app.repositories.taxonomies import label_key, matches_words

# What rows referencing a referent are called in usage diagnostics.
USAGE_NOUN = "contact_trackings"


def usage_count() -> ColumnElement[int]:
    return (
        select(func.count())
        .where(ContactTracking.referent_id == InternalReferent.id)
        .scalar_subquery()
    )


def list_referents(
    session: Session, *, search: str | None, active: bool | None
) -> Sequence[tuple[InternalReferent, int]]:
    """`(referent, usage count)` ordered by last then first name (accents and case ignored)."""
    statement = select(InternalReferent, usage_count()).order_by(
        label_key(InternalReferent.last_name),
        label_key(InternalReferent.first_name),
        InternalReferent.id,
    )
    if active is not None:
        statement = statement.where(InternalReferent.active.is_(active))
    if search:
        searchable = func.concat_ws(
            " ", InternalReferent.first_name, InternalReferent.last_name, InternalReferent.email
        )
        statement = statement.where(*matches_words(searchable, search))
    return session.execute(statement).tuples().all()


def get_referent(session: Session, referent_id: uuid.UUID) -> InternalReferent | None:
    return session.get(InternalReferent, referent_id)


def count_usage(session: Session, referent_id: uuid.UUID) -> int:
    statement = select(func.count()).where(ContactTracking.referent_id == referent_id)
    return session.execute(statement).scalar_one()


def find_by_name(
    session: Session, first_name: str, last_name: str, *, exclude_id: uuid.UUID | None = None
) -> InternalReferent | None:
    statement = select(InternalReferent).where(
        label_key(InternalReferent.first_name) == label_key(first_name),
        label_key(InternalReferent.last_name) == label_key(last_name),
    )
    if exclude_id is not None:
        statement = statement.where(InternalReferent.id != exclude_id)
    return session.execute(statement).scalars().first()


def find_by_email(
    session: Session, email: str, *, exclude_id: uuid.UUID | None = None
) -> InternalReferent | None:
    statement = select(InternalReferent).where(InternalReferent.email == email)
    if exclude_id is not None:
        statement = statement.where(InternalReferent.id != exclude_id)
    return session.execute(statement).scalars().first()
