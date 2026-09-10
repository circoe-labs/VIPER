"""Append-only application audit log (who changed what, when). Writes arrive with Task 05.

No foreign keys: entries must outlive the rows they describe. UPDATE, DELETE and TRUNCATE are
rejected by database triggers.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, Index, String, Uuid, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.actor import ActorType
from app.db.base import Base
from app.models.common import UUIDPrimaryKeyMixin, text_enum


class AuditLogEntry(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "audit_log"
    __table_args__ = (
        # Per-entity history (Task 19) and recent activity (Home, Task 16).
        Index(
            "ix_audit_log_entity_type_entity_id_occurred_at",
            "entity_type",
            "entity_id",
            "occurred_at",
        ),
    )

    # clock_timestamp(): distinct, ordered times for several entries within one transaction.
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp(), index=True
    )
    actor_type: Mapped[ActorType] = mapped_column(text_enum(ActorType, "actor_type"))
    actor_id: Mapped[str | None] = mapped_column(String(128))
    # Snapshot of the actor's label at the time (names change; history must not).
    actor_display: Mapped[str] = mapped_column(String(255))
    entity_type: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    action: Mapped[str] = mapped_column(String(64))
    changes: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    context: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
