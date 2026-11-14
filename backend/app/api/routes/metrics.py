"""Weekly metrics API (`GET /api/metrics/weekly`): the truthful « cette semaine » read-model
shared by Prospection, Contact and Home. Read-only; definitions: doc/features/weekly-metrics.md."""

from datetime import date
from typing import Annotated

from fastapi import APIRouter, Query
from pydantic import BaseModel

from app.api.dependencies import SessionDep, SettingsDep
from app.api.routes.prospection import segment_context
from app.services import weekly_metrics
from app.services.weekly_metrics import MAX_SERIES_WEEKS

router = APIRouter(prefix="/metrics", tags=["metrics"])


class WeeklyAdditionsOut(BaseModel):
    prospects: int
    companies: int
    warehouses: int


class ContactStockOut(BaseModel):
    to_contact: int
    to_send: int
    overdue: int
    first_contact_to_send: int
    follow_up_to_send: int
    follow_up_overdue: int
    upcoming: int
    contacted: int
    responses: int
    appointments: int
    mail_error: int


class ContactWeekEventsOut(BaseModel):
    first_contacts: int
    first_appointments: int
    responses: int
    mail_errors_opened: int
    status_entries: dict[str, int]


class WeeklyMetricsOut(BaseModel):
    timezone: str
    week: str
    week_start: date
    week_end: date
    today: date
    additions: WeeklyAdditionsOut
    contact_stock: ContactStockOut
    contact_events: ContactWeekEventsOut
    # Always null: Prospection segment / activity-status weekly deltas have no event history.
    prospection_sub_status_deltas: None = None


@router.get("/weekly")
def weekly(session: SessionDep, settings: SettingsDep) -> WeeklyMetricsOut:
    result = weekly_metrics.weekly_metrics(session, segment_context(settings).today)
    return WeeklyMetricsOut.model_validate(result, from_attributes=True)


class WeekPointOut(BaseModel):
    week: str
    week_start: date
    week_end: date
    additions: WeeklyAdditionsOut
    first_contacts: int
    responses: int
    appointments: int


class ConversionTotalsOut(BaseModel):
    contacted: int
    responded: int
    with_appointment: int


class WeeklySeriesOut(BaseModel):
    timezone: str
    today: date
    weeks: list[WeekPointOut]
    totals: ConversionTotalsOut


@router.get("/weekly-series")
def weekly_series(
    session: SessionDep,
    settings: SettingsDep,
    weeks: Annotated[int, Query(ge=1, le=MAX_SERIES_WEEKS)] = 12,
) -> WeeklySeriesOut:
    result = weekly_metrics.weekly_series(session, segment_context(settings).today, weeks)
    return WeeklySeriesOut.model_validate(result, from_attributes=True)
