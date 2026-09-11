"""Companies (employer/context) and their establishments. Prospects link to companies only."""

import uuid

from sqlalchemy import (
    CheckConstraint,
    Column,
    ForeignKey,
    Index,
    String,
    Table,
    Text,
    false,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin, trigram_index
from app.models.taxonomies import ActivityCategory

company_activity_categories = Table(
    "company_activity_categories",
    Base.metadata,
    Column("company_id", ForeignKey("companies.id", ondelete="CASCADE"), primary_key=True),
    Column(
        "activity_category_id",
        ForeignKey(
            "activity_categories.id",
            ondelete="RESTRICT",
            name="fk_company_activity_categories_activity_category_id",
        ),
        primary_key=True,
        index=True,
    ),
)


class Company(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "companies"
    __table_args__ = (
        CheckConstraint("btrim(display_name) <> ''", name="display_name_not_blank"),
        CheckConstraint("siren ~ '^[0-9]{9}$'", name="siren_format"),
        CheckConstraint(
            "email_domain = lower(email_domain) AND email_domain ~ '^[^@\\s]+\\.[^@\\s]+$'",
            name="email_domain_format",
        ),
        # Exact case-insensitive name lookups (import dedup candidates, Task 08/09).
        Index("ix_companies_lower_display_name", text("lower(display_name)")),
        trigram_index("ix_companies_display_name_search_key_trgm", "search_key(display_name)"),
        trigram_index("ix_companies_legal_name_search_key_trgm", "search_key(legal_name)"),
    )

    display_name: Mapped[str] = mapped_column(String(255))
    legal_name: Mapped[str | None] = mapped_column(String(255))
    # Digits only; a UNIQUE constraint still allows many NULLs in PostgreSQL.
    siren: Mapped[str | None] = mapped_column(String(9), unique=True)
    website_url: Mapped[str | None] = mapped_column(Text)
    email_domain: Mapped[str | None] = mapped_column(String(253), index=True)
    size_label: Mapped[str | None] = mapped_column(String(100))
    commercial_segment_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("commercial_segments.id", ondelete="RESTRICT"), index=True
    )
    project_done_with_circoe: Mapped[str | None] = mapped_column(Text)
    project_type: Mapped[str | None] = mapped_column(Text)
    circoe_references: Mapped[str | None] = mapped_column(Text)
    client_approach: Mapped[str | None] = mapped_column(Text)

    # No reverse relationships from taxonomies/prospects: ORM must never null or delete a
    # RESTRICT-protected reference on their behalf.
    activity_categories: Mapped[list[ActivityCategory]] = relationship(
        secondary=company_activity_categories
    )
    establishments: Mapped[list[Establishment]] = relationship(
        back_populates="company", cascade="all, delete-orphan", passive_deletes=True
    )


class Establishment(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "establishments"
    __table_args__ = (
        CheckConstraint("siret ~ '^[0-9]{14}$'", name="siret_format"),
        Index(
            "uq_establishments_company_id_primary",
            "company_id",
            unique=True,
            postgresql_where=text("is_primary"),
        ),
        trigram_index("ix_establishments_name_search_key_trgm", "search_key(name)"),
        trigram_index("ix_establishments_city_search_key_trgm", "search_key(city)"),
    )

    company_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str | None] = mapped_column(String(255))
    siret: Mapped[str | None] = mapped_column(String(14), unique=True)
    address_line1: Mapped[str | None] = mapped_column(String(255))
    address_line2: Mapped[str | None] = mapped_column(String(255))
    postal_code: Mapped[str | None] = mapped_column(String(16))
    city: Mapped[str | None] = mapped_column(String(255))
    country: Mapped[str | None] = mapped_column(String(100))
    # Free text (`siège`, `agence`, `entrepôt`…): open-ended, not a taxonomy yet.
    kind: Mapped[str | None] = mapped_column(String(100))
    is_primary: Mapped[bool] = mapped_column(server_default=false())

    company: Mapped[Company] = relationship(back_populates="establishments")
