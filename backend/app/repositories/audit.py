"""Audit log persistence: inserts only (the table is append-only) and history queries."""

import uuid
from collections.abc import Collection, Mapping, Sequence
from typing import Any

from sqlalchemy import Select, Uuid, and_, insert, literal, or_, select, tuple_
from sqlalchemy.orm import Session

from app.core.actor import ActorType
from app.models.audit import AuditLogEntry


def insert_entries(session: Session, rows: Sequence[dict[str, Any]]) -> None:
    """Insert on the session's connection: usable during a flush, same transaction as the change."""
    if rows:
        session.connection().execute(insert(AuditLogEntry), list(rows))


def _newest_first(
    session: Session, statement: Select[tuple[AuditLogEntry]], limit: int
) -> list[AuditLogEntry]:
    # `id` is a UUIDv7 generated in order: a deterministic tie-break for equal timestamps.
    ordered = statement.order_by(AuditLogEntry.occurred_at.desc(), AuditLogEntry.id.desc())
    return list(session.scalars(ordered.limit(limit)))


def subject_history(
    session: Session,
    subject_type: str,
    subject_id: uuid.UUID,
    *,
    limit: int,
    before: uuid.UUID | None = None,
) -> list[AuditLogEntry]:
    """Newest first; `before` (an event id) continues after that event, in the same order."""
    statement = select(AuditLogEntry).where(
        AuditLogEntry.subject_type == subject_type, AuditLogEntry.subject_id == subject_id
    )
    if before is not None:
        cursor = select(AuditLogEntry.occurred_at).where(AuditLogEntry.id == before)
        statement = statement.where(
            tuple_(AuditLogEntry.occurred_at, AuditLogEntry.id)
            < tuple_(cursor.scalar_subquery(), literal(before, Uuid))
        )
    return _newest_first(session, statement, limit)


def identity_changes(
    session: Session, fields: Mapping[str, str], entity_ids: Collection[uuid.UUID]
) -> list[AuditLogEntry]:
    """Events of these rows that set their identity field (`fields`: entity type → field, e.g.
    `email` → `address`), oldest first: what a row was called at the time of a later event."""
    if not entity_ids:
        return []
    statement = (
        select(AuditLogEntry)
        .where(
            AuditLogEntry.entity_id.in_(entity_ids),
            or_(
                *(
                    and_(AuditLogEntry.entity_type == kind, AuditLogEntry.changes.has_key(name))
                    for kind, name in fields.items()
                )
            ),
        )
        .order_by(AuditLogEntry.occurred_at, AuditLogEntry.id)
    )
    return list(session.scalars(statement))


def recent(
    session: Session,
    *,
    limit: int,
    subject_types: Collection[str] | None = None,
    actor_types: Collection[ActorType] | None = None,
) -> list[AuditLogEntry]:
    statement = select(AuditLogEntry)
    if subject_types is not None:
        statement = statement.where(AuditLogEntry.subject_type.in_(subject_types))
    if actor_types is not None:
        statement = statement.where(AuditLogEntry.actor_type.in_(actor_types))
    return _newest_first(session, statement, limit)
