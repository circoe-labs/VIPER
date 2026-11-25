"""Read-only queries feeding the import engine's reference snapshot (Task 08)."""

import uuid
from collections.abc import Sequence
from datetime import date

from sqlalchemy import Row, func, select
from sqlalchemy.orm import Session

from app.models.companies import Company, Establishment
from app.models.contact_sequences import Cohort
from app.models.enums import ContactabilityStatus
from app.models.prospects import Email, Prospect
from app.models.users import User
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
            User.id,
            func.split_part(User.display_name, " ", 1),
            func.coalesce(
                func.nullif(
                    func.btrim(
                        func.substr(User.display_name, func.strpos(User.display_name, " ") + 1)
                    ),
                    "",
                ),
                User.display_name,
            ),
            User.email,
            User.is_active,
        ).order_by(User.display_name, User.id)
    ).all()


def company_rows(
    session: Session,
) -> Sequence[Row[tuple[uuid.UUID, str, str | None, str | None]]]:
    return session.execute(
        select(Company.id, Company.display_name, Company.legal_name, Company.email_domain).order_by(
            Company.id
        )
    ).all()


def siren_rows(session: Session) -> list[tuple[uuid.UUID, str]]:
    """(company, SIREN or SIRET) of every company and establishment that has one."""
    companies = session.execute(
        select(Company.id, Company.siren).where(Company.siren.is_not(None))
    ).all()
    sites = session.execute(
        select(Establishment.company_id, Establishment.siret).where(
            Establishment.siret.is_not(None)
        )
    ).all()
    return [(company_id, value) for company_id, value in (*companies, *sites) if value]


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


def cohort_rows(session: Session) -> Sequence[Row[tuple[uuid.UUID, str, date | None]]]:
    return session.execute(
        select(Cohort.id, Cohort.code, Cohort.starts_on).order_by(Cohort.code)
    ).all()


def email_rows(session: Session) -> Sequence[Row[tuple[uuid.UUID, str]]]:
    return session.execute(
        select(Email.prospect_id, Email.address).order_by(Email.prospect_id, Email.address)
    ).all()
