"""Audit log persistence: inserts only (the table is append-only) and history queries."""

import uuid
from collections.abc import Collection, Sequence
from typing import Any

from sqlalchemy import Select, insert, select
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
    session: Session, subject_type: str, subject_id: uuid.UUID, *, limit: int
) -> list[AuditLogEntry]:
    return _newest_first(
        session,
        select(AuditLogEntry).where(
            AuditLogEntry.subject_type == subject_type, AuditLogEntry.subject_id == subject_id
        ),
        limit,
    )


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
