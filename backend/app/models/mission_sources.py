"""Source library companions: category defaults, evidence, contribution ledger, internal context.

Task `viper_mission_agent_configuration_v2`, Slice 02. Four small tables around `MissionSource`
(`app.models.missions`):

- `mission_category_sources`: the external sources a category offers by default (a mission follows
  them until it overrides `sources`, see `mission_categories.INHERITABLE_FIELDS`);
- `mission_evidence_citations`: the **concrete** URL an agent cited for one item of an accepted
  result, with what it observed. Kept even when the library only knows the root / sub-source it
  rolls up to (`source_id`, nullable: an unknown site is evidence, not a library entry);
- `mission_source_contributions`: the ledger of **successful contributions**, one row per
  (source, result, item). Its unique key is what makes the counters idempotent;
- `mission_context_refs`: read-only internal VIPER records (company, prospect) linked to a mission
  as supporting context. **Not** a `MissionTarget`: a target is what the agent processes, a context
  reference is data supplied to do that work.

Contract: `doc/architecture/missions.md` § « Bibliothèque de sources, contexte interne et preuves ».
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    SmallInteger,
    String,
    Text,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin

CITATION_ITEM_KEY_MAX_LENGTH = 200
CITATION_FIELD_MAX_LENGTH = 100
CITATION_URL_MAX_LENGTH = 2000
CITATION_QUOTE_MAX_LENGTH = 1000
# Internal record kinds a mission may read as context. Adding one = a new typed FK column here and
# a serializer in `services.mission_context` (never a free table / SQL selector).
CONTEXT_KINDS = ("company", "prospect")


class MissionCategorySource(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A source that is a default of a category (many-to-many, ordered)."""

    __tablename__ = "mission_category_sources"
    __table_args__ = (
        Index("uq_mission_category_sources_pair", "category_id", "source_id", unique=True),
    )

    category_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mission_categories.id", ondelete="CASCADE"), index=True
    )
    # Forgetting a library source removes it from every category default.
    source_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mission_sources.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(SmallInteger, server_default="0")


class MissionEvidenceCitation(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One URL cited for one item of an accepted result (the concrete evidence)."""

    __tablename__ = "mission_evidence_citations"
    __table_args__ = (
        CheckConstraint(
            f"btrim(url) <> '' AND char_length(url) <= {CITATION_URL_MAX_LENGTH}",
            name="url_valid",
        ),
        Index(
            "uq_mission_evidence_citations_item_url", "result_id", "item_key", "url", unique=True
        ),
    )

    result_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agent_task_results.id", ondelete="CASCADE"), index=True
    )
    # The proposal item (`proposal.items[].key`) this URL supports.
    item_key: Mapped[str] = mapped_column(String(CITATION_ITEM_KEY_MAX_LENGTH))
    field: Mapped[str | None] = mapped_column(String(CITATION_FIELD_MAX_LENGTH))
    url: Mapped[str] = mapped_column(String(CITATION_URL_MAX_LENGTH))
    quote: Mapped[str | None] = mapped_column(String(CITATION_QUOTE_MAX_LENGTH))
    confidence: Mapped[int | None] = mapped_column(SmallInteger)
    # `SourceFreshness`: what the source states / when the agent opened it (both nullable).
    source_published_at: Mapped[date | None] = mapped_column(Date)
    source_checked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The library entry this URL rolled up to when it was recorded (NULL: unknown site).
    source_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("mission_sources.id", ondelete="SET NULL"), index=True
    )
    mission_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("missions.id", ondelete="SET NULL"), index=True
    )


class MissionSourceContribution(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A library source supported an accepted item: one row per (source, result, item).

    `MissionSource.successful_uses` is the count of these rows, so a resubmitted or rebuilt result
    can never inflate it: the same (source, result, item) is stored once.
    """

    __tablename__ = "mission_source_contributions"
    __table_args__ = (
        Index(
            "uq_mission_source_contributions_event",
            "source_id",
            "result_id",
            "item_key",
            unique=True,
        ),
    )

    source_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("mission_sources.id", ondelete="CASCADE"), index=True
    )
    result_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("agent_task_results.id", ondelete="CASCADE"), index=True
    )
    item_key: Mapped[str] = mapped_column(String(CITATION_ITEM_KEY_MAX_LENGTH))
    mission_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("missions.id", ondelete="SET NULL"), index=True
    )


class MissionContextRef(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A VIPER record a mission reads as supporting context (a reference, never a copy)."""

    __tablename__ = "mission_context_refs"
    __table_args__ = (
        CheckConstraint("num_nonnulls(company_id, prospect_id) = 1", name="exactly_one_record"),
        Index(
            "uq_mission_context_refs_company",
            "mission_id",
            "company_id",
            unique=True,
            postgresql_where=text("company_id IS NOT NULL"),
        ),
        Index(
            "uq_mission_context_refs_prospect",
            "mission_id",
            "prospect_id",
            unique=True,
            postgresql_where=text("prospect_id IS NOT NULL"),
        ),
    )

    mission_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("missions.id", ondelete="CASCADE"), index=True
    )
    # A deleted record simply leaves the context (cascade).
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True
    )
    prospect_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("prospects.id", ondelete="CASCADE"), index=True
    )
    # Why this record matters to the mission, shown to the agent next to the record (bounded).
    note: Mapped[str | None] = mapped_column(Text)
