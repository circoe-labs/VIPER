"""Contact dashboard API (`/api/contact`, Contact port Slice S3): counters and people list.

`GET /dashboard` answers the cards (« À traiter cette semaine » split first contact / follow-ups /
R2 reviews, cumulative « RDV pris ») and the weeks of the planning; `GET /prospects` one page of
the list under `counter`, `week` (`2026-W41`), `state` and `q`. Both are read-only. Definitions:
`app.services.contact_dashboard`, doc/features/contact.md. The prospect detail (left panel) is
`GET /api/prospects/{id}`; its mail sequence is `GET /api/prospects/{id}/messages`.
"""

import re
import uuid
from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel

from app.api.dependencies import SessionDep
from app.api.errors import business_errors
from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactMessageStatus,
    ContactMessageStep,
    ContactTrackingStatus,
)
from app.services import contact_dashboard
from app.services.contact_dashboard import (
    ContactClock,
    ContactCounter,
    ContactFilters,
    NextStep,
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


class WeekOptionOut(BaseModel):
    week: str
    year: int
    number: int
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
    counts: dict[ContactCounter, int]
    weeks: list[WeekOptionOut]
    # The scheduled sending (S9): the page warns when scheduled messages will not leave.
    dispatch: DispatchStateOut


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
    tracking_status: ContactTrackingStatus
    planned_contact_at: datetime | None
    next_action_week: str | None
    due: bool
    next_step: NextStep | None
    messages: dict[ContactMessageStep, ContactMessageStatus | None]


class ContactPageOut(BaseModel):
    items: list[ContactRowOut]
    total: int
    limit: int
    offset: int


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


def parse_state(value: ContactTrackingStatus | None) -> ContactTrackingStatus | None:
    if value is ContactTrackingStatus.IGNORED:
        raise InvalidFieldError("state", "Ignored prospects are outside Contact.", "not_filterable")
    return value


@router.get("/dashboard")
def dashboard(request: Request, session: SessionDep, q: Search = None) -> ContactDashboardOut:
    result = contact_dashboard.dashboard(session, contact_clock(), q)
    state = dispatch_state(request.app.state, session)
    return ContactDashboardOut(
        today=result.today,
        current_week=result.current_week,
        counts=result.counts,
        weeks=[WeekOptionOut.model_validate(week, from_attributes=True) for week in result.weeks],
        dispatch=DispatchStateOut.model_validate(state, from_attributes=True),
    )


@router.get("/prospects")
def prospects(
    session: SessionDep,
    q: Search = None,
    counter: ContactCounter | None = None,
    week: Annotated[str | None, Query(max_length=16)] = None,
    state: ContactTrackingStatus | None = None,
    limit: Annotated[int, Query(ge=1, le=LIST_MAX_LIMIT)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ContactPageOut:
    """One page of the Contact list; without `counter`, `week` or `state`: the planning (people
    with a next-action week)."""
    with business_errors():
        filters = ContactFilters(
            counter=counter, week=parse_week(week), state=parse_state(state), search=q
        )
    page = contact_dashboard.list_contacts(
        session, filters, contact_clock(), limit=limit, offset=offset
    )
    return ContactPageOut.model_validate(page, from_attributes=True)
