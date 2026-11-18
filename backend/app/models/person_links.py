"""Relational links between people: prospects and members of the organisation.

A link is undirected (« Robin et lui sont frères » reads the same from both sides) and carries a
strength from 0 to 100 and a free relation label. Each side is either a prospect or a member, so
the same table holds prospect↔member, prospect↔prospect and member↔member links. A pair exists
once: `pair_key` is the two sides in a canonical order.
"""

import uuid

from sqlalchemy import CheckConstraint, ForeignKey, SmallInteger, String, Text, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin

RELATION_MAX_LENGTH = 80
NOTE_MAX_LENGTH = 1000


class PersonLink(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "person_links"
    __table_args__ = (
        CheckConstraint("num_nonnulls(a_prospect_id, a_user_id) = 1", name="one_a_side"),
        CheckConstraint("num_nonnulls(b_prospect_id, b_user_id) = 1", name="one_b_side"),
        CheckConstraint("score BETWEEN 0 AND 100", name="score_range"),
        CheckConstraint(
            f"btrim(relation) <> '' AND char_length(relation) <= {RELATION_MAX_LENGTH}",
            name="relation_valid",
        ),
    )

    a_prospect_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("prospects.id", ondelete="CASCADE"), index=True
    )
    a_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    b_prospect_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("prospects.id", ondelete="CASCADE"), index=True
    )
    b_user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # "p:<uuid>|u:<uuid>" with the two sides sorted: one link per pair, whichever side is `a`.
    pair_key: Mapped[str] = mapped_column(String(100), unique=True)
    relation: Mapped[str] = mapped_column(String(RELATION_MAX_LENGTH))
    score: Mapped[int] = mapped_column(SmallInteger)
    note: Mapped[str | None] = mapped_column(Text)
    created_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        Uuid, ForeignKey("users.id", ondelete="SET NULL"), index=True
    )
