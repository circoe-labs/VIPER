"""Versions of a step's text and saved mails (`contact_message_versions`).

Every AI generation, every manual edit and every restoration of a Contact message is kept as a
version of its step, so a person can go back to the previous text, compare two, and keep one as a
« mail sauvegardé » with the config that produced it and a human note (0-10 and a comment).

- `record` is called by the message service in the transaction that changes the text. A state
  identical to the step's latest version is not recorded again; consecutive manual autosaves of one
  person (`MERGE_WINDOW`) update their own unsaved manual version instead of adding a row each,
  so a typing session is one version. Nothing else is ever updated or deleted.
- `ensure_current` keeps the text an AI generation is about to replace (a state never versioned:
  created before this table, or typed after the last version).
- `save_snapshot` sets the saved facet: on the latest version when it holds this very text and is
  not saved yet, else on a new version of the current text.

Versions are kept after a validation, a send or a deletion of the draft (`message_id` becomes
NULL); the application never deletes one.
"""

import uuid
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from http import HTTPStatus
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models import ContactMessage, ContactMessageVersion
from app.models.contact_messages import RATING_MAX
from app.services.errors import ContactMessageError

# Consecutive manual saves of one person within this delay are one version.
MERGE_WINDOW = timedelta(minutes=10)
COMMENT_MAX_LENGTH = 2000
# The generation config worth keeping with a text.
CONFIG_KEYS = (
    "tone",
    "sender",
    "instruction",
    "model",
    "prompt_version",
    "humanizer_score",
    "restored_from",
)
MAX_LISTED = 200


def _clean_config(config: Mapping[str, Any] | None) -> dict[str, object]:
    if not config:
        return {}
    return {key: config[key] for key in CONFIG_KEYS if config.get(key) not in (None, "")}


def _has_text(message: ContactMessage) -> bool:
    return bool(message.subject.strip() or message.body_text.strip())


def _same_content(version: ContactMessageVersion, message: ContactMessage) -> bool:
    return (
        version.subject == message.subject
        and version.body_text == message.body_text
        and version.from_email == message.from_email
        and list(version.to_recipients) == list(message.to_recipients)
    )


def _step_filter(message: ContactMessage) -> tuple[Any, Any]:
    return (
        ContactMessageVersion.sequence_id == message.sequence_id,
        ContactMessageVersion.rank == message.rank,
    )


def latest(session: Session, message: ContactMessage) -> ContactMessageVersion | None:
    return session.scalar(
        select(ContactMessageVersion)
        .where(*_step_filter(message))
        .order_by(ContactMessageVersion.created_at.desc(), ContactMessageVersion.id.desc())
        .limit(1)
    )


def _fill(version: ContactMessageVersion, message: ContactMessage) -> None:
    version.message_id = message.id
    version.revision = message.revision
    version.from_email = message.from_email
    version.to_recipients = list(message.to_recipients)
    version.subject = message.subject
    version.body_text = message.body_text


def _new(
    actor: ActorContext,
    message: ContactMessage,
    source: str,
    config: Mapping[str, Any] | None,
    moment: datetime,
) -> ContactMessageVersion:
    version = ContactMessageVersion(
        prospect_id=message.prospect_id,
        sequence_id=message.sequence_id,
        rank=message.rank,
        source=source,
        config=_clean_config(config),
        actor_type=actor.type.value,
        actor_display=actor.display,
        created_at=moment,
        updated_at=moment,
    )
    _fill(version, message)
    return version


def record(
    session: Session,
    actor: ActorContext,
    message: ContactMessage,
    source: str,
    config: Mapping[str, Any] | None = None,
    *,
    merge: bool = False,
    now: datetime | None = None,
) -> ContactMessageVersion | None:
    """Keep the message's current text as a version (None: empty, or already the latest)."""
    if not _has_text(message):
        return None
    moment = now or datetime.now(UTC)
    last = latest(session, message)
    if last is not None and _same_content(last, message):
        return None
    if (
        merge
        and last is not None
        and last.source == "manual"
        and source == "manual"
        and last.saved_at is None
        and last.actor_display == actor.display
        and moment - last.updated_at < MERGE_WINDOW
    ):
        _fill(last, message)
        last.updated_at = moment
        session.flush()
        return last
    version = _new(actor, message, source, config, moment)
    session.add(version)
    session.flush()
    return version


def generation_config(message: ContactMessage) -> dict[str, object]:
    return _clean_config(
        {"model": message.generation_model, "prompt_version": message.generation_prompt_version}
    )


def ensure_current(session: Session, actor: ActorContext, message: ContactMessage) -> None:
    """Keep the text about to be replaced by an AI generation if no version holds it."""
    source = "ai" if message.generation_model else "manual"
    record(session, actor, message, source, generation_config(message))


def list_versions(
    session: Session, message: ContactMessage, limit: int = MAX_LISTED
) -> list[ContactMessageVersion]:
    """The step's versions, newest first."""
    return list(
        session.scalars(
            select(ContactMessageVersion)
            .where(*_step_filter(message))
            .order_by(ContactMessageVersion.created_at.desc(), ContactMessageVersion.id.desc())
            .limit(limit)
        )
    )


def get_version(
    session: Session, message: ContactMessage, version_id: uuid.UUID
) -> ContactMessageVersion:
    version = session.get(ContactMessageVersion, version_id)
    if (
        version is None
        or version.sequence_id != message.sequence_id
        or version.rank != message.rank
    ):
        raise ContactMessageError(
            "version_not_found", HTTPStatus.NOT_FOUND, "No such version for this step."
        )
    return version


def save_snapshot(
    session: Session,
    actor: ActorContext,
    message: ContactMessage,
    *,
    rating: int,
    comment: str | None,
    humanizer_score: int | None = None,
    now: datetime | None = None,
) -> ContactMessageVersion:
    """« Sauvegarder »: the message's current text becomes a saved mail with its config, a
    rating 0-10 and an optional comment."""
    if not 0 <= rating <= RATING_MAX:
        raise ContactMessageError(
            "invalid_rating", HTTPStatus.UNPROCESSABLE_ENTITY, f"The rating is 0 to {RATING_MAX}."
        )
    if not _has_text(message):
        raise ContactMessageError(
            "message_empty", HTTPStatus.CONFLICT, "There is no text to save for this step."
        )
    moment = now or datetime.now(UTC)
    source = "ai" if message.generation_model else "manual"
    version = latest(session, message)
    if version is None or not _same_content(version, message) or version.saved_at is not None:
        version = _new(actor, message, source, generation_config(message), moment)
        session.add(version)
    config = dict(version.config) or generation_config(message)
    if humanizer_score is not None:
        config["humanizer_score"] = humanizer_score
    version.config = config
    version.revision = message.revision
    version.saved_at = moment
    version.saved_by_display = actor.display
    version.rating = rating
    version.comment = (comment or "").strip()[:COMMENT_MAX_LENGTH] or None
    session.flush()
    return version


def list_saved(
    session: Session, prospect_id: uuid.UUID, limit: int = MAX_LISTED
) -> list[ContactMessageVersion]:
    """The prospect's saved mails (every sequence), newest first."""
    return list(
        session.scalars(
            select(ContactMessageVersion)
            .where(
                ContactMessageVersion.prospect_id == prospect_id,
                ContactMessageVersion.saved_at.is_not(None),
            )
            .order_by(ContactMessageVersion.saved_at.desc(), ContactMessageVersion.id.desc())
            .limit(limit)
        )
    )
