"""ContactChannelService: a prospect's e-mail and phone aliases, saved as full lists (Task 15).

Rules (`doc/features/prospect-editor.md`, *E-mails and phones*):

- values are normalized with the import's rules: e-mail addresses trimmed and lowercase with a
  valid syntax; phone numbers without formatting, French numbers as `+33…`;
- a list is the full list: an alias left out is deleted; the same value twice is refused;
- exactly one active primary per kind while any alias is active — none flagged: the first active
  one; two flagged, or a primary that is inactive: refused;
- verification is per alias and explicit: `verified_now` (the one-click « Vérifié ») sets the
  status `verified` dated now; `verified` without it is accepted only for an alias already verified
  whose value did not change (after the company-change rule, which the caller applies first);
  other statuses keep the last verification date; a changed value was never verified
  (`last_verified_at` cleared) and was typed by the user (`origin_type = manual`, like new ones).

Writes happen in two flushes so the database's partial unique indexes never see a transient clash:
first deletions and aliases losing the primary flag (freeing their value and the primary slot),
then the other changes and new aliases. Each alias changes in one flush: one audit event per row.
"""

import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.enums import OriginType, PhoneType, VerificationStatus
from app.models.prospects import Email, Phone, Prospect
from app.services import audit
from app.services.errors import InvalidFieldError, translated_violations, violated_constraint
from app.services.imports.normalize import (
    EMAIL_PATTERN,
    MAX_EMAIL_LENGTH,
    PHONE_FORMATTING,
    normalize_phone,
)

SOURCE_MAX_LENGTH = 1000


def normalize_email_address(field: str, value: str) -> str:
    """`  Jean.Test@Exemple.FR ` → `jean.test@exemple.fr`; `mailto:` is dropped."""
    text = value.strip().lower().removeprefix("mailto:")
    if not text:
        raise InvalidFieldError(field, "An e-mail address is required.", "blank")
    if len(text) > MAX_EMAIL_LENGTH or not EMAIL_PATTERN.fullmatch(text):
        raise InvalidFieldError(field, "Invalid e-mail address.", "format")
    return text


def normalize_phone_number(field: str, value: str) -> str:
    """`06 12 34 56 78`, `+33 (0)6 12…`, `0033 6…` → `+33612345678`; other international numbers
    keep their digits."""
    cleaned = PHONE_FORMATTING.sub("", value.replace("(0)", ""))
    if not cleaned:
        raise InvalidFieldError(field, "A phone number is required.", "blank")
    number, _ = normalize_phone(cleaned, numeric=False)
    if number is None:
        raise InvalidFieldError(field, "Invalid phone number.", "format")
    return number


@dataclass(frozen=True, slots=True)
class ChannelItem:
    """One alias of the edited list. `id` None: a new alias."""

    value: str
    id: uuid.UUID | None = None
    is_primary: bool = False
    is_active: bool = True
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    # The user verified it just now (one-click « Vérifié »): `verified`, dated now.
    verified_now: bool = False
    source_reference: str | None = None
    phone_type: PhoneType | None = None  # phones only


type Channel = Email | Phone


@dataclass(frozen=True, slots=True)
class ChannelKind:
    model: type[Email] | type[Phone]
    # Collection on Prospect, also the path prefix of refused fields (`emails.1.address`).
    collection: str
    # Column holding the value, also the payload field name.
    value_field: str
    normalize: Callable[[str, str], str]
    # Unique index on (prospect, value).
    unique_index: str


EMAILS = ChannelKind(
    Email, "emails", "address", normalize_email_address, "uq_emails_prospect_id_address"
)
PHONES = ChannelKind(
    Phone, "phones", "number", normalize_phone_number, "uq_phones_prospect_id_number"
)


@dataclass(frozen=True, slots=True, eq=False)
class _Planned:
    row: Channel | None
    values: dict[str, Any]


def _source(field: str, value: str | None) -> str | None:
    text = (value or "").strip() or None
    if text is not None and len(text) > SOURCE_MAX_LENGTH:
        raise InvalidFieldError(field, "Source reference is too long.", "length")
    return text


def _verification(
    path: str, item: ChannelItem, row: Channel | None, changed: bool, now: datetime
) -> tuple[VerificationStatus, datetime | None]:
    if item.verified_now:
        return VerificationStatus.VERIFIED, now
    kept_date = None if row is None or changed else row.last_verified_at
    if item.verification_status is not VerificationStatus.VERIFIED:
        return item.verification_status, kept_date
    if row is not None and not changed and row.verification_status is VerificationStatus.VERIFIED:
        return VerificationStatus.VERIFIED, kept_date
    raise InvalidFieldError(
        f"{path}.verification_status",
        "Only an explicit verification (verified_now) makes an alias verified.",
        "verification_action",
    )


