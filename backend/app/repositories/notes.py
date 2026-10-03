"""Prospect note persistence (`prospect_notes`)."""

import uuid
from collections.abc import Sequence

from sqlalchemy import select
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


def scored_notes(session: Session, prospect_id: uuid.UUID) -> Sequence[ProspectNote]:
    """Notes carrying a `score_delta` (the manual score contributions), newest first."""
    return [note for note in list_notes(session, prospect_id) if note.score_delta is not None]


def get_note(session: Session, prospect_id: uuid.UUID, note_id: uuid.UUID) -> ProspectNote | None:
    """The note, only when it belongs to that prospect."""
    statement = select(ProspectNote).where(
        ProspectNote.id == note_id, ProspectNote.prospect_id == prospect_id
    )
    return session.scalars(statement).one_or_none()
