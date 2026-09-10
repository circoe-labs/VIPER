"""Company persistence."""

import uuid

from sqlalchemy.orm import Session

from app.models.companies import Company


def get_company(session: Session, company_id: uuid.UUID) -> Company | None:
    return session.get(Company, company_id)
