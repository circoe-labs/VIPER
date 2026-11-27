"""Reversible removals of a person or a company from prospecting (migration 0063)."""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, Text, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import UUIDPrimaryKeyMixin, text_enum
from app.models.enums import HoldKind


class ProspectingHold(UUIDPrimaryKeyMixin, Base):
    """One archive or temporary exclusion of a prospect **or** a company. Open while `lifted_at`
    is NULL (at most one open per record and kind); lifting keeps the row, so who removed and who
    brought back, when and why, stay readable. Written by `app.services.lifecycle` only and read
    by `app.services.eligibility`."""

    __tablename__ = "prospecting_holds"
    __table_args__ = (
        CheckConstraint("num_nonnulls(prospect_id, company_id) = 1", name="exactly_one_subject"),
        CheckConstraint(
            "kind <> 'exclusion' OR coalesce(btrim(reason), '') <> ''", name="exclusion_reason"
        ),
        CheckConstraint("(lifted_at IS NULL) = (lifted_by_display IS NULL)", name="lift_complete"),
        Index(
            "uq_prospecting_holds_open_prospect",
            "prospect_id",
            "kind",
            unique=True,
            postgresql_where=text("lifted_at IS NULL AND prospect_id IS NOT NULL"),
        ),
        Index(
            "uq_prospecting_holds_open_company",
            "company_id",
            "kind",
            unique=True,
            postgresql_where=text("lifted_at IS NULL AND company_id IS NOT NULL"),
        ),
    )

    prospect_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("prospects.id", ondelete="CASCADE"), index=True
    )
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("companies.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[HoldKind] = mapped_column(text_enum(HoldKind, "kind"))
    reason: Mapped[str | None] = mapped_column(Text)
    placed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    placed_by_display: Mapped[str] = mapped_column(String(255))
    lifted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    lifted_by_display: Mapped[str | None] = mapped_column(String(255))
    # Why it came back (new information, a new angle).
    lift_reason: Mapped[str | None] = mapped_column(Text)
