"""Synthetic entity builders and assertion helpers. Every value here is obviously fake."""

from collections.abc import Iterator
from contextlib import contextmanager
from functools import cache
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.core.security import hash_password
from app.models import AuditLogEntry, Company, Email, Phone, Prospect, Role, User
from app.models.enums import OriginType, PhoneType
from app.services import audit
from app.services.audit import AuditContext, AuditSource

OPERATOR = ActorContext(type=ActorType.HUMAN, display="Opératrice Test", id="test-user")
# Attribution of test setup data written directly through the ORM (fixtures, builders).
FIXTURE_ACTOR = ActorContext(type=ActorType.SYSTEM, display="Données de test", id="tests.fixtures")
# Message of the `guard_do_not_contact` trigger when a generic write tries to reset the status.
DNC_GUARD_MESSAGE = "is do_not_contact; use the clear operation"
REQUEST_ID = "test-request"


def bind_operator(session: Session) -> None:
    """Bind `OPERATOR` as a signed-in request would (`require_session`)."""
    audit.bind(session, OPERATOR, AuditContext(source=AuditSource.UI, request_id=REQUEST_ID))


def audit_events(
    session: Session, *, action: str | None = None, entity_type: str | None = None
) -> list[AuditLogEntry]:
    """Audit entries of the code under test, oldest first: setup writes by `FIXTURE_ACTOR` are
    left out (`test_fixture_writes_are_attributed_to_the_fixture_actor` covers them)."""
    statement = (
        select(AuditLogEntry)
        .where(AuditLogEntry.actor_id.is_distinct_from(FIXTURE_ACTOR.id))
        .order_by(AuditLogEntry.occurred_at, AuditLogEntry.id)
    )
    if action is not None:
        statement = statement.where(AuditLogEntry.action == action)
    if entity_type is not None:
        statement = statement.where(AuditLogEntry.entity_type == entity_type)
    return list(session.scalars(statement))


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


# Synthetic pilot account for tests only (never used outside the test database).
PILOT_EMAIL = "pilote.test@example.com"
PILOT_PASSWORD = "mot-de-passe-de-test-synthetique"


@cache
def password_hash(password: str) -> str:
    """argon2 is deliberately slow: hash each test password once per run."""
    return hash_password(password)


def add_user(
    session: Session,
    email: str = PILOT_EMAIL,
    password: str = PILOT_PASSWORD,
    display_name: str = "Pilote Test",
) -> User:
    user = User(email=email, display_name=display_name, password_hash=password_hash(password))
    session.add(user)
    session.flush()
    return user
