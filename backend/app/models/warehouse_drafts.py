"""Saved warehouse email simulations, pending human review."""

import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import UUIDPrimaryKeyMixin


class WarehouseDraft(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "warehouse_drafts"

    warehouse_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("warehouses.id", ondelete="RESTRICT")
    )
    warehouse_name: Mapped[str] = mapped_column(String(500))
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
    scheduled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    send_state: Mapped[str | None] = mapped_column(String(30))
    remote_draft_id: Mapped[str | None] = mapped_column(String(255))
