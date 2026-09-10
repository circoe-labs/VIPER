"""Read-only queries feeding the Excel export projection (Task 10): every exported entity, once."""

from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.models.companies import Company
from app.models.contact_tracking import ContactTracking
from app.models.imports import ImportBatch, ImportRowMetadata
from app.models.prospects import Prospect, ProspectSource
from app.models.taxonomies import CommercialSegment, InternalReferent, Role


def prospects(session: Session) -> Sequence[Prospect]:
    return session.scalars(
        select(Prospect).options(
            selectinload(Prospect.emails),
            selectinload(Prospect.phones),
            selectinload(Prospect.contact_tracking).selectinload(ContactTracking.status_history),
        )
    ).all()


def companies(session: Session) -> Sequence[Company]:
    return session.scalars(
        select(Company).options(
            selectinload(Company.activity_categories), selectinload(Company.establishments)
        )
    ).all()


def roles(session: Session) -> Sequence[Role]:
    return session.scalars(select(Role)).all()


def segments(session: Session) -> Sequence[CommercialSegment]:
    return session.scalars(select(CommercialSegment)).all()


def referents(session: Session) -> Sequence[InternalReferent]:
    return session.scalars(select(InternalReferent)).all()


def sources(session: Session) -> Sequence[ProspectSource]:
    return session.scalars(select(ProspectSource)).all()


def import_batches(session: Session) -> Sequence[ImportBatch]:
    return session.scalars(select(ImportBatch)).all()


def row_metadata(session: Session) -> Sequence[ImportRowMetadata]:
    return session.scalars(select(ImportRowMetadata)).all()
