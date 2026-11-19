"""Versions and saved mails of the Contact messages (`/api/prospects/{id}/messages/...`).

- `GET  …/messages/saved`                     the prospect's saved mails (« Suivi de contact »),
                                              newest first, with their config and human note;
- `GET  …/messages/{step}/versions`           every kept version of the step, newest first (AI
                                              generations, manual states, restorations);
- `POST …/messages/{step}/versions/{id}/restore` `{expected_revision}`: the version's text becomes
                                              the current draft (itself a new version);
- `POST …/messages/{step}/saved`              « Sauvegarder »: `{rating 0..10, comment?,
                                              humanizer_score?}` keeps the current text as a saved
                                              mail with its generation config.

Declared before the messages router: `saved` must not be read as a step code.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Path
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.api.routes.contact_messages import MessageResultOut, StepPath, rank_of, result_out
from app.core.contact_steps import step_label
from app.models import ContactMessageVersion
from app.models.contact_messages import RATING_MAX
from app.services import contact_message_versions as versions
from app.services import contact_messages as service
from app.services.contact_message_versions import COMMENT_MAX_LENGTH
from app.services.contact_messages import require_author
from app.services.errors import ContactMessageError

router = APIRouter(prefix="/prospects/{prospect_id}/messages", tags=["contact"])


class VersionOut(BaseModel):
    id: uuid.UUID
    rank: int
    step: str
    step_label: str
    # The message revision this state became, and when (`updated_at`: the last merged save).
    revision: int
    created_at: datetime
    updated_at: datetime
    # `ai` | `manual` | `restore`.
    source: str
    from_email: str | None
    to: list[str]
    subject: str
    body_text: str
    # `{tone, sender, instruction, model, prompt_version, humanizer_score, restored_from}`.
    config: dict[str, object]
    actor: str
    # The saved facet (« mail sauvegardé »), all null for a plain version.
    saved_at: datetime | None
    saved_by: str | None
    rating: int | None
    comment: str | None


class VersionsOut(BaseModel):
    versions: list[VersionOut]


class SavedMailsOut(BaseModel):
    saved: list[VersionOut]


class SaveIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # 0 = « vraiment de la merde, ne fais plus jamais ça » … 10 = « super, garde ce style ».
    rating: Annotated[int, Field(ge=0, le=RATING_MAX)]
    comment: Annotated[str, StringConstraints(max_length=COMMENT_MAX_LENGTH)] | None = None
    humanizer_score: Annotated[int, Field(ge=0, le=100)] | None = None


class RestoreIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_revision: Annotated[int, Field(ge=1)]


def version_out(version: ContactMessageVersion) -> VersionOut:
    return VersionOut(
        id=version.id,
        rank=version.rank,
        step=version.step,
        step_label=step_label(version.rank),
        revision=version.revision,
        created_at=version.created_at,
        updated_at=version.updated_at,
        source=version.source,
        from_email=version.from_email,
        to=list(version.to_recipients),
        subject=version.subject,
        body_text=version.body_text,
        config=dict(version.config),
        actor=version.actor_display,
        saved_at=version.saved_at,
        saved_by=version.saved_by_display,
        rating=version.rating,
        comment=version.comment,
    )


@router.get("/saved")
def list_saved(prospect_id: uuid.UUID, session: SessionDep) -> SavedMailsOut:
    with business_errors():
        service.sequence_context(session, prospect_id)  # 404 for an unknown prospect
        return SavedMailsOut(
            saved=[version_out(item) for item in versions.list_saved(session, prospect_id)]
        )


@router.get("/{step}/versions")
def list_versions(prospect_id: uuid.UUID, step: StepPath, session: SessionDep) -> VersionsOut:
    with business_errors():
        message = service.get_message(session, prospect_id, rank_of(step))
        items = versions.list_versions(session, message) if message else []
        return VersionsOut(versions=[version_out(item) for item in items])


@router.post("/{step}/versions/{version_id}/restore")
def restore_version(
    prospect_id: uuid.UUID,
    step: StepPath,
    version_id: Annotated[uuid.UUID, Path()],
    body: RestoreIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MessageResultOut:
    with business_errors():
        result = service.restore_version(
            session, actor, prospect_id, rank_of(step), version_id, body.expected_revision
        )
    return result_out(result)


@router.post("/{step}/saved")
def save_mail(
    prospect_id: uuid.UUID,
    step: StepPath,
    body: SaveIn,
    session: SessionDep,
    actor: CurrentActor,
) -> VersionOut:
    with business_errors():
        require_author(actor)
        message = service.get_message(session, prospect_id, rank_of(step))
        if message is None:
            raise ContactMessageError("message_not_found", 404, "No message for this step yet.")
        version = versions.save_snapshot(
            session,
            actor,
            message,
            rating=body.rating,
            comment=body.comment,
            humanizer_score=body.humanizer_score,
        )
        return version_out(version)
