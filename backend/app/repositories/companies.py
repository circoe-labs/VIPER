"""Company and establishment persistence (Task 07 CompanyService, Task 03 company change)."""

import uuid
from collections.abc import Collection, Sequence

from sqlalchemy import ColumnElement, Row, SQLColumnExpression, and_, exists, func, or_, select
from sqlalchemy.orm import Session

from app.models import CommercialSegment, Company, Establishment, Prospect, Role
from app.models.taxonomies import ActivityCategory
from app.repositories.taxonomies import label_key, matches_words


def get_company(session: Session, company_id: uuid.UUID) -> Company | None:
    return session.get(Company, company_id)


def find_by_siren(
    session: Session, siren: str, *, exclude_id: uuid.UUID | None = None
) -> Company | None:
    statement = select(Company).where(Company.siren == siren)
    if exclude_id is not None:
        statement = statement.where(Company.id != exclude_id)
    return session.execute(statement).scalars().first()


def find_by_siret(
    session: Session, siret: str, *, exclude_ids: Collection[uuid.UUID] = ()
) -> Establishment | None:
    statement = select(Establishment).where(Establishment.siret == siret)
    if exclude_ids:
        statement = statement.where(Establishment.id.not_in(exclude_ids))
    return session.execute(statement).scalars().first()


def get_segment(session: Session, segment_id: uuid.UUID) -> CommercialSegment | None:
    return session.get(CommercialSegment, segment_id)


def categories(session: Session, ids: Collection[uuid.UUID]) -> Sequence[ActivityCategory]:
    return (
        session.execute(select(ActivityCategory).where(ActivityCategory.id.in_(ids)))
        .scalars()
        .all()
    )


def prospect_count(company_id: uuid.UUID | SQLColumnExpression[uuid.UUID]) -> ColumnElement[int]:
    return select(func.count()).where(Prospect.company_id == company_id).scalar_subquery()


def count_prospects(session: Session, company_id: uuid.UUID) -> int:
    return session.execute(select(prospect_count(company_id))).scalar_one()


def company_prospects(
    session: Session, company_id: uuid.UUID, *, limit: int
) -> Sequence[tuple[Prospect, str | None]]:
    """The company's prospects with their role label, by last then first name."""
    statement = (
        select(Prospect, Role.label)
        .outerjoin(Role, Role.id == Prospect.role_id)
        .where(Prospect.company_id == company_id)
        .order_by(
            func.lower(Prospect.last_name).nulls_last(),
            func.lower(Prospect.first_name).nulls_last(),
            Prospect.id,
        )
        .limit(limit)
    )
    return session.execute(statement).tuples().all()


def _search_condition(search: str) -> ColumnElement[bool]:
    """Every word in the names, e-mail domain or website (case/accents ignored); a query made of
    digits (spaces allowed) also matches a SIREN or an establishment's SIRET containing them."""
    text = func.concat_ws(
        " ", Company.display_name, Company.legal_name, Company.email_domain, Company.website_url
    )
    condition: ColumnElement[bool] = and_(*matches_words(text, search))
    digits = "".join(search.split())
    if digits.isdigit():
        siret = exists().where(
            Establishment.company_id == Company.id,
            Establishment.siret.contains(digits, autoescape=True),
        )
        condition = or_(condition, Company.siren.contains(digits, autoescape=True), siret)
    return condition


def _primary_city() -> ColumnElement[str | None]:
    return (
        select(Establishment.city)
        .where(Establishment.company_id == Company.id, Establishment.is_primary)
        .scalar_subquery()
    )


def company_summary(
    session: Session, company_id: uuid.UUID
) -> tuple[Company, str | None, int, str | None] | None:
    """`(company, segment label, prospect count, primary city)`, or None when it does not exist."""
    statement = (
        select(Company, CommercialSegment.label, prospect_count(Company.id), _primary_city())
        .outerjoin(CommercialSegment, CommercialSegment.id == Company.commercial_segment_id)
        .where(Company.id == company_id)
    )
    return session.execute(statement).tuples().one_or_none()


def list_companies(
    session: Session, *, search: str | None, limit: int, offset: int
) -> tuple[Sequence[Row[tuple[Company, str | None, int, int, str | None]]], int]:
    """`(company, segment label, prospect count, establishment count, primary city)` rows ordered
    by display name as compared (case/accents ignored), and the total number of matches."""
    where = [_search_condition(search)] if search else []
    establishment_count = (
        select(func.count()).where(Establishment.company_id == Company.id).scalar_subquery()
    )
    statement = (
        select(
            Company,
            CommercialSegment.label,
            prospect_count(Company.id),
            establishment_count,
            _primary_city(),
        )
        .outerjoin(CommercialSegment, CommercialSegment.id == Company.commercial_segment_id)
        .where(*where)
        .order_by(label_key(Company.display_name), Company.id)
        .limit(limit)
        .offset(offset)
    )
    total = session.execute(select(func.count()).select_from(Company).where(*where)).scalar_one()
    return session.execute(statement).tuples().all(), total
