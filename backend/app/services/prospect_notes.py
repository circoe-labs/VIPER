"""ProspectNoteService: short dated facts about a prospect, optionally scored.

A note is a fact in one sentence (`fact_text`), optionally dated (`noted_on`, a business day),
sourced (`source_type` + free `source_label`) and carrying a `score_delta` (a manual contribution
to the score, `app.services.prospect_score`). Notes are written on their own, outside the editor's
aggregate `version` (adding a note never makes an open editor stale); each write is audited
(`prospect_note.created|updated|deleted`, on the prospect's history) and logged at info with ids
only, never the fact. Refusals: `NotFoundError` (prospect or note), `InvalidFieldError` (`blank`,
`length`, `range`).
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import date
from typing import Final

from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.enums import NoteSourceType
from app.models.prospects import (
    NOTE_SCORE_DELTA_MAX,
    NOTE_SCORE_DELTA_MIN,
    NOTE_TEXT_MAX_LENGTH,
    ProspectNote,
)
from app.repositories import notes as repository
from app.services import audit
from app.services.errors import InvalidFieldError, NotFoundError
from app.services.prospects import get_prospect
from app.services.taxonomies import normalize_text

logger = logging.getLogger(__name__)

SOURCE_LABEL_MAX_LENGTH = 200


class _Unset:
    """Marks a field the caller did not send (distinct from null, which clears an optional one)."""


UNSET: Final = _Unset()


@dataclass(frozen=True, slots=True)
class NoteInput:
    fact_text: str
    noted_on: date | None = None
    source_type: NoteSourceType | None = None
    source_label: str | None = None
    score_delta: int | None = None


@dataclass(frozen=True, slots=True)
class NotePatch:
    """Only the fields set are changed; `None` clears an optional field."""

    fact_text: str | _Unset = UNSET
    noted_on: date | _Unset | None = UNSET
    source_type: NoteSourceType | _Unset | None = UNSET
    source_label: str | _Unset | None = UNSET
    score_delta: int | _Unset | None = UNSET


def _fact(value: str) -> str:
    text = normalize_text(value)
    if not text:
        raise InvalidFieldError("fact_text", "fact_text must not be blank.", "blank")
    if len(text) > NOTE_TEXT_MAX_LENGTH:
        raise InvalidFieldError(
            "fact_text", f"fact_text is longer than {NOTE_TEXT_MAX_LENGTH} characters.", "length"
        )
    return text


def _label(value: str | None) -> str | None:
    text = normalize_text(value or "") or None
    if text is not None and len(text) > SOURCE_LABEL_MAX_LENGTH:
        raise InvalidFieldError(
            "source_label",
            f"source_label is longer than {SOURCE_LABEL_MAX_LENGTH} characters.",
            "length",
        )
    return text


def _delta(value: int | None) -> int | None:
    if value is not None and not NOTE_SCORE_DELTA_MIN <= value <= NOTE_SCORE_DELTA_MAX:
        raise InvalidFieldError(
            "score_delta",
            f"score_delta must be between {NOTE_SCORE_DELTA_MIN} and {NOTE_SCORE_DELTA_MAX}.",
            "range",
        )
    return value


def _existing_prospect(session: Session, prospect_id: uuid.UUID) -> None:
    get_prospect(session, prospect_id)  # raises NotFoundError


def _note(session: Session, prospect_id: uuid.UUID, note_id: uuid.UUID) -> ProspectNote:
    note = repository.get_note(session, prospect_id, note_id)
    if note is None:
        raise NotFoundError(f"Note {note_id} not found for prospect {prospect_id}.")
    return note


def list_notes(session: Session, prospect_id: uuid.UUID) -> list[ProspectNote]:
    _existing_prospect(session, prospect_id)
    return list(repository.list_notes(session, prospect_id))


def create_note(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, data: NoteInput
) -> ProspectNote:
    _existing_prospect(session, prospect_id)
    note = ProspectNote(
        prospect_id=prospect_id,
        fact_text=_fact(data.fact_text),
        noted_on=data.noted_on,
        source_type=data.source_type,
        source_label=_label(data.source_label),
        score_delta=_delta(data.score_delta),
    )
    audit.annotate(session, actor, note)
    session.add(note)
    session.flush()
    logger.info(
        "prospect_note.created prospect=%s note=%s scored=%s",
        prospect_id,
        note.id,
        note.score_delta is not None,
    )
    return note


def update_note(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    note_id: uuid.UUID,
    patch: NotePatch,
) -> ProspectNote:
    note = _note(session, prospect_id, note_id)
    audit.annotate(session, actor, note)
    if not isinstance(patch.fact_text, _Unset):
        note.fact_text = _fact(patch.fact_text)
    if not isinstance(patch.noted_on, _Unset):
        note.noted_on = patch.noted_on
    if not isinstance(patch.source_type, _Unset):
        note.source_type = patch.source_type
    if not isinstance(patch.source_label, _Unset):
        note.source_label = _label(patch.source_label)
    if not isinstance(patch.score_delta, _Unset):
        note.score_delta = _delta(patch.score_delta)
    session.flush()
    logger.info("prospect_note.updated prospect=%s note=%s", prospect_id, note_id)
    return note


def delete_note(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, note_id: uuid.UUID
) -> None:
    note = _note(session, prospect_id, note_id)
    audit.annotate(session, actor, note)
    session.delete(note)
    session.flush()
    logger.info("prospect_note.deleted prospect=%s note=%s", prospect_id, note_id)
