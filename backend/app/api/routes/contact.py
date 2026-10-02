"""Contact weekly planning API (`/api/contact`, sequences rework S3; handoff §11).

`GET /dashboard` answers the planning of a week (`week`, default the current business week): what
to send by rank (Contact, R1 … R<max>, overdue flagged), the distribution of the sequences in
progress by level, the categories (Erreur sur le mail, Relance terminée, Défaillant, S0, Réponse
reçue, RDV obtenu, Ignoré), the cohorts with their levels and the week options — under `cohort`
and `q`. `GET /prospects` one page of a list: `category` (default `to_send`), `week`, `rank`,
`level`, `cohort`, `q`, `sort`. Both are read-only. Definitions: `app.services.contact_dashboard`,
doc/features/contact.md. The prospect detail is `GET /api/prospects/{id}`; its mail sequence
`GET /api/prospects/{id}/messages`.
"""

import re
import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel

from app.api.dependencies import SessionDep
from app.api.errors import business_errors
from app.core.contact_steps import level_keys
from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    ContactMessageStatus,
    ContactTrackingStatus,
)
from app.services import app_settings, contact_dashboard
from app.services.contact_dashboard import (
    NONE,
    ContactCategory,
    ContactClock,
    ContactFilters,
    ContactSort,
)
from app.services.contact_dispatch_state import DispatchReason, dispatch_state
from app.services.contact_workflow import IsoWeek
from app.services.errors import InvalidFieldError
from app.services.prospection.query import LIST_MAX_LIMIT

router = APIRouter(prefix="/contact", tags=["contact"])

WEEK_FORMAT = re.compile(r"(\d{4})-W(\d{2})")
# Plausible planning years; outside them a week is a typo (and year 9999 would overflow).
MIN_YEAR, MAX_YEAR = 2000, 2100
Search = Annotated[str | None, Query(max_length=200)]
Week = Annotated[str | None, Query(max_length=16)]
CohortParam = Annotated[uuid.UUID | Literal["none"] | None, Query()]


class WeekOut(BaseModel):
    week: str
    monday: date
    sunday: date
    is_current: bool


class RankGroupOut(BaseModel):
    rank: int
    step: str
    step_label: str
    count: int
    overdue: int


class ToSendOut(BaseModel):
    total: int
    overdue: int
    groups: list[RankGroupOut]


class LevelCountOut(BaseModel):
    level: str
    label: str
    count: int


class CategoryCountOut(BaseModel):
    category: ContactCategory
    label: str
    count: int


class CohortSummaryOut(BaseModel):
    id: uuid.UUID
    code: str
    starts_on: date | None
    out_of_campaign: bool
    needs_review: bool
    prospects: int
    in_sequence: int
    to_send: int
    overdue: int
    levels: list[LevelCountOut]


class WeekOptionOut(BaseModel):
    week: str
    year: int
    number: int
    monday: date
    count: int


class DispatchStateOut(BaseModel):
    """Will a scheduled message really leave (S9)? `reason` when not: `disabled` |
    `toolbox_disabled` | `toolbox_not_configured` | `toolbox_disconnected` | `toolbox_expired` |
    `not_running`. `overdue_count`: scheduled, not claimed, time passed."""

    active: bool
    reason: DispatchReason | None
    scheduled_count: int
    overdue_count: int


class ContactDashboardOut(BaseModel):
    # The business day and its ISO week (« cette semaine »), e.g. `2026-W40`.
    today: date
    current_week: str
    # The planning week answered (the `week` asked, or the current one).
    week: WeekOut
    max_follow_ups: int
    to_send: ToSendOut
    levels: list[LevelCountOut]
    categories: list[CategoryCountOut]
    cohorts: list[CohortSummaryOut]
    weeks: list[WeekOptionOut]
    # The scheduled sending (S9): the page warns when scheduled messages will not leave.
    dispatch: DispatchStateOut


