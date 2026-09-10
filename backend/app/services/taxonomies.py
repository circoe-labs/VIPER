"""TaxonomyService: roles, activity categories and commercial segments (Settings, Task 06).

Rules (`doc/features/settings-taxonomies.md`):

- ids and slugs are stable: renaming changes the label only (seeds, imports and future agents
  match on the slug; references use the id);
- labels are unique through `label_key` — case, accents and spacing ignored — inactive values
  included, so the user reactivates instead of duplicating;
- deactivating hides a value from pickers and keeps every existing reference;
- deleting is refused while anything references the value (`InUseError` with the counts).

Every mutation takes the server-side actor, annotates its audit event (`role.created`,
`role.renamed`, `role.deactivated`, …) and flushes; the caller owns the transaction.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.taxonomies import ActivityCategory, CommercialSegment, Role
from app.repositories import taxonomies as repository
from app.repositories.taxonomies import TaxonomyModel, TaxonomyRow
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


class Taxonomy(StrEnum):
    """The administrable taxonomies; values are their audit entity types."""

    ROLE = "role"
    ACTIVITY_CATEGORY = "activity_category"
    COMMERCIAL_SEGMENT = "commercial_segment"


MODELS: dict[Taxonomy, TaxonomyModel] = {
    Taxonomy.ROLE: Role,
    Taxonomy.ACTIVITY_CATEGORY: ActivityCategory,
    Taxonomy.COMMERCIAL_SEGMENT: CommercialSegment,
}
LABEL_MAX_LENGTH = 255
SLUG_MAX_LENGTH = 100
# Slug of a label without any letter or digit (e.g. "—").
FALLBACK_SLUG = "valeur"


@dataclass(frozen=True, slots=True)
class TaxonomyValue:
    id: uuid.UUID
    label: str
    slug: str
    active: bool
    # Rows referencing the value: prospects (roles) or companies (segments, categories).
    usage_count: int
    created_at: datetime
    updated_at: datetime


def normalize_text(value: str) -> str:
    """How Settings texts are stored: trimmed, inner whitespace collapsed to one space."""
    return " ".join(value.split())


def required_text(field: str, value: str, max_length: int) -> str:
    cleaned = normalize_text(value)
    if not cleaned:
        raise InvalidFieldError(field, f"{field} must not be blank.")
    if len(cleaned) > max_length:
        raise InvalidFieldError(field, f"{field} is longer than {max_length} characters.")
    return cleaned


def list_values(
    session: Session,
    taxonomy: Taxonomy,
    *,
    search: str | None = None,
    active: bool | None = None,
) -> list[TaxonomyValue]:
    """Values ordered by label; `search` matches every word, ignoring case and accents."""
    rows = repository.list_values(
        session, MODELS[taxonomy], search=(search or "").strip() or None, active=active
    )
    return [_value(row, usage) for row, usage in rows]


def get_value(session: Session, taxonomy: Taxonomy, value_id: uuid.UUID) -> TaxonomyValue:
    row = _row(session, taxonomy, value_id)
    return _value(row, repository.count_usage(session, MODELS[taxonomy], row.id))


def create_value(
    session: Session, actor: ActorContext, taxonomy: Taxonomy, label: str
) -> TaxonomyValue:
    """New active value, from Settings or inline from a form's picker (same rules, same audit)."""
    model = MODELS[taxonomy]
    label = required_text("label", label, LABEL_MAX_LENGTH)
    _refuse_duplicate(session, model, label)
    row = model(label=label, slug=_free_slug(session, model, label))
    audit.annotate(session, actor, row)
    with translated_violations(session, _duplicate_translator(session, model, label)):
        session.add(row)
    return _value(row, 0)


def rename_value(
    session: Session, actor: ActorContext, taxonomy: Taxonomy, value_id: uuid.UUID, label: str
) -> TaxonomyValue:
    """Change the label only: id, slug and every reference stay as they are."""
    model = MODELS[taxonomy]
    row = _row(session, taxonomy, value_id)
    label = required_text("label", label, LABEL_MAX_LENGTH)
    if label != row.label:
        _refuse_duplicate(session, model, label, exclude_id=row.id)
        audit.annotate(session, actor, row, _action(model, SettingsChange.RENAMED))
        with translated_violations(session, _duplicate_translator(session, model, label)):
            row.label = label
    return get_value(session, taxonomy, row.id)


