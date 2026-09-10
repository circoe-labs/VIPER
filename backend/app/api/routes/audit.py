import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.api.dependencies import SessionDep
from app.core.actor import ActorType
from app.models.audit import AuditLogEntry
from app.services import audit

router = APIRouter(prefix="/audit", tags=["audit"])


class AuditActorResponse(BaseModel):
    type: ActorType
    id: str | None
    display: str


class AuditEventResponse(BaseModel):
    id: uuid.UUID
    occurred_at: datetime
    actor: AuditActorResponse
    action: str
    entity_type: str
    entity_id: uuid.UUID | None
    subject_type: str | None
    subject_id: uuid.UUID | None
    changes: dict[str, Any]
    context: dict[str, Any]


def event_response(entry: AuditLogEntry) -> AuditEventResponse:
    return AuditEventResponse(
        id=entry.id,
        occurred_at=entry.occurred_at,
        actor=AuditActorResponse(
            type=entry.actor_type, id=entry.actor_id, display=entry.actor_display
        ),
        action=entry.action,
        entity_type=entry.entity_type,
        entity_id=entry.entity_id,
        subject_type=entry.subject_type,
        subject_id=entry.subject_id,
        changes=entry.changes,
        context=entry.context,
    )


@router.get("/recent")
def recent_activity(
    session: SessionDep, limit: Annotated[int, Query(ge=1, le=100)] = 20
) -> list[AuditEventResponse]:
    """Latest audit events, newest first (raw events; Task 19 builds the readable history)."""
    return [event_response(entry) for entry in audit.recent_activity(session, limit=limit)]