def _plan(
    kind: ChannelKind, owned: dict[uuid.UUID, Channel], items: Sequence[ChannelItem], now: datetime
) -> list[_Planned]:
    planned: list[_Planned] = []
    seen_ids: set[uuid.UUID] = set()
    seen_values: set[str] = set()
    primaries: list[int] = []
    for index, item in enumerate(items):
        path = f"{kind.collection}.{index}"
        row = None
        if item.id is not None:
            row = owned.get(item.id)
            if row is None or item.id in seen_ids:
                raise InvalidFieldError(f"{path}.id", "Not an alias of this prospect.", "unknown")
            seen_ids.add(item.id)
        value = kind.normalize(f"{path}.{kind.value_field}", item.value)
        if value in seen_values:
            raise InvalidFieldError(f"{path}.{kind.value_field}", "Value given twice.", "repeated")
        seen_values.add(value)
        if item.is_primary and not item.is_active:
            raise InvalidFieldError(f"{path}.is_primary", "A primary alias is active.", "inactive")
        if item.is_primary:
            primaries.append(index)
        changed = row is not None and getattr(row, kind.value_field) != value
        status, verified_at = _verification(path, item, row, changed, now)
        values: dict[str, Any] = {
            kind.value_field: value,
            "is_primary": item.is_primary,
            "is_active": item.is_active,
            "verification_status": status,
            "last_verified_at": verified_at,
            "origin_type": OriginType.MANUAL if row is None or changed else row.origin_type,
            "source_reference": _source(f"{path}.source_reference", item.source_reference),
        }
        if kind is PHONES:
            if item.phone_type is None:
                raise InvalidFieldError(f"{path}.type", "A phone number needs its type.", "blank")
            values["type"] = item.phone_type
        planned.append(_Planned(row, values))
    if len(primaries) > 1:
        raise InvalidFieldError(
            f"{kind.collection}.{primaries[1]}.is_primary", "Only one primary alias.", "multiple"
        )
    if not primaries:
        first_active = next((plan for plan in planned if plan.values["is_active"]), None)
        if first_active is not None:
            first_active.values["is_primary"] = True
    return planned


def _differs(row: Channel, values: dict[str, Any]) -> bool:
    return any(getattr(row, name) != value for name, value in values.items())


def _write(session: Session, actor: ActorContext, row: Channel, values: dict[str, Any]) -> None:
    if _differs(row, values):
        audit.annotate(session, actor, row)
        for name, value in values.items():
            setattr(row, name, value)


def save_channels(
    session: Session,
    actor: ActorContext,
    prospect: Prospect,
    kind: ChannelKind,
    items: Sequence[ChannelItem],
    *,
    now: datetime,
) -> None:
    """Replace the prospect's e-mails or phones by `items` (see the module rules). Refusals are
    `InvalidFieldError`s with the item's path; nothing is written before every item is valid."""
    collection: list[Channel] = getattr(prospect, kind.collection)
    owned = {row.id: row for row in collection}
    planned = _plan(kind, owned, items, now)
    kept = {plan.row.id for plan in planned if plan.row is not None}
    losing_primary = [
        plan
        for plan in planned
        if plan.row is not None and plan.row.is_primary and not plan.values["is_primary"]
    ]

    def exchanged(error: IntegrityError) -> InvalidFieldError | None:
        if violated_constraint(error) != kind.unique_index:
            return None
        return InvalidFieldError(
            kind.collection, "Two aliases exchange their values: save in two steps.", "exchange"
        )

    with translated_violations(session, exchanged):
        for row in [row for row in collection if row.id not in kept]:
            audit.annotate(session, actor, row)
            collection.remove(row)
            session.delete(row)
        for plan in losing_primary:
            assert plan.row is not None
            _write(session, actor, plan.row, plan.values)
    with translated_violations(session, exchanged):
        for plan in planned:
            if plan in losing_primary:
                continue
            if plan.row is None:
                row = kind.model()
                for name, value in plan.values.items():
                    setattr(row, name, value)
                audit.annotate(session, actor, row)
                collection.append(row)
            else:
                _write(session, actor, plan.row, plan.values)
