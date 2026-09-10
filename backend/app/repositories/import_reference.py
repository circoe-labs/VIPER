"""Read-only queries feeding the import engine's reference snapshot (Task 08)."""

import uuid
from collections.abc import Sequence

from sqlalchemy import Row, select
from sqlalchemy.orm import Session

from app.models.companies import Company
from app.models.enums import ContactabilityStatus
from app.models.prospects import Email, Prospect
from app.models.taxonomies import InternalReferent
from app.repositories.taxonomies import TaxonomyModel


def taxonomy_rows(
    session: Session, model: TaxonomyModel
) -> Sequence[Row[tuple[uuid.UUID, str, str, bool]]]:
    return session.execute(
        select(model.id, model.label, model.slug, model.active).order_by(model.label, model.id)
    ).all()


def referent_rows(
    session: Session,
) -> Sequence[Row[tuple[uuid.UUID, str, str, str | None, bool]]]:
    return session.execute(
        select(
            InternalReferent.id,
            InternalReferent.first_name,
            InternalReferent.last_name,
            InternalReferent.email,
            InternalReferent.active,
        ).order_by(InternalReferent.last_name, InternalReferent.first_name, InternalReferent.id)
    ).all()


def company_rows(
    session: Session,
) -> Sequence[Row[tuple[uuid.UUID, str, str | None, str | None]]]:
    return session.execute(
        select(Company.id, Company.display_name, Company.legal_name, Company.email_domain).order_by(
            Company.id
        )
    ).all()


def prospect_rows(
    session: Session,
) -> Sequence[
    Row[tuple[uuid.UUID, str | None, str | None, uuid.UUID | None, ContactabilityStatus]]
]:
    return session.execute(
        select(
            Prospect.id,
            Prospect.first_name,
            Prospect.last_name,
            Prospect.company_id,
            Prospect.contactability_status,
        ).order_by(Prospect.id)
    ).all()


def email_rows(session: Session) -> Sequence[Row[tuple[uuid.UUID, str]]]:
    return session.execute(
        select(Email.prospect_id, Email.address).order_by(Email.prospect_id, Email.address)
    ).all()