class MessageStateOut(BaseModel):
    rank: int
    step: str
    status: ContactMessageStatus


class ContactRowOut(BaseModel):
    id: uuid.UUID
    civility: Civility | None
    first_name: str | None
    last_name: str | None
    exact_job_title: str | None
    role_label: str | None
    company_id: uuid.UUID | None
    company_name: str | None
    primary_email: str | None
    activity_status: ActivityStatus
    contactability_status: ContactabilityStatus
    tracking_status: ContactTrackingStatus
    cohort_id: uuid.UUID | None
    cohort_code: str | None
    cohort_starts_on: date | None
    out_of_campaign: bool
    sent_count: int
    last_sent_at: datetime | None
    level: str | None
    level_label: str | None
    finished: bool
    next_rank: int | None
    next_step: str | None
    next_step_label: str | None
    next_due_at: datetime | None
    next_due_week: str | None
    to_send: bool
    overdue: bool
    email_error: bool
    next_message_status: ContactMessageStatus | None
    messages: list[MessageStateOut]


class ContactPageOut(BaseModel):
    items: list[ContactRowOut]
    total: int
    limit: int
    offset: int
    week: str


def contact_clock() -> ContactClock:
    return ContactClock.at(datetime.now(UTC))


def parse_week(value: str | None) -> IsoWeek | None:
    if value is None or not value.strip():
        return None
    match = WEEK_FORMAT.fullmatch(value.strip())
    try:
        if match is None or not MIN_YEAR <= int(match[1]) <= MAX_YEAR:
            raise ValueError(value)
        return IsoWeek(int(match[1]), int(match[2]))
    except ValueError as error:
        raise InvalidFieldError(
            "week", "Expected an existing ISO week such as 2026-W41.", "iso_week"
        ) from error


def _cohort(value: uuid.UUID | str | None) -> uuid.UUID | Literal["none"] | None:
    if value is None or isinstance(value, uuid.UUID):
        return value
    return NONE


@router.get("/dashboard")
def dashboard(
    request: Request,
    session: SessionDep,
    q: Search = None,
    week: Week = None,
    cohort: CohortParam = None,
) -> ContactDashboardOut:
    with business_errors():
        filters = ContactFilters(week=parse_week(week), cohort=_cohort(cohort), search=q)
    result = contact_dashboard.dashboard(session, contact_clock(), filters)
    state = dispatch_state(request.app.state, session)
    payload = {
        name: getattr(result, name)
        for name in ContactDashboardOut.model_fields
        if name != "dispatch"
    }
    return ContactDashboardOut.model_validate({**payload, "dispatch": state}, from_attributes=True)


@router.get("/prospects")
def prospects(
    session: SessionDep,
    q: Search = None,
    category: ContactCategory = ContactCategory.TO_SEND,
    week: Week = None,
    rank: Annotated[int | None, Query(ge=0)] = None,
    level: Annotated[str | None, Query(max_length=32)] = None,
    cohort: CohortParam = None,
    sort: ContactSort = ContactSort.DUE,
    limit: Annotated[int, Query(ge=1, le=LIST_MAX_LIMIT)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ContactPageOut:
    """One page of a planning list (default: what to send in the current week)."""
    with business_errors():
        max_follow_ups = app_settings.max_follow_ups(session)
        if rank is not None and rank > max_follow_ups:
            raise InvalidFieldError(
                "rank", f"Expected a rank between 0 and {max_follow_ups}.", "out_of_range"
            )
        if level is not None and level not in level_keys(max_follow_ups):
            raise InvalidFieldError("level", "Unknown level.", "unknown_level")
        filters = ContactFilters(
            category=category,
            week=parse_week(week),
            rank=rank,
            level=level,
            cohort=_cohort(cohort),
            search=q,
            sort=sort,
        )
    page = contact_dashboard.list_contacts(
        session, filters, contact_clock(), limit=limit, offset=offset
    )
    return ContactPageOut.model_validate(page, from_attributes=True)
