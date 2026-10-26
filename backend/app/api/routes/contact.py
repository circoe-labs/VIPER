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
from app.services import app_settings, contact_dashboard, contact_scheduling
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
# Cohort codes (`S39`): several at once, e.g. `?cohorts=S39&cohorts=S40`.
CohortCodes = Annotated[list[str] | None, Query(max_length=20, alias="cohorts")]
COHORT_CODE = re.compile(r"S\d{1,3}")


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


class SentStepOut(BaseModel):
    rank: int
    step: str
    label: str
    count: int
    first_on: date
    last_on: date


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
    appointments: int
    set_aside: int
    to_send_steps: list[str]
    sent_steps: list[SentStepOut]
    scheduled_steps: list[SentStepOut]
    next_steps: list[SentStepOut]


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
    sent_at: datetime | None = None
    scheduled_at: datetime | None = None


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


class SchedulingStepOut(BaseModel):
    rank: int
    step: str
    step_label: str
    drafts: int
    validated: int
    scheduled: int
    due: int
    forgotten: int
    forgotten_none: int
    forgotten_draft: int
    forgotten_validated: int


class ScheduledDayOut(BaseModel):
    day: date
    total: int
    by_step: dict[str, int]
    past: bool


class ForgottenProspectOut(BaseModel):
    id: uuid.UUID
    first_name: str | None
    last_name: str | None
    civility: Civility | None
    company_name: str | None
    cohort_code: str | None
    step: str
    step_label: str
    rank: int
    # `none` (nothing written) | `draft` (to validate) | `validated` (to schedule)
    state: Literal["none", "draft", "validated"]
    due_at: datetime | None
    overdue: bool


class PreparedMessageOut(BaseModel):
    prospect_id: uuid.UUID
    first_name: str | None
    last_name: str | None
    company_name: str | None
    cohort_code: str | None
    step: str
    step_label: str
    rank: int
    status: Literal["draft", "validated", "scheduled"]
    scheduled_at: datetime | None
    last_error_code: str | None


class SchedulingTotalsOut(BaseModel):
    scheduled: int
    validated: int
    drafts: int
    due: int
    forgotten: int
    scheduled_past: int
    scheduled_with_error: int
    scheduled_with_draft_error: int


class SchedulingOut(BaseModel):
    today: date
    week: str
    current_week: str
    max_follow_ups: int
    totals: SchedulingTotalsOut
    steps: list[SchedulingStepOut]
    days: list[ScheduledDayOut]
    forgotten: list[ForgottenProspectOut]
    messages: list[PreparedMessageOut]


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


def _cohort_codes(values: list[str] | None) -> tuple[str, ...]:
    codes = tuple(dict.fromkeys(value.strip().upper() for value in values or []))
    if any(COHORT_CODE.fullmatch(code) is None for code in codes):
        raise InvalidFieldError("cohorts", "Expected cohort codes such as S39.", "cohort_code")
    return codes


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


@router.get("/scheduling")
def scheduling(session: SessionDep, week: Week = None) -> SchedulingOut:
    """What is scheduled (by step and by day), what is still to validate or schedule, and the
    prospects with something to send this week whose mail is not scheduled (« oubliés »)."""
    with business_errors():
        asked = parse_week(week)
    result = contact_scheduling.overview(session, contact_clock(), asked)
    return SchedulingOut.model_validate(result, from_attributes=True)


@router.get("/prospects")
def prospects(
    session: SessionDep,
    q: Search = None,
    category: ContactCategory = ContactCategory.TO_SEND,
    week: Week = None,
    rank: Annotated[int | None, Query(ge=0)] = None,
    level: Annotated[str | None, Query(max_length=32)] = None,
    cohort: CohortParam = None,
    cohort_codes: CohortCodes = None,
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
            cohort_codes=_cohort_codes(cohort_codes),
            search=q,
            sort=sort,
        )
    page = contact_dashboard.list_contacts(
        session, filters, contact_clock(), limit=limit, offset=offset
    )
    return ContactPageOut.model_validate(page, from_attributes=True)