def set_value_active(
    session: Session, actor: ActorContext, taxonomy: Taxonomy, value_id: uuid.UUID, active: bool
) -> TaxonomyValue:
    """Deactivate (hidden from pickers, references kept) or reactivate. Idempotent."""
    model = MODELS[taxonomy]
    row = _row(session, taxonomy, value_id)
    if row.active != active:
        change = SettingsChange.REACTIVATED if active else SettingsChange.DEACTIVATED
        audit.annotate(session, actor, row, _action(model, change))
        row.active = active
        session.flush()
    return get_value(session, taxonomy, row.id)


def delete_value(
    session: Session, actor: ActorContext, taxonomy: Taxonomy, value_id: uuid.UUID
) -> None:
    """Delete a value nothing references; otherwise `InUseError` (deactivate it instead)."""
    model = MODELS[taxonomy]
    row = _row(session, taxonomy, value_id)
    _refuse_if_used(session, model, row.id)
    audit.annotate(session, actor, row)

    def still_used(error: IntegrityError) -> InUseError | None:
        return _in_use(session, model, row.id) if is_foreign_key_violation(error) else None

    with translated_violations(session, still_used):
        session.delete(row)


def _row(session: Session, taxonomy: Taxonomy, value_id: uuid.UUID) -> TaxonomyRow:
    row = repository.get_value(session, MODELS[taxonomy], value_id)
    if row is None:
        raise NotFoundError(f"{taxonomy} {value_id} not found.")
    return row


def _value(row: TaxonomyRow, usage: int) -> TaxonomyValue:
    return TaxonomyValue(
        id=row.id,
        label=row.label,
        slug=row.slug,
        active=row.active,
        usage_count=usage,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def _action(model: TaxonomyModel, change: SettingsChange) -> str:
    return audit.settings_action(audit.AUDITED_ENTITIES[model].entity_type, change)


def _existing(row: TaxonomyRow) -> ExistingValue:
    return ExistingValue(id=row.id, label=row.label, active=row.active)


def _refuse_duplicate(
    session: Session, model: TaxonomyModel, label: str, *, exclude_id: uuid.UUID | None = None
) -> None:
    same = repository.find_by_label(session, model, label, exclude_id=exclude_id)
    if same is not None:
        raise DuplicateValueError("label", _existing(same))


def _duplicate_translator(
    session: Session, model: TaxonomyModel, label: str
) -> Callable[[IntegrityError], DuplicateValueError | None]:
    """Turns a label-key violation that raced past `_refuse_duplicate` into the same error."""

    def translate(error: IntegrityError) -> DuplicateValueError | None:
        if violated_constraint(error) != f"uq_{model.__tablename__}_label_key":
            return None
        same = repository.find_by_label(session, model, label)
        return DuplicateValueError("label", _existing(same) if same else None)

    return translate


def _free_slug(session: Session, model: TaxonomyModel, label: str) -> str:
    """Slug of the label, suffixed `-2`, `-3`… when taken (e.g. by a renamed value)."""
    base = repository.slug_base(session, label)[: SLUG_MAX_LENGTH - 4].strip("-") or FALLBACK_SLUG
    taken = repository.slugs_starting_with(session, model, base)
    candidates = (base, *(f"{base}-{n}" for n in range(2, len(taken) + 3)))
    return next(slug for slug in candidates if slug not in taken)


def _in_use(session: Session, model: TaxonomyModel, value_id: uuid.UUID) -> InUseError | None:
    used = repository.count_usage(session, model, value_id)
    return InUseError({repository.USAGE[model][1]: used}) if used else None


def _refuse_if_used(session: Session, model: TaxonomyModel, value_id: uuid.UUID) -> None:
    if (error := _in_use(session, model, value_id)) is not None:
        raise error
