"""Append-only application audit log (who changed what, when). Written by `app.services.audit`.

No foreign keys: entries must outlive the rows they describe. UPDATE, DELETE and TRUNCATE are
rejected by database triggers. Schema and vocabulary: `doc/architecture/audit-and-provenance.md`.
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
        # History of one row (Database Explorer).
        Index(
            "ix_audit_log_entity_type_entity_id_occurred_at",
            "entity_type",
            "entity_id",
            "occurred_at",
        ),
        # History of a prospect/company including its child rows (Task 19).
        Index(
            "ix_audit_log_subject_type_subject_id_occurred_at",
            "subject_type",
            "subject_id",
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
    # The row that changed…
    entity_type: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    # …and the record whose history shows it (an email's prospect; a prospect itself).
    subject_type: Mapped[str | None] = mapped_column(String(64))
    subject_id: Mapped[uuid.UUID | None] = mapped_column(Uuid)
    action: Mapped[str] = mapped_column(String(64))
    changes: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    context: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
