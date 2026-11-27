"""Saved warehouse email simulations, pending human review."""

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import UUIDPrimaryKeyMixin


class WarehouseDraft(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "warehouse_drafts"

    warehouse_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("warehouses.id", ondelete="RESTRICT")
    )
    warehouse_name: Mapped[str] = mapped_column(String(500))
    phase: Mapped[int] = mapped_column(Integer, server_default="1")
    contact_name: Mapped[str] = mapped_column(String(500))
    contact_role: Mapped[str | None] = mapped_column(Text)
    source_email: Mapped[str | None] = mapped_column(Text)
    recipient: Mapped[str | None] = mapped_column(Text)
    subject: Mapped[str] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)
    review_note: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    revision: Mapped[int] = mapped_column(Integer, server_default="1")
    validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    validated_by: Mapped[str | None] = mapped_column(String(255))
    human_validated: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text('false'))
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    send_state: Mapped[str | None] = mapped_column(String(30))
    remote_draft_id: Mapped[str | None] = mapped_column(String(255))
    # Why a scheduled mail did not (certainly) leave: a code, and when.
    failure_code: Mapped[str | None] = mapped_column(String(255))
    failed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # When it left (the dispatcher, or a person saying so).
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The prospect this mail's person is (`services/warehouse_people`).
    prospect_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("prospects.id", ondelete="SET NULL"), index=True
    )
    # The Contact step that accounts for this send (`services/warehouse_history`).
    carried_message_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("contact_messages.id", ondelete="SET NULL"), index=True
    )
