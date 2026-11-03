"""Prospect note persistence (`prospect_notes`)."""

import uuid
from collections.abc import Sequence
from datetime import date

from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.models.prospects import ProspectNote


def list_notes(session: Session, prospect_id: uuid.UUID) -> Sequence[ProspectNote]:
    """The prospect's notes: most recently observed first, undated ones after the dated."""
    statement = (
        select(ProspectNote)
        .where(ProspectNote.prospect_id == prospect_id)
        .order_by(
            ProspectNote.noted_on.desc().nulls_last(),
            ProspectNote.created_at.desc(),
            ProspectNote.id.desc(),
        )
    )
    return session.scalars(statement).all()


def scored_notes(
    session: Session, prospect_id: uuid.UUID, *, on: date | None = None
) -> Sequence[ProspectNote]:
    """Notes carrying a `score_delta`, newest first, ignoring those whose `valid_until` passed."""
    return [
        note
        for note in list_notes(session, prospect_id)
        if note.score_delta is not None
        and (note.valid_until is None or on is None or note.valid_until >= on)
    ]


def scored_company_signals(
    session: Session, company_id: uuid.UUID, *, on: date
) -> Sequence[ProspectNote]:
    """Company-level signals carrying a score, still valid on `on`, newest first."""
    statement = (
        select(ProspectNote)
        .where(
            ProspectNote.company_id == company_id,
            ProspectNote.score_delta.is_not(None),
            or_(ProspectNote.valid_until.is_(None), ProspectNote.valid_until >= on),
        )
        .order_by(ProspectNote.observed_on.desc().nulls_last(), ProspectNote.created_at.desc())
    )
    return session.scalars(statement).all()


def get_note(session: Session, prospect_id: uuid.UUID, note_id: uuid.UUID) -> ProspectNote | None:
    """The note, only when it belongs to that prospect."""
    statement = select(ProspectNote).where(
        ProspectNote.id == note_id, ProspectNote.prospect_id == prospect_id
    )
    return session.scalars(statement).one_or_none()
