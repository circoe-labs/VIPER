"""ReferentService: Circoe internal referents (Settings, Task 06).

Referents are business records — the Circoe people named on a contact tracking once a meeting is
taken over — not login accounts: nothing here reads or writes `users`. Same lifecycle rules as the
taxonomies (`app.services.taxonomies`): stable ids, full names unique ignoring case/accents/spacing
(homonyms would be indistinguishable in pickers), e-mail optional but unique, deactivation keeps
existing references, deletion refused while a contact tracking names the referent.

Every mutation takes the server-side actor, annotates its audit event and flushes; the caller
owns the transaction.
"""

import re
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models import InternalReferent
from app.repositories import referents as repository
from app.services import audit
from app.services.audit import SettingsChange
from app.services.errors import (
    DuplicateValueError,
    ExistingValue,
    InUseError,
    InvalidFieldError,
    NotFoundError,
    is_foreign_key_violation,
    translated_violations,
    violated_constraint,
)
from app.services.taxonomies import required_text

NAME_MAX_LENGTH = 100
EMAIL_MAX_LENGTH = 320
EMAIL_PATTERN = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
ENTITY_TYPE = "internal_referent"


@dataclass(frozen=True, slots=True)
class ReferentInput:
    first_name: str
    last_name: str
    email: str | None = None


@dataclass(frozen=True, slots=True)
class ReferentValue:
    id: uuid.UUID
    first_name: str
    last_name: str
    email: str | None
    active: bool
    # Contact trackings naming this referent.
    usage_count: int
    created_at: datetime
    updated_at: datetime


def list_referents(
    session: Session, *, search: str | None = None, active: bool | None = None
) -> list[ReferentValue]:
    """Ordered by last then first name; `search` matches names and e-mail, word by word."""
    rows = repository.list_referents(session, search=(search or "").strip() or None, active=active)
    return [_value(row, usage) for row, usage in rows]


def get_referent(session: Session, referent_id: uuid.UUID) -> ReferentValue:
    row = _row(session, referent_id)
    return _value(row, repository.count_usage(session, row.id))


def create_referent(session: Session, actor: ActorContext, data: ReferentInput) -> ReferentValue:
    data = _cleaned(data)
    _refuse_duplicates(session, data)
    row = InternalReferent(first_name=data.first_name, last_name=data.last_name, email=data.email)
    audit.annotate(session, actor, row)
    with translated_violations(session, _duplicate_translator(session, data)):
        session.add(row)
    return _value(row, 0)


def update_referent(
    session: Session, actor: ActorContext, referent_id: uuid.UUID, data: ReferentInput
) -> ReferentValue:
    """Replace the name and e-mail (`internal_referent.updated`); references are untouched."""
    row = _row(session, referent_id)
    data = _cleaned(data)
    if (row.first_name, row.last_name, row.email) != (data.first_name, data.last_name, data.email):
        _refuse_duplicates(session, data, exclude_id=row.id)
        audit.annotate(session, actor, row)
        with translated_violations(session, _duplicate_translator(session, data)):
            row.first_name, row.last_name, row.email = data.first_name, data.last_name, data.email
    return get_referent(session, row.id)


def set_referent_active(
    session: Session, actor: ActorContext, referent_id: uuid.UUID, active: bool
) -> ReferentValue:
    """Deactivate (hidden from pickers, trackings keep it) or reactivate. Idempotent."""
    row = _row(session, referent_id)
    if row.active != active:
        change = SettingsChange.REACTIVATED if active else SettingsChange.DEACTIVATED
        audit.annotate(session, actor, row, audit.settings_action(ENTITY_TYPE, change))
        row.active = active
        session.flush()
    return get_referent(session, row.id)


def delete_referent(session: Session, actor: ActorContext, referent_id: uuid.UUID) -> None:
    """Delete a referent no contact tracking names; otherwise `InUseError`."""
    row = _row(session, referent_id)
    if (error := _in_use(session, row.id)) is not None:
        raise error
    audit.annotate(session, actor, row)

    def still_used(error: IntegrityError) -> InUseError | None:
        return _in_use(session, row.id) if is_foreign_key_violation(error) else None

    with translated_violations(session, still_used):
        session.delete(row)


def _row(session: Session, referent_id: uuid.UUID) -> InternalReferent:
    row = repository.get_referent(session, referent_id)
    if row is None:
        raise NotFoundError(f"Internal referent {referent_id} not found.")
    return row


def _value(row: InternalReferent, usage: int) -> ReferentValue:
    return ReferentValue(
        id=row.id,
        first_name=row.first_name,
        last_name=row.last_name,
        email=row.email,
        active=row.active,
        usage_count=usage,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _cleaned(data: ReferentInput) -> ReferentInput:
    email = (data.email or "").strip().lower() or None
    if email is not None and (len(email) > EMAIL_MAX_LENGTH or not EMAIL_PATTERN.fullmatch(email)):
        raise InvalidFieldError("email", "Invalid e-mail address.")
    return ReferentInput(
        first_name=required_text("first_name", data.first_name, NAME_MAX_LENGTH),
        last_name=required_text("last_name", data.last_name, NAME_MAX_LENGTH),
        email=email,
    )


def _existing(row: InternalReferent) -> ExistingValue:
    return ExistingValue(id=row.id, label=f"{row.first_name} {row.last_name}", active=row.active)


def _same(session: Session, data: ReferentInput, field: str) -> InternalReferent | None:
    if field == "name":
        return repository.find_by_name(session, data.first_name, data.last_name)
    return repository.find_by_email(session, data.email) if data.email else None


def _refuse_duplicates(
    session: Session, data: ReferentInput, *, exclude_id: uuid.UUID | None = None
) -> None:
    same_name = repository.find_by_name(
        session, data.first_name, data.last_name, exclude_id=exclude_id
    )
    if same_name is not None:
        raise DuplicateValueError("name", _existing(same_name))
    if data.email is not None:
        same_email = repository.find_by_email(session, data.email, exclude_id=exclude_id)
        if same_email is not None:
            raise DuplicateValueError("email", _existing(same_email))


def _duplicate_translator(
    session: Session, data: ReferentInput
) -> Callable[[IntegrityError], DuplicateValueError | None]:
    """Turns a unique violation that raced past `_refuse_duplicates` into the same error."""
    fields = {"uq_internal_referents_name_key": "name", "uq_internal_referents_email": "email"}

    def translate(error: IntegrityError) -> DuplicateValueError | None:
        field = fields.get(violated_constraint(error) or "")
        if field is None:
            return None
        same = _same(session, data, field)
        return DuplicateValueError(field, _existing(same) if same else None)

    return translate


def _in_use(session: Session, referent_id: uuid.UUID) -> InUseError | None:
    used = repository.count_usage(session, referent_id)
    return InUseError({repository.USAGE_NOUN: used}) if used else None
