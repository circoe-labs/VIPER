"""Prospection API (`/api/prospection`, Task 14): the workspace's counters and people list.

Both endpoints take the same criteria (`q`, `role`, `activity`, `referent`, `tracking_status`,
`company`, `import_batch`), so each counter equals the total of the list opened with its segment.
`role`, `referent` and `tracking_status` also accept `none` (no role, no referent, no tracking).
Segment definitions: `app.services.prospection.segments`, doc/features/prospection-kpis.md.
"""

import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.api.dependencies import SessionDep, SettingsDep
from app.core.config import Settings
from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    ContactTrackingStatus,
    PhoneType,
    VerificationStatus,
)
from app.services.prospection import query
from app.services.prospection.query import ProspectFilters, ProspectSort
from app.services.prospection.segments import EmailState, Segment, SegmentContext, VerificationState

router = APIRouter(prefix="/prospection", tags=["prospection"])

OrNone = Literal["none"]


class CountersOut(BaseModel):
    counts: dict[Segment, int]
    # The business day "due" compares with (Europe/Paris).
    today: date
    # `VIPER_VERIFICATION_STALE_DAYS`; null = no age-based re-check configured.
    stale_threshold_days: int | None


class ProspectRowOut(BaseModel):
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
    primary_email: str | None
    primary_email_status: VerificationStatus | None
    email_state: EmailState
    primary_phone: str | None
    primary_phone_type: PhoneType | None
    tracking_status: ContactTrackingStatus | None
    planned_contact_at: datetime | None
    due: bool
    planned_contact_week: str | None
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
    role: uuid.UUID | OrNone | None = None,
    activity: ActivityStatus | None = None,
    referent: uuid.UUID | OrNone | None = None,
    tracking_status: ContactTrackingStatus | OrNone | None = None,
    company: uuid.UUID | None = None,
    import_batch: uuid.UUID | None = None,
) -> ProspectFilters:
    return ProspectFilters(
        search=q,
        role=role,
        activity=activity,
        referent=referent,
        tracking_status=tracking_status,
        company_id=company,
        import_batch_id=import_batch,
    )


Filters = Annotated[ProspectFilters, Depends(prospect_filters)]


def segment_context(settings: Settings) -> SegmentContext:
    return SegmentContext.at(datetime.now(UTC), settings.verification_stale_days)


@router.get("/counters")
def counters(session: SessionDep, settings: SettingsDep, filters: Filters) -> CountersOut:
    """Size of every segment under the criteria (the segment itself is not a criterion here)."""
    result = query.count_segments(session, filters, segment_context(settings))
    return CountersOut.model_validate(result, from_attributes=True)


@router.get("/prospects")
def prospects(
    session: SessionDep,
    settings: SettingsDep,
    filters: Filters,
    segment: Segment = Segment.ALL,
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
        sort=sort,
        limit=limit,
        offset=offset,
    )
    return ProspectPageOut.model_validate(page, from_attributes=True)
