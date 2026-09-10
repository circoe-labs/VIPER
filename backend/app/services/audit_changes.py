"""Before/after capture for audit events: JSON-safe values, explicit diffs, ORM attribute history.

A change set is `{field: {"before": value, "after": value}}` holding only the fields that changed.
Technical columns (`id`, timestamps) are left out. Many-to-many collections (e.g. a company's
activity categories) appear as sorted id lists; one-to-many children are audited as their own
entities. Values are JSON-safe; the payload policy (`app.core.audit_policy`) is applied later, when
the event is stored.
"""

import uuid
from collections.abc import Mapping
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Any

from sqlalchemy.orm.attributes import instance_state

type FieldChange = dict[str, Any]
type ChangeSet = dict[str, FieldChange]

TECHNICAL_FIELDS = frozenset({"id", "created_at", "updated_at"})


def to_json(value: Any) -> Any:
    """`value` as JSON-compatible data; unknown types are refused rather than stringified."""
    match value:
        case None | bool() | int() | float() | str():
            return value
        case Enum():
            return to_json(value.value)
        case uuid.UUID() | Decimal():
            return str(value)
        case datetime() | date():
            return value.isoformat()
        case Mapping():
            return {str(key): to_json(item) for key, item in value.items()}
        case set() | frozenset():
            return sorted((to_json(item) for item in value), key=str)
        case list() | tuple():
            return [to_json(item) for item in value]
    raise TypeError(f"Cannot store a {type(value).__name__} value in an audit event.")


def diff(before: Mapping[str, Any], after: Mapping[str, Any]) -> ChangeSet:
    """Changed fields between two plain snapshots; a key missing on one side counts as None."""
    changes: ChangeSet = {}
    for field in sorted(before.keys() | after.keys()):
        old, new = to_json(before.get(field)), to_json(after.get(field))
        if old != new:
            changes[field] = {"before": old, "after": new}
    return changes


def _collection_ids(items: list[Any]) -> list[Any]:
    return sorted((to_json(item.id) for item in items), key=str)


def snapshot(instance: object) -> dict[str, Any]:
    """Loaded, non-null column values of `instance` (a created or deleted row), plus its loaded,
    non-empty many-to-many collections as id lists (a company created with its categories)."""
    state = instance_state(instance)
    values = {
        attr.key: to_json(state.dict[attr.key])
        for attr in state.mapper.column_attrs
        if attr.key not in TECHNICAL_FIELDS and state.dict.get(attr.key) is not None
    }
    for relationship in state.mapper.relationships:
        if relationship.secondary is not None and state.dict.get(relationship.key):
            values[f"{relationship.key}_ids"] = _collection_ids(state.dict[relationship.key])
    return values


def pending_changes(instance: object) -> ChangeSet:
    """Unflushed changes of a persistent `instance`, from SQLAlchemy attribute history.

    Valid until the flush completes (history is reset afterwards). The "before" value is exact when
    it was loaded; audited models load it on assignment (`active_history`), so it always is.
    """
    state = instance_state(instance)
    changes: ChangeSet = {}
    for attr in state.mapper.column_attrs:
        history = state.attrs[attr.key].history
        if attr.key in TECHNICAL_FIELDS or not history.added:
            continue
        before = history.deleted[0] if history.deleted else None
        if to_json(before) != to_json(history.added[0]):
            changes[attr.key] = {"before": to_json(before), "after": to_json(history.added[0])}
    for relationship in state.mapper.relationships:
        history = state.attrs[relationship.key].history
        if relationship.secondary is None or not history.has_changes():
            continue
        before = _collection_ids([*history.unchanged, *history.deleted])
        after = _collection_ids([*history.unchanged, *history.added])
        if before != after:
            changes[f"{relationship.key}_ids"] = {"before": before, "after": after}
    return changes


def created_changes(instance: object) -> ChangeSet:
    return {field: {"before": None, "after": value} for field, value in snapshot(instance).items()}


def deleted_changes(instance: object) -> ChangeSet:
    return {field: {"before": value, "after": None} for field, value in snapshot(instance).items()}
