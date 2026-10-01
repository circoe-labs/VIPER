"""Cohorts (`Sxx`) and contact sequences (sequences rework, decisions D5-D6).

A **cohort** is a prospecting session named `S<n>` (`S37`, `S39`…) with the real date of its first
send, entered by a person: never derived from an ISO week (S39 may start on any day). `S0` is the
special cohort « validated, out of campaign »: it has no date and nobody in it is contacted.
Cohorts created by migration 0010 from former planned weeks carry `needs_review` until a person
confirms their date or code.

A **sequence** is one prospect's run in one cohort. A person changing the prospect's cohort closes
the current sequence (`cohort_changed`) and opens a new one: the follow-up counter restarts at
zero, the history (closed sequences and their messages) stays. `is_current` marks the sequence
that gives the prospect its cohort (at most one per prospect); an open sequence is always the
current one, and a current sequence may be closed `completed` (« Relance terminée » of the former
`failure` state). Messages belong to a sequence with a rank (`app.models.contact_messages`).
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    false,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.cohort_codes import OUT_OF_CAMPAIGN_CODE
from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin, text_enum
from app.models.enums import SequenceEndReason

COHORT_CODE_MAX_LENGTH = 16


class Cohort(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "cohorts"
    __table_args__ = (
        # Normalized `S<n>`: uppercase S, a number without leading zero.
        CheckConstraint("code ~ '^S(0|[1-9][0-9]{0,5})$'", name="code_format"),
        # S0 is out of campaign: no date. Every other cohort has its real start date.
        CheckConstraint(
            f"(code = '{OUT_OF_CAMPAIGN_CODE}') = (starts_on IS NULL)", name="date_unless_s0"
        ),
    )

    code: Mapped[str] = mapped_column(String(COHORT_CODE_MAX_LENGTH), unique=True)
    # The real date of the cohort's first send (the Contact is due that day).
    starts_on: Mapped[date | None] = mapped_column(Date)
    # Created by a migration from a former planned week: date and code to confirm by a person.
    needs_review: Mapped[bool] = mapped_column(Boolean, server_default=false())

    @property
    def out_of_campaign(self) -> bool:
        return self.code == OUT_OF_CAMPAIGN_CODE


class ContactSequence(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "contact_sequences"
    __table_args__ = (
        CheckConstraint("(closed_at IS NULL) = (end_reason IS NULL)", name="closed_has_reason"),
        CheckConstraint("closed_at IS NOT NULL OR is_current", name="open_is_current"),
        # Target of the messages' composite key (a message's sequence is its prospect's); its
        # leading `prospect_id` also serves the prospect foreign key.
        UniqueConstraint("prospect_id", "id"),
        Index(
            "uq_contact_sequences_current",
            "prospect_id",
            unique=True,
            postgresql_where=text("is_current"),
        ),
        Index(
            "uq_contact_sequences_open",
            "prospect_id",
            unique=True,
            postgresql_where=text("closed_at IS NULL"),
        ),
    )

    prospect_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("prospects.id", ondelete="CASCADE"))
    cohort_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("cohorts.id", ondelete="RESTRICT"), index=True
    )
    is_current: Mapped[bool] = mapped_column(Boolean, server_default=text("true"))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    end_reason: Mapped[SequenceEndReason | None] = mapped_column(
        text_enum(SequenceEndReason, "end_reason")
    )

    cohort: Mapped[Cohort] = relationship(lazy="joined")

    @property
    def is_open(self) -> bool:
        return self.closed_at is None
