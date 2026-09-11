"""Home API (`GET /api/home`, Task 16): the global dashboard in one read-only call.

Prospect counts are the canonical Prospection segments (same keys as `/api/prospection/counters`),
so each Home card equals the Prospection counter it links to. Definitions:
doc/features/home-dashboard.md.
"""

import dataclasses
import uuid
from datetime import date, datetime

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.dependencies import SessionDep, SettingsDep
from app.api.history import HistoryActorOut
from app.api.routes.imports import BatchOut
from app.api.routes.prospection import segment_context
from app.models.enums import ContactTrackingStatus
from app.services import home
from app.services.audit import AuditSource
from app.services.prospection.segments import Segment

router = APIRouter(prefix="/home", tags=["home"])


class MonthProgressOut(BaseModel):
    month: date
    contacted: int
    appointments: int


class ProgressOut(BaseModel):
    # Informative targets (`VIPER_MONTHLY_CONTACT_TARGET` / `VIPER_MONTHLY_APPOINTMENT_TARGET`).
    contact_target: int
    appointment_target: int
    # Oldest first; the last one is the current month (business time).
    months: list[MonthProgressOut]


class ActionItemOut(BaseModel):
    prospect_id: uuid.UUID
    first_name: str | None
    last_name: str | None
    company_name: str | None
    tracking_status: ContactTrackingStatus | None
    at: datetime | None
    referent_name: str | None


class ActionGroupOut(BaseModel):
    total: int
    items: list[ActionItemOut]


class NextActionsOut(BaseModel):
    appointments: ActionGroupOut
    due: ActionGroupOut
    responses: ActionGroupOut


class EditItemOut(BaseModel):
    occurred_at: datetime
    actor: HistoryActorOut
    source: AuditSource | None
    subject_type: str
    subject_id: uuid.UUID | None
    subject_label: str | None
    # Value-free phrases of the history formatter; never field values.
    summary: list[str]


class HomeOut(BaseModel):
    today: date
    stale_threshold_days: int | None
    counts: dict[Segment, int]
    companies: int
    stages: dict[ContactTrackingStatus, int]
    progress: ProgressOut
    next_actions: NextActionsOut
    recent_imports: list[BatchOut]
    recent_edits: list[EditItemOut]


@router.get("")
def home_dashboard(session: SessionDep, settings: SettingsDep) -> HomeOut:
    summary = home.home_summary(session, segment_context(settings))
    progress = {
        "contact_target": settings.monthly_contact_target,
        "appointment_target": settings.monthly_appointment_target,
        "months": summary.months,
    }
    fields = {field.name: getattr(summary, field.name) for field in dataclasses.fields(summary)}
    return HomeOut.model_validate({**fields, "progress": progress}, from_attributes=True)
