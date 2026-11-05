"""Warehouse sites and their source interlocutors, independent of verified prospect records."""

from typing import Any

from sqlalchemy import CheckConstraint, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin


class Warehouse(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "warehouses"
    __table_args__ = (
        CheckConstraint("btrim(name) <> ''", name="name_not_blank"),
        CheckConstraint("jsonb_typeof(contacts) = 'array'", name="contacts_array"),
    )

    name: Mapped[str] = mapped_column(String(500))
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
    source_reference: Mapped[str | None] = mapped_column(Text)
    source_key: Mapped[str | None] = mapped_column(String(64), unique=True)
