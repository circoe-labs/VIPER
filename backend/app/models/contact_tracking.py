"""Lightweight contact tracking (`Suivi de contact`): one current row per prospect + history."""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.actor import ActorType
from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin, text_enum
from app.models.enums import ContactTrackingStatus
from app.models.prospects import Prospect


class ContactTracking(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "contact_tracking"

    # UNIQUE: V1 keeps a single current tracking cycle per prospect (multi-cycle is deferred).
    prospect_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("prospects.id", ondelete="CASCADE"), unique=True
    )
    planned_contact_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    status: Mapped[ContactTrackingStatus] = mapped_column(
        text_enum(ContactTrackingStatus, "status"),
        server_default=ContactTrackingStatus.TO_CONTACT.value,
    )
    referent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("internal_referents.id", ondelete="RESTRICT"), index=True
    )
    response_received_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    appointment_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    prospect: Mapped[Prospect] = relationship(back_populates="contact_tracking")
    status_history: Mapped[list[ContactTrackingStatusHistory]] = relationship(
        back_populates="contact_tracking",
        cascade="all, delete-orphan",
        passive_deletes=True,
        order_by="ContactTrackingStatusHistory.changed_at",
    )


class ContactTrackingStatusHistory(UUIDPrimaryKeyMixin, Base):
    """Append-style transition log; first-contact/follow-up dates are derived from it."""

    __tablename__ = "contact_tracking_status_history"
    __table_args__ = (
        CheckConstraint("from_status IS DISTINCT FROM to_status", name="status_changed"),
        Index(
            "ix_contact_tracking_status_history_tracking_id_changed_at",
            "contact_tracking_id",
            "changed_at",
        ),
    )

    contact_tracking_id: Mapped[uuid.UUID] = mapped_column(
        # Explicit name: the conventional one exceeds PostgreSQL's 63-character limit.
        ForeignKey(
            "contact_tracking.id",
            ondelete="CASCADE",
            name="fk_contact_tracking_status_history_contact_tracking_id",
        )
    )
    # NULL for the initial status of a new tracking row.
    from_status: Mapped[ContactTrackingStatus | None] = mapped_column(
        text_enum(ContactTrackingStatus, "from_status")
    )
    to_status: Mapped[ContactTrackingStatus] = mapped_column(
        text_enum(ContactTrackingStatus, "to_status")
    )
    changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.clock_timestamp()
    )
    actor_type: Mapped[ActorType] = mapped_column(text_enum(ActorType, "actor_type"))
    actor_id: Mapped[str | None] = mapped_column(String(128))
    actor_display: Mapped[str] = mapped_column(String(255))

    contact_tracking: Mapped[ContactTracking] = relationship(back_populates="status_history")
