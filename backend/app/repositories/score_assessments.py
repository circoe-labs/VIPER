"""AI score assessment persistence (`prospect_score_assessments`)."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.score_assessments import ProspectScoreAssessment


def latest(session: Session, prospect_id: uuid.UUID) -> ProspectScoreAssessment | None:
    """The prospect's most recent successful assessment (the one the Score prospect displays)."""
    return session.scalars(
        select(ProspectScoreAssessment)
        .where(ProspectScoreAssessment.prospect_id == prospect_id)
        .order_by(ProspectScoreAssessment.created_at.desc(), ProspectScoreAssessment.id.desc())
        .limit(1)
    ).first()


def add(session: Session, assessment: ProspectScoreAssessment) -> ProspectScoreAssessment:
    session.add(assessment)
    session.flush()
    return assessment
