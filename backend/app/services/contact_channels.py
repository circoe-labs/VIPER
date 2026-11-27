"""ContactChannelService: a prospect's e-mail and phone aliases, saved as full lists (Task 15).

Rules (`doc/features/prospect-editor.md`, *E-mails and phones*):

- values are normalized with the import's rules: e-mail addresses trimmed and lowercase with a
  valid syntax; phone numbers without formatting, French numbers as `+33…`;
- a list is the full list: an alias left out is deleted; the same value twice is refused;
  two aliases may exchange their values in one save (the stored row follows the value);
- exactly one active primary per kind while any alias is active — none flagged: the first active
  one; two flagged, or a primary that is inactive: refused;
- verification is per alias and explicit: `verified_now` (the one-click « Vérifié ») sets the
  status `verified` dated now; `verified` without it is accepted only for an alias already verified
  whose value did not change (after the company-change rule, which the caller applies first);
  other statuses keep the last verification date; a changed value was never verified
  (`last_verified_at` cleared) and was typed by the user (`origin_type = manual`, like new ones);
- an e-mail address that looks like someone else's (`app.services.email_identity`) is not
  verified without the person's explicit `identity_confirmed` (field error `identity_doubt`);
  where no person looks at that address (`doubt_unverifies`: accepting an agent's proposal) it is
  saved unverified instead.

Writes happen in two flushes so the database's partial unique indexes never see a transient clash:
first deletions and aliases losing the primary flag (freeing their value and the primary slot),
then the other changes and new aliases. Each alias changes in one flush: one audit event per row.
"""

import uuid
from collections.abc import Callable, Sequence
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.enums import OriginType, PhoneType, VerificationStatus
from app.models.prospects import Email, Phone, Prospect
from app.services import audit, email_identity
from app.services.contact_recipients import Followed, addresses, follow_address_change
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
    # E-mails only: the person says this address, whatever it looks like, is the prospect's.
    identity_confirmed: bool = False
    # E-mails only: a doubtful address is saved unverified instead of refusing `verified_now`.
    doubt_unverifies: bool = False


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


def _bind(
    kind: ChannelKind,
    owned: dict[uuid.UUID, Channel],
    items: Sequence[ChannelItem],
    values: Sequence[str],
) -> list[Channel | None]:
    """The stored row each item is written to (None: a new row). A value that already has a row
    stays on it — so aliases that exchange or pass on their values never collide on the unique
    index — and an edited item otherwise keeps its own row, or takes one that was freed."""
    by_value = {getattr(row, kind.value_field): row for row in owned.values()}
    listed = {item.id for item in items if item.id is not None}
    rows: list[Channel | None] = [None] * len(items)
    taken: set[uuid.UUID] = set()
    for index, (item, value) in enumerate(zip(items, values, strict=True)):
        row = by_value.get(value)
        # A new item takes an existing row only when an edited alias is leaving that value.
        if row is not None and (item.id is not None or row.id in listed):
            rows[index] = row
            taken.add(row.id)
    for index, item in enumerate(items):
        if rows[index] is not None or item.id is None:
            continue
        freed = [owned[item.id], *(owned[i.id] for i in items if i.id is not None)]
        row = next((candidate for candidate in freed if candidate.id not in taken), None)
        if row is not None:
            rows[index] = row
            taken.add(row.id)
    return rows


def _plan(
    kind: ChannelKind, owned: dict[uuid.UUID, Channel], items: Sequence[ChannelItem], now: datetime
) -> list[_Planned]:
    planned: list[_Planned] = []
    seen_ids: set[uuid.UUID] = set()
    values_given: list[str] = []
    primaries: list[int] = []
    for index, item in enumerate(items):
        path = f"{kind.collection}.{index}"
        if item.id is not None:
            if item.id not in owned or item.id in seen_ids:
                raise InvalidFieldError(f"{path}.id", "Not an alias of this prospect.", "unknown")
            seen_ids.add(item.id)
        value = kind.normalize(f"{path}.{kind.value_field}", item.value)
        if value in values_given:
            raise InvalidFieldError(f"{path}.{kind.value_field}", "Value given twice.", "repeated")
        values_given.append(value)
    rows = _bind(kind, owned, items, values_given)
    for index, (item, value, row) in enumerate(zip(items, values_given, rows, strict=True)):
        path = f"{kind.collection}.{index}"
        if item.is_primary and not item.is_active:
            raise InvalidFieldError(f"{path}.is_primary", "A primary alias is active.", "inactive")
        if item.is_primary:
            primaries.append(index)
        changed = row is not None and getattr(row, kind.value_field) != value
        if (
            row is not None
            and row.id != item.id
            and not changed
            and not item.verified_now
            and item.verification_status is VerificationStatus.UNVERIFIED
        ):
            # An exchange: the verification belongs to the address, which keeps it.
            item = replace(item, verification_status=row.verification_status)
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


def _check_identity(
    session: Session,
    prospect: Prospect,
    items: Sequence[ChannelItem],
    planned: Sequence[_Planned],
) -> None:
    """An address being verified now must not look like someone else's (module rules). Called
    before anything is written."""
    checked = [
        (index, item, plan)
        for index, (item, plan) in enumerate(zip(items, planned, strict=True))
        if item.verified_now and not item.identity_confirmed
    ]
    if not checked:
        return
    doubts = email_identity.pair_doubts(
        session, {(prospect.id, plan.values["address"]) for _, _, plan in checked}
    )
    for index, item, plan in checked:
        if (prospect.id, plan.values["address"]) not in doubts:
            continue
        if not item.doubt_unverifies:
            raise InvalidFieldError(
                f"emails.{index}.verified_now", email_identity.MESSAGE, "identity_doubt"
            )
        plan.values["verification_status"] = VerificationStatus.UNVERIFIED
        plan.values["last_verified_at"] = None


def save_channels(
    session: Session,
    actor: ActorContext,
    prospect: Prospect,
    kind: ChannelKind,
    items: Sequence[ChannelItem],
    *,
    now: datetime,
) -> Followed:
    """Replace the prospect's e-mails or phones by `items` (see the module rules). Refusals are
    `InvalidFieldError`s with the item's path; nothing is written before every item is valid.
    Unsent Contact messages follow an address change (`contact_recipients`)."""
    before = addresses(session, prospect.id) if kind is EMAILS else None
    collection: list[Channel] = getattr(prospect, kind.collection)
    owned = {row.id: row for row in collection}
    planned = _plan(kind, owned, items, now)
    if kind is EMAILS:
        _check_identity(session, prospect, items, planned)
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
    if before is None:
        return Followed()
    session.flush()
    followed = follow_address_change(session, actor, prospect.id, before)
    for item, plan in zip(items, planned, strict=True):
        if item.identity_confirmed:
            email_identity.confirm(session, actor, prospect.id, plan.values["address"])
    return followed
