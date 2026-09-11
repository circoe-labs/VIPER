"""Readable history responses (Task 19), shared by the prospect and company history routes and
Home's recent edits. Only typed display data from `app.services.history` — never raw audit JSON."""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import Query
from pydantic import BaseModel

from app.core.actor import ActorType
from app.services.audit import AuditSource

# Entries per page of a history.
HistoryLimit = Annotated[int, Query(ge=1, le=50)]
# The `next_cursor` of the previous page.
HistoryCursor = Annotated[uuid.UUID | None, Query()]


class HistoryActorOut(BaseModel):
    # human | import | system | agent
    kind: ActorType
    label: str
    id: str | None
    on_behalf_of: str | None


class HistoryChangeOut(BaseModel):
    label: str
    before: str | None
    after: str | None


class HistoryEntryOut(BaseModel):
    id: uuid.UUID
    occurred_at: datetime
    actor: HistoryActorOut
    source: AuditSource | None
    actions: list[str]
    title: str
    summary: list[str]
    changes: list[HistoryChangeOut]


class HistoryPageOut(BaseModel):
    items: list[HistoryEntryOut]
    next_cursor: uuid.UUID | None
