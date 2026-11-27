"""Prospection API (`/api/prospection`, Task 14): the workspace's counters and people list.

Both endpoints take the same criteria (`q`, `role`, `activity`, `referent`, `tracking_status`,
`cohort`, `company`, `import_batch`, `company_kind`…), so each counter equals the total of the
list opened with its segment. Every criterion but `q`, the creation dates and the switches may be
repeated: any of its values (OR), and the criteria combine with AND. `role`, `referent`,
`tracking_status`, `cohort`, `commercial_segment` and `activity_category` also accept `none` (no
value). A row carries the derived Contact progress (cohort, sends, next
step, « Relance terminée », next due date: sequences rework D1).
Segment definitions: `app.services.prospection.segments`, doc/features/prospection-kpis.md.
"""

import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.api.dependencies import SessionDep, SettingsDep
from app.api.errors import business_errors
from app.api.query_types import Department, Many, OrNone
from app.core.config import Settings
from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    ContactTrackingStatus,
    PhoneType,
    VerificationStatus,
)
from app.services.errors import InvalidFieldError
from app.services.prospection import dashboard, query
from app.services.prospection.query import ProspectFilters, ProspectSort
from app.services.prospection.segments import (
    EmailState,
    Review,
    Segment,
    SegmentContext,
    VerificationState,
)

router = APIRouter(prefix="/prospection", tags=["prospection"])


class ReviewCountOut(BaseModel):
    total: int
    # Arrived since Monday (business time): verified, added, or set aside this week.
    week: int


class CountersOut(BaseModel):
    counts: dict[Segment, int]
    reviews: dict[Review, ReviewCountOut]
    # The business day "due" compares with (Europe/Paris).
    today: date
    # `VIPER_VERIFICATION_STALE_DAYS`; null = no age-based re-check configured.
    stale_threshold_days: int | None


class OverviewOut(BaseModel):
    total: int
    contacted: int
    deleted: int
    employment_validated: int
    employment_pending: int
    uncertain: int
    todo: int
    ignored: int


class ProspectRowOut(BaseModel):
    company_kind: str | None = None
    proposed_services: list[str] = []
    quality_score: int | None = None
    quality_band: str | None = None
    send_stage: str | None = None
    id: uuid.UUID
    civility: Civility | None
    first_name: str | None
    last_name: str | None
    role_label: str | None
    exact_job_title: str | None
    company_id: uuid.UUID | None
    company_name: str | None
    activity_status: ActivityStatus
    employment_verified_at: datetime | None
    verification_state: VerificationState
    review: Review
    primary_email: str | None
    primary_email_status: VerificationStatus | None
    email_state: EmailState
    primary_phone: str | None
    primary_phone_type: PhoneType | None
    tracking_status: ContactTrackingStatus | None
    cohort_code: str | None
    sent_count: int
    next_step: str | None
    finished: bool
    level: str | None
    level_label: str | None
    next_due_at: datetime | None
    next_due_week: str | None
    due: bool
    # An open « Erreur sur le mail » of a person or an import (D9).
    email_error: bool
    response_received_at: datetime | None
    appointment_at: datetime | None
    referent_id: uuid.UUID | None
    referent_name: str | None
    contactability_status: ContactabilityStatus
    do_not_contact_at: datetime | None
    updated_at: datetime


class ProspectPageOut(BaseModel):
    items: list[ProspectRowOut]
    total: int
    limit: int
    offset: int


