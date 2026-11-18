"""Agenda: the meetings booked by prospects (synced from Calendly, or added by hand).

One row per Calendly event (`calendly_event_uri`, unique); a manual meeting has none. The host
(Calendly user) and the member in charge (`referent_id`, a user of the organisation) are kept
apart: the host owns the Calendly calendar, the member is who VIPER says takes the meeting over.
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, SmallInteger, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin, text_enum
from app.models.enums import AppointmentSource, AppointmentStatus
from app.models.organizations import OrganizationOwnedMixin


class Appointment(UUIDPrimaryKeyMixin, OrganizationOwnedMixin, TimestampMixin, Base):
    __tablename__ = "appointments"
    __table_args__ = (
        CheckConstraint("ends_at >= starts_at", name="ends_after_start"),
        CheckConstraint("btrim(invitee_name) <> ''", name="invitee_name_valid"),
        Index("ix_appointments_starts_at", "starts_at"),
    )

    source: Mapped[AppointmentSource] = mapped_column(text_enum(AppointmentSource, "source"))
    # Calendly's own ids: the upsert key of the sync. NULL for a manual meeting.
    calendly_event_uri: Mapped[str | None] = mapped_column(String(300), unique=True)
    calendly_invitee_uri: Mapped[str | None] = mapped_column(String(300))
    prospect_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("prospects.id", ondelete="SET NULL"), index=True
    )
    referent_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
    title: Mapped[str] = mapped_column(String(300))
    invitee_name: Mapped[str] = mapped_column(String(300))
    invitee_email: Mapped[str | None] = mapped_column(String(320))
    company_name: Mapped[str | None] = mapped_column(String(300))
    host_name: Mapped[str | None] = mapped_column(String(300))
    host_email: Mapped[str | None] = mapped_column(String(320))
    # When the invitee booked (Calendly's `created_at` of the invitee); NULL for a manual meeting.
    booked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # What the invitee answered on the booking form, [{question, answer}]: the subject of the meeting.
    invitee_answers: Mapped[list[dict[str, str]]] = mapped_column(
        JSONB, server_default=text("'[]'::jsonb")
    )
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    # The video-call or place, as Calendly gives it.
    location: Mapped[str | None] = mapped_column(String(1000))
    status: Mapped[AppointmentStatus] = mapped_column(
        text_enum(AppointmentStatus, "status"), server_default=AppointmentStatus.SCHEDULED.value
    )
    # How many times the date moved (Calendly reschedule, or « Décalé » by hand).
    reschedule_count: Mapped[int] = mapped_column(SmallInteger, server_default="0")
    notes: Mapped[str | None] = mapped_column(Text)
