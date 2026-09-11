"""Prospects (individual people), their contact channels and provenance records."""

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    String,
    Text,
    false,
    func,
    text,
    true,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.actor import ActorType
from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin, text_enum, trigram_index
from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    OriginType,
    PhoneType,
    ProspectSourceType,
    VerificationStatus,
)

if TYPE_CHECKING:
    from app.models.contact_tracking import ContactTracking


class Prospect(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "prospects"
    __table_args__ = (
        CheckConstraint(
            "coalesce(btrim(first_name), '') <> '' OR coalesce(btrim(last_name), '') <> ''",
            name="has_name",
        ),
        CheckConstraint(
            "(contactability_status = 'contactable'"
            " AND do_not_contact_at IS NULL AND do_not_contact_reason IS NULL)"
            " OR (contactability_status = 'do_not_contact' AND do_not_contact_at IS NOT NULL)",
            name="do_not_contact_consistency",
        ),
        # Person lookups by name (import dedup candidates, Prospection search).
        Index(
            "ix_prospects_lower_last_name_first_name",
            text("lower(last_name)"),
            text("lower(first_name)"),
        ),
        trigram_index(
            "ix_prospects_person_search_key_trgm", "person_search_key(first_name, last_name)"
        ),
    )

    # Nullable only until import resolution; services require it for manual creation.
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("companies.id", ondelete="RESTRICT"), index=True
    )
    civility: Mapped[Civility | None] = mapped_column(text_enum(Civility, "civility"))
    first_name: Mapped[str | None] = mapped_column(String(100))
    last_name: Mapped[str | None] = mapped_column(String(100))
    role_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("roles.id", ondelete="RESTRICT"), index=True
    )
    exact_job_title: Mapped[str | None] = mapped_column(String(255))
    activity_status: Mapped[ActivityStatus] = mapped_column(
        text_enum(ActivityStatus, "activity_status"), server_default=ActivityStatus.UNKNOWN.value
    )
    # NULL = current employment context (company/role/title/activity) not verified.
    employment_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Durable opposition, independent of the contact-tracking stage. Clearing it is only possible
    # through `services.prospects.clear_do_not_contact` (guarded by a database trigger).
    contactability_status: Mapped[ContactabilityStatus] = mapped_column(
        text_enum(ContactabilityStatus, "contactability_status"),
        server_default=ContactabilityStatus.CONTACTABLE.value,
    )
    do_not_contact_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    do_not_contact_reason: Mapped[str | None] = mapped_column(Text)

    emails: Mapped[list[Email]] = relationship(
        back_populates="prospect", cascade="all, delete-orphan", passive_deletes=True
    )
    phones: Mapped[list[Phone]] = relationship(
        back_populates="prospect", cascade="all, delete-orphan", passive_deletes=True
    )
    contact_tracking: Mapped[ContactTracking | None] = relationship(
        back_populates="prospect", cascade="all, delete-orphan", passive_deletes=True
    )


class ContactChannelMixin(UUIDPrimaryKeyMixin, TimestampMixin):
    prospect_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("prospects.id", ondelete="CASCADE"))
    # A primary channel is always active (CHECK); at most one primary per prospect (partial index).
    is_primary: Mapped[bool] = mapped_column(server_default=false())
    is_active: Mapped[bool] = mapped_column(server_default=true())
    verification_status: Mapped[VerificationStatus] = mapped_column(
        text_enum(VerificationStatus, "verification_status"),
        server_default=VerificationStatus.UNVERIFIED.value,
    )
    origin_type: Mapped[OriginType] = mapped_column(text_enum(OriginType, "origin_type"))
    last_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    source_reference: Mapped[str | None] = mapped_column(Text)


class Email(ContactChannelMixin, Base):
    __tablename__ = "emails"
    __table_args__ = (
        # Stored normalized (trimmed, lowercase) so equality lookups and uniqueness are exact.
        CheckConstraint(
            "address = lower(address) AND address ~ '^[^@\\s]+@[^@\\s]+$'", name="address_format"
        ),
        CheckConstraint("is_active OR NOT is_primary", name="primary_is_active"),
        # Per prospect only: the same address on two prospects is a dedup concern, not an error.
        Index("uq_emails_prospect_id_address", "prospect_id", "address", unique=True),
        Index(
            "uq_emails_prospect_id_primary",
            "prospect_id",
            unique=True,
            postgresql_where=text("is_primary"),
        ),
        trigram_index("ix_emails_address_trgm", "address"),
    )

    address: Mapped[str] = mapped_column(String(320), index=True)

    prospect: Mapped[Prospect] = relationship(back_populates="emails")


class Phone(ContactChannelMixin, Base):
    __tablename__ = "phones"
    __table_args__ = (
        # Digits with an optional leading `+`: formatting is stripped before storage.
        CheckConstraint("number ~ '^\\+?[0-9]{4,20}$'", name="number_format"),
        CheckConstraint("is_active OR NOT is_primary", name="primary_is_active"),
        Index("uq_phones_prospect_id_number", "prospect_id", "number", unique=True),
        Index(
            "uq_phones_prospect_id_primary",
            "prospect_id",
            unique=True,
            postgresql_where=text("is_primary"),
        ),
        trigram_index("ix_phones_number_trgm", "number"),
    )

    number: Mapped[str] = mapped_column(String(21), index=True)
    type: Mapped[PhoneType] = mapped_column(text_enum(PhoneType, "type"))

    prospect: Mapped[Prospect] = relationship(back_populates="phones")


class ProspectSource(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """Provenance: where a prospect's data came from (audit_log records who changed what)."""

    __tablename__ = "prospect_sources"

    prospect_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("prospects.id", ondelete="CASCADE"), index=True
    )
    source_type: Mapped[ProspectSourceType] = mapped_column(
        text_enum(ProspectSourceType, "source_type")
    )
    # File/sheet/row or URL/reference; never shown publicly.
    source_reference: Mapped[str | None] = mapped_column(Text)
    import_batch_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("import_batches.id", ondelete="RESTRICT"), index=True
    )
    # When VIPER obtained the data (the import date for legacy rows).
    collected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    legal_basis_or_collection_context: Mapped[str | None] = mapped_column(Text)
    actor_type: Mapped[ActorType | None] = mapped_column(text_enum(ActorType, "actor_type"))
    actor_id: Mapped[str | None] = mapped_column(String(128))
    actor_display: Mapped[str | None] = mapped_column(String(255))
    notes: Mapped[str | None] = mapped_column(Text)