def prospect_filters(
    q: Annotated[str | None, Query(max_length=200)] = None,
    role: Many[uuid.UUID | OrNone] = None,
    activity: Many[ActivityStatus] = None,
    referent: Many[uuid.UUID | OrNone] = None,
    tracking_status: Many[ContactTrackingStatus | OrNone] = None,
    cohort: Many[uuid.UUID | OrNone] = None,
    company: Many[uuid.UUID] = None,
    import_batch: Many[uuid.UUID] = None,
    services: Many[dashboard.ServiceCode] = None,
    send_stage: Many[Literal["sent", "r1", "r2"]] = None,
    email_state: Many[EmailState] = None,
    company_kind: Many[Literal["sme", "large", "institutional", "unclassified"]] = None,
    commercial_segment: Many[uuid.UUID | OrNone] = None,
    activity_category: Many[uuid.UUID | OrNone] = None,
    department: Many[Department] = None,
    reachable: bool = False,
    include_ignored: bool = False,
    validated_only: bool = False,
    verification_box: Many[query.VerificationBox] = None,
    created_from: date | None = None,
    created_to: date | None = None,
) -> ProspectFilters:
    with business_errors():
        if created_from is not None and created_to is not None and created_to < created_from:
            raise InvalidFieldError(
                "created_to", "The end must not precede the start.", "before_start"
            )
    return ProspectFilters(
        search=q,
        roles=tuple(role or ()),
        activities=tuple(activity or ()),
        referents=tuple(referent or ()),
        tracking_statuses=tuple(tracking_status or ()),
        cohorts=tuple(cohort or ()),
        company_ids=tuple(company or ()),
        import_batch_ids=tuple(import_batch or ()),
        services=tuple(services or ()),
        send_stages=tuple(send_stage or ()),
        email_states=tuple(email_state or ()),
        company_kinds=tuple(company_kind or ()),
        commercial_segments=tuple(commercial_segment or ()),
        activity_categories=tuple(activity_category or ()),
        departments=tuple(department or ()),
        reachable=reachable,
        include_ignored=include_ignored,
        validated_only=validated_only,
        verification_boxes=tuple(verification_box or ()),
        created_from=created_from,
        created_to=created_to,
    )


Filters = Annotated[ProspectFilters, Depends(prospect_filters)]


def segment_context(settings: Settings) -> SegmentContext:
    return SegmentContext.at(datetime.now(UTC), settings.verification_stale_days)


@router.get("/counters")
def counters(session: SessionDep, settings: SettingsDep, filters: Filters) -> CountersOut:
    """Size of every segment under the criteria (the segment itself is not a criterion here)."""
    result = query.count_segments(session, filters, segment_context(settings))
    return CountersOut.model_validate(result, from_attributes=True)


@router.get("/overview")
def overview(session: SessionDep, settings: SettingsDep) -> OverviewOut:
    """The whole base, not narrowed by any criterion: people held, contacted, and deleted."""
    result = query.base_overview(session, segment_context(settings))
    return OverviewOut.model_validate(result, from_attributes=True)


class CompanyOptionOut(BaseModel):
    id: uuid.UUID
    label: str


class FilterOptionsOut(BaseModel):
    companies: list[CompanyOptionOut]
    company_departments: list[str]
    warehouse_departments: list[str]


@router.get("/filter-options")
def filter_options(session: SessionDep) -> FilterOptionsOut:
    """The filter panels' choices that come from the data: every company, the departments."""
    return FilterOptionsOut.model_validate(query.filter_options(session), from_attributes=True)


@router.get("/prospects")
def prospects(
    session: SessionDep,
    settings: SettingsDep,
    filters: Filters,
    segment: Segment = Segment.ALL,
    review: Annotated[list[Review] | None, Query()] = None,
    sort: ProspectSort = ProspectSort.NAME,
    limit: Annotated[int, Query(ge=1, le=query.LIST_MAX_LIMIT)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ProspectPageOut:
    """One page of the segment's people under the criteria, in a stable order (ties by id)."""
    page = query.list_prospects(
        session,
        filters,
        segment_context(settings),
        segment=segment,
        review=tuple(review or ()),
        sort=sort,
        limit=limit,
        offset=offset,
    )
    result = ProspectPageOut.model_validate(page, from_attributes=True)
    details = dashboard.page_details(session, [item.id for item in page.items], settings)
    result.items = [item.model_copy(update=details[item.id]) for item in result.items]
    return result


@router.get("/dashboard")
def dashboard_overview(
    session: SessionDep, settings: SettingsDep, validated_only: bool = False
) -> dashboard.DashboardOut:
    return dashboard.overview(session, settings, validated_only=validated_only)
