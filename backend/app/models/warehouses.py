"""Warehouse sites and their source interlocutors, independent of verified prospect records."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin


class Warehouse(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "warehouses"
    __table_args__ = (
        CheckConstraint("btrim(name) <> ''", name="name_not_blank"),
        CheckConstraint("jsonb_typeof(contacts) = 'array'", name="contacts_array"),
        CheckConstraint(
            "prospecting_category IS NULL OR prospecting_category IN ('sme', 'other')",
            name="prospecting_category",
        ),
    )

    name: Mapped[str] = mapped_column(String(500))
    prospecting_category: Mapped[str | None] = mapped_column(String(20))
    owner_name: Mapped[str | None] = mapped_column(String(500))
    owner_role: Mapped[str | None] = mapped_column(String(1000))
    owner_email: Mapped[str | None] = mapped_column(Text)
    owner_linkedin: Mapped[str | None] = mapped_column(Text)
    address: Mapped[str | None] = mapped_column(Text)
    postal_code: Mapped[str | None] = mapped_column(String(16))
    city: Mapped[str | None] = mapped_column(String(255))
    siret: Mapped[str | None] = mapped_column(String(14))
    notes: Mapped[str | None] = mapped_column(Text)
    contacts: Mapped[list[dict[str, Any]]] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb"), nullable=False
    )
    # The building (establishment) of a company this warehouse is; the company follows from it.
    establishment_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("establishments.id", ondelete="SET NULL"), index=True
    )
    source_reference: Mapped[str | None] = mapped_column(Text)
    source_key: Mapped[str | None] = mapped_column(String(64), unique=True)


class WarehousePerson(UUIDPrimaryKeyMixin, Base):
    """A person of a warehouse listing who is a prospect (migration 0066): from then on they are
    written to from Contact only. `contact_key` is the folded name of the listing entry
    (`services/warehouse_history.name_key`). Written by `services/warehouse_people` only."""

    __tablename__ = "warehouse_people"
    __table_args__ = (UniqueConstraint("warehouse_id", "contact_key"),)

    warehouse_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("warehouses.id", ondelete="CASCADE")
    )
    contact_key: Mapped[str] = mapped_column(String(500))
    contact_name: Mapped[str] = mapped_column(String(500))
    prospect_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("prospects.id", ondelete="CASCADE"), index=True
    )
    linked_by_display: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
