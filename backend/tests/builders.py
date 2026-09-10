"""Synthetic entity builders and assertion helpers. Every value here is obviously fake."""

from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import Company, Email, Phone, Prospect, Role
from app.models.enums import OriginType, PhoneType

OPERATOR = ActorContext(type=ActorType.HUMAN, display="Opératrice Test", id="test-user")
# Message of the `guard_do_not_contact` trigger when a generic write tries to reset the status.
DNC_GUARD_MESSAGE = "is do_not_contact; use the clear operation"


@contextmanager
def rejected(session: Session, match: str) -> Iterator[None]:
    """Assert that the block's writes fail in the database with an error mentioning `match`.

    The block runs in a savepoint, so the session stays usable afterwards.
    """
    with pytest.raises(IntegrityError) as caught, session.begin_nested():
        yield
        session.flush()
    assert match in str(caught.value.orig)


def add_company(
    session: Session, display_name: str = "Transports Exemple SARL", **fields: Any
) -> Company:
    company = Company(display_name=display_name, **fields)
    session.add(company)
    session.flush()
    return company


def add_prospect(session: Session, company: Company | None = None, **fields: Any) -> Prospect:
    fields.setdefault("first_name", "Jean")
    fields.setdefault("last_name", "Test")
    prospect = Prospect(company_id=company.id if company else None, **fields)
    session.add(prospect)
    session.flush()
    return prospect


def add_email(session: Session, prospect: Prospect, address: str, **fields: Any) -> Email:
    fields.setdefault("origin_type", OriginType.MANUAL)
    email = Email(prospect_id=prospect.id, address=address, **fields)
    session.add(email)
    session.flush()
    return email


def add_phone(session: Session, prospect: Prospect, number: str, **fields: Any) -> Phone:
    fields.setdefault("origin_type", OriginType.MANUAL)
    fields.setdefault("type", PhoneType.LANDLINE)
    phone = Phone(prospect_id=prospect.id, number=number, **fields)
    session.add(phone)
    session.flush()
    return phone


def add_role(session: Session, slug: str = "role-test", label: str = "Rôle test") -> Role:
    role = Role(slug=slug, label=label)
    session.add(role)
    session.flush()
    return role
