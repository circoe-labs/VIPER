"""What may be copied into the append-only audit log (`doc/architecture/audit-and-provenance.md`).

One place decides it for every event, explicit or captured at flush:

- **excluded entities** (login accounts, sessions): their field values never enter the log — auth
  events carry only who and when;
- **secret fields** (password/token hashes, CSRF…), matched by name or name fragment, are dropped
  at any depth;
- **masked fields** always keep only the fact that they changed;
- **personal fields** (prospect names, email addresses, phone numbers, source references) follow
  `personal_values`. V1 keeps them in full (decision I-27): the operator must be able to read
  "email changed from X to Y", and the audit log is no wider an exposure than the tables it
  describes. Switch to `MASKED` or `OMITTED` to tighten once retention is decided (open question
  #2); already written events then need an explicit redaction migration.

Payloads are never written to application logs.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class PersonalValues(StrEnum):
    FULL = "full"
    # First character and the email domain / last two digits, e.g. `j•••@example.com`, `•••01`.
    MASKED = "masked"
    OMITTED = "omitted"


MASKED_VALUE = "[masked]"
OMITTED_VALUE = "[personal]"


@dataclass(frozen=True, slots=True)
class AuditPayloadPolicy:
    excluded_entities: frozenset[str]
    secret_fields: frozenset[str]
    secret_fragments: tuple[str, ...]
    masked_fields: frozenset[str]
    # (entity type, field name)
    personal_fields: frozenset[tuple[str, str]]
    personal_values: PersonalValues


POLICY = AuditPayloadPolicy(
    excluded_entities=frozenset({"user", "user_session"}),
    secret_fields=frozenset({"password_hash", "token_hash", "csrf_token"}),
    secret_fragments=("password", "token", "secret", "csrf"),
    # Raw legacy workbook columns may hold unmapped personal data.
    masked_fields=frozenset({"legacy_metadata"}),
    personal_fields=frozenset(
        {
            ("prospect", "first_name"),
            ("prospect", "last_name"),
            ("email", "address"),
            ("email", "source_reference"),
            ("phone", "number"),
            ("phone", "source_reference"),
            ("prospect_source", "source_reference"),
        }
    ),
    personal_values=PersonalValues.FULL,
)


def is_secret(field: str, policy: AuditPayloadPolicy) -> bool:
    name = field.lower()
    return name in policy.secret_fields or any(part in name for part in policy.secret_fragments)


def mask_personal(value: Any) -> Any:
    if not isinstance(value, str) or not value:
        return value
    local, at, domain = value.partition("@")
    if at:
        return f"{local[:1]}•••@{domain}"
    if value.lstrip("+").isdigit():
        return f"•••{value[-2:]}"
    return f"{value[:1]}•••"


def _without_secrets(value: Any, policy: AuditPayloadPolicy) -> Any:
    if isinstance(value, dict):
        return {
            key: _without_secrets(item, policy)
            for key, item in value.items()
            if not is_secret(str(key), policy)
        }
    if isinstance(value, list):
        return [_without_secrets(item, policy) for item in value]
    return value


def _protect(value: Any, entity_type: str, field: str, policy: AuditPayloadPolicy) -> Any:
    if value is None:
        return None
    if field in policy.masked_fields:
        return MASKED_VALUE
    if (entity_type, field) in policy.personal_fields:
        match policy.personal_values:
            case PersonalValues.MASKED:
                return mask_personal(value)
            case PersonalValues.OMITTED:
                return OMITTED_VALUE
    return _without_secrets(value, policy)


def sanitize_changes(
    entity_type: str, changes: Mapping[str, Mapping[str, Any]], policy: AuditPayloadPolicy
) -> dict[str, dict[str, Any]]:
    """The storable version of `{field: {"before": …, "after": …, …}}` for `entity_type`."""
    if entity_type in policy.excluded_entities:
        return {}
    return {
        field: {
            key: _protect(value, entity_type, field, policy)
            if key in ("before", "after")
            else _without_secrets(value, policy)
            for key, value in change.items()
        }
        for field, change in changes.items()
        if not is_secret(field, policy)
    }
