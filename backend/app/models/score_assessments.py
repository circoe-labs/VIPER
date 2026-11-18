"""AI assessments of a prospect's commercial fit (`prospect_score_assessments`).

One immutable row per **successful** « Évaluer le score » call (`app.services.prospect_scoring`):
the score, the model's short rationale and criteria, and the provenance (model that answered,
prompt version = hash of the exact instructions, who asked, when, how long it took). A failed call
writes nothing. The displayed Score prospect is the latest assessment's `score`, falling back to
the note-based score when there is none (`app.services.prospect_score`).
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.models.common import UUIDPrimaryKeyMixin


class ProspectScoreAssessment(UUIDPrimaryKeyMixin, Base):
    __tablename__ = "prospect_score_assessments"
    __table_args__ = (
        CheckConstraint("score BETWEEN 0 AND 100", name="score_range"),
        Index("ix_prospect_score_assessments_prospect_created", "prospect_id", "created_at"),
    )

    prospect_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("prospects.id", ondelete="CASCADE"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), sort_order=1
    )
    score: Mapped[int] = mapped_column(SmallInteger)
    rationale: Mapped[str] = mapped_column(Text)
    # `[{label, delta, evidence}]`, validated by `prospect_scoring.ScoringAnswer` before storing.
    criteria: Mapped[list[dict[str, Any]]] = mapped_column(JSONB)
    # The model that answered (the snapshot the provider names), the SHA-256 of the instructions
    # sent (the prompt version) and how long the call took.
    model: Mapped[str] = mapped_column(String(200))
    prompt_hash: Mapped[str] = mapped_column(String(64))
    duration_ms: Mapped[int] = mapped_column(Integer)
    actor_type: Mapped[str] = mapped_column(String(16))
    actor_id: Mapped[str | None] = mapped_column(String(128))
    actor_display: Mapped[str] = mapped_column(String(255))
