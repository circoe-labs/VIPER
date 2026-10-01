"""Data-quality alerts (sequences rework, decisions D8-D9).

An alert is about a prospect or a company (exactly one), has a type, a source (a person, an import
or the AI — the AI only proposes) and is open until a person resolves it. It never changes a
commercial state, a cohort or a sequence. One exception in effect, not in data: an open
`email_error` raised by a person (or an import) takes the prospect out of the automatic actions
(nothing due) while it keeps its cohort, state and history (D9). `detail` holds structured,
non-personal context (e.g. the field of an import conflict); `note` the person's free text.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.actor import ActorType
from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin, text_enum
from app.models.enums import QualityAlertSource, QualityAlertType

NOTE_MAX_LENGTH = 2000


class QualityAlert(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "quality_alerts"
    __table_args__ = (
        CheckConstraint("num_nonnulls(prospect_id, company_id) = 1", name="one_subject"),
        CheckConstraint(
            "(resolved_at IS NULL) = (resolved_by_display IS NULL)", name="resolved_has_actor"
        ),
        CheckConstraint(
            "type NOT IN ('email_error', 'function_to_check') OR prospect_id IS NOT NULL",
            name="prospect_types",
        ),
        CheckConstraint(
            "type <> 'company_to_check' OR company_id IS NOT NULL", name="company_types"
        ),
        # One open « Erreur sur le mail » per prospect and source (a person's, the AI's proposal).
        Index(
            "uq_quality_alerts_open_email_error",
            "prospect_id",
            "source",
            unique=True,
            postgresql_where=text("type = 'email_error' AND resolved_at IS NULL"),
        ),
    )

    prospect_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("prospects.id", ondelete="CASCADE"), index=True
    )
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True
    )
    type: Mapped[QualityAlertType] = mapped_column(text_enum(QualityAlertType, "type"))
    source: Mapped[QualityAlertSource] = mapped_column(text_enum(QualityAlertSource, "source"))
    note: Mapped[str | None] = mapped_column(Text)
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, server_default=text("'{}'::jsonb"))
    raised_by_type: Mapped[ActorType] = mapped_column(text_enum(ActorType, "raised_by_type"))
    raised_by_id: Mapped[str | None] = mapped_column(String(128))
    raised_by_display: Mapped[str] = mapped_column(String(255))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by_id: Mapped[str | None] = mapped_column(String(128))
    resolved_by_display: Mapped[str | None] = mapped_column(String(255))
    resolution_note: Mapped[str | None] = mapped_column(Text)

    @property
    def is_open(self) -> bool:
        return self.resolved_at is None
