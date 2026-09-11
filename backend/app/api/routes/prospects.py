"""Prospects API (`/api/prospects`, Task 15): the Prospect editor's view model and writes.

`GET` returns the editor's view model; `POST` creates a prospect entered by hand (with its `manual`
provenance); `PUT` replaces the editable state atomically — identity, company, role, employment
and its explicit verification action, the **full** e-mail and phone lists (an alias left out is
deleted; both lists are required), contact tracking. Contactability is not part of it (extra
fields are refused): `PUT …/contactability` is the dedicated, reasoned operation. Every write
carries the `version` the client read; a stale one answers 409 `conflict`. Business refusals use
the stable codes of `app.api.errors` (422 `invalid` with a field path such as `emails.1.address`,
409 `duplicate` for a new role label, 409 `do_not_contact` when deleting an opposed prospect, 404).
"""

import uuid
from datetime import UTC, date, datetime, time
from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.api.dependencies import CurrentActor, SessionDep, SettingsDep
from app.api.errors import business_errors
from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    ContactTrackingStatus,
    OriginType,
    PhoneType,
    ProspectSourceType,
    VerificationStatus,
)
from app.services import prospect_editor
from app.services.contact_channels import ChannelItem
from app.services.prospect_editor import (
    EditorClock,
    EmploymentVerification,
    ManualSource,
    ProspectForm,
    ProspectView,
    TrackingForm,
    VerificationAction,
)
from app.services.prospection.segments import VerificationState

router = APIRouter(prefix="/prospects", tags=["prospects"])

# Raw input bounds only; the services apply the precise limits with field-level codes.
Line = Annotated[str, StringConstraints(max_length=1000)]
Text = Annotated[str, StringConstraints(max_length=5000)]
Version = Annotated[str, StringConstraints(max_length=64)]
MAX_ALIASES = 50


class StrictModel(BaseModel):
    # A field the editor does not own (e.g. contactability) is a client error, never ignored.
    model_config = ConfigDict(extra="forbid")


class EmailIn(StrictModel):
    # Omitted for a new e-mail.
    id: uuid.UUID | None = None
    address: Line
    is_primary: bool = False
    is_active: bool = True
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    # The one-click « Vérifié »: verified, dated now.
    verified_now: bool = False
    source_reference: Line | None = None


class PhoneIn(StrictModel):
    id: uuid.UUID | None = None
    number: Line
    type: PhoneType
    is_primary: bool = False
    is_active: bool = True
    verification_status: VerificationStatus = VerificationStatus.UNVERIFIED
    verified_now: bool = False
    source_reference: Line | None = None


class EmploymentVerificationIn(StrictModel):
    action: VerificationAction = VerificationAction.KEEP
    # `verified_on` only: a business day, today at the latest.
    day: date | None = None


class TrackingIn(StrictModel):
    status: ContactTrackingStatus = ContactTrackingStatus.TO_CONTACT
    planned_contact_on: date | None = None
    response_received_on: date | None = None
    appointment_on: date | None = None
    appointment_time: time | None = None
    referent_id: uuid.UUID | None = None


class ProspectIn(StrictModel):
    civility: Civility | None = None
    first_name: Line | None = None
    last_name: Line | None = None
    company_id: uuid.UUID | None = None
    role_id: uuid.UUID | None = None
    # A new role, created with the save (inline creation) instead of `role_id`.
    role_label: Line | None = None
    exact_job_title: Line | None = None
    activity_status: ActivityStatus = ActivityStatus.UNKNOWN
    employment_verification: EmploymentVerificationIn = Field(
        default_factory=EmploymentVerificationIn
    )
    emails: list[EmailIn] = Field(default_factory=list, max_length=MAX_ALIASES)
    phones: list[PhoneIn] = Field(default_factory=list, max_length=MAX_ALIASES)
    # Null leaves the current tracking as it is.
    tracking: TrackingIn | None = None


class ProvenanceIn(StrictModel):
    legal_basis_or_collection_context: Text
    source_reference: Line | None = None


class ProspectCreate(ProspectIn):
    provenance: ProvenanceIn


class ProspectReplace(ProspectIn):
    """The aliases are full lists and required: a partial body must not delete them."""

    version: Version
    emails: list[EmailIn] = Field(max_length=MAX_ALIASES)
    phones: list[PhoneIn] = Field(max_length=MAX_ALIASES)


class ContactabilityIn(StrictModel):
    do_not_contact: bool
    # Required both ways: why the person is opposed, or why the opposition is lifted.
    reason: Text
    version: Version


class CompanySummaryOut(BaseModel):
    id: uuid.UUID
    display_name: str
    legal_name: str | None
    siren: str | None
    email_domain: str | None
    website_url: str | None
    commercial_segment_label: str | None
    city: str | None
    prospect_count: int


class ValueRefOut(BaseModel):
    id: uuid.UUID
    label: str
    active: bool


class EmailOut(BaseModel):
    id: uuid.UUID
    address: str
    is_primary: bool
    is_active: bool
    verification_status: VerificationStatus
    last_verified_at: datetime | None
    origin_type: OriginType
    source_reference: str | None
    imported_unverified: bool


class PhoneOut(BaseModel):
    id: uuid.UUID
    number: str
    type: PhoneType
    is_primary: bool
    is_active: bool
    verification_status: VerificationStatus
    last_verified_at: datetime | None
    origin_type: OriginType
    source_reference: str | None
    imported_unverified: bool


class TrackingOut(BaseModel):
    status: ContactTrackingStatus
    planned_contact_on: date | None
    planned_contact_week: str | None
    response_received_on: date | None
    appointment_on: date | None
    appointment_time: time | None
    referent: ValueRefOut | None
    status_since: datetime | None


class SourceOut(BaseModel):
    id: uuid.UUID
    source_type: ProspectSourceType
    source_reference: str | None
    collected_at: datetime
    legal_basis_or_collection_context: str | None
    actor_display: str | None
    import_filename: str | None


class ProspectOut(BaseModel):
    id: uuid.UUID
    version: str
    civility: Civility | None
    first_name: str | None
    last_name: str | None
    company: CompanySummaryOut | None
    role: ValueRefOut | None
    exact_job_title: str | None
    activity_status: ActivityStatus
    employment_verified_at: datetime | None
    verification_state: VerificationState
    employment_imported_unverified: bool
    contactability_status: ContactabilityStatus
    do_not_contact_at: datetime | None
    do_not_contact_reason: str | None
    emails: list[EmailOut]
    phones: list[PhoneOut]
    tracking: TrackingOut | None
    sources: list[SourceOut]
    import_row_count: int
    today: date
    stale_threshold_days: int | None
    created_at: datetime
    updated_at: datetime


def editor_clock(settings: SettingsDep) -> EditorClock:
    return EditorClock(now=datetime.now(UTC), stale_days=settings.verification_stale_days)


ClockDep = Annotated[EditorClock, Depends(editor_clock)]


def prospect_out(view: ProspectView) -> ProspectOut:
    return ProspectOut.model_validate(view, from_attributes=True)


def prospect_form(body: ProspectIn) -> ProspectForm:
    tracking = body.tracking
    return ProspectForm(
        civility=body.civility,
        first_name=body.first_name,
        last_name=body.last_name,
        company_id=body.company_id,
        role_id=body.role_id,
        role_label=body.role_label,
        exact_job_title=body.exact_job_title,
        activity_status=body.activity_status,
        employment_verification=EmploymentVerification(**body.employment_verification.model_dump()),
        emails=[
            ChannelItem(value=item.address, **item.model_dump(exclude={"address"}))
            for item in body.emails
        ],
        phones=[
            ChannelItem(
                value=item.number,
                phone_type=item.type,
                **item.model_dump(exclude={"number", "type"}),
            )
            for item in body.phones
        ],
        tracking=TrackingForm(**tracking.model_dump()) if tracking else None,
    )


@router.get("/{prospect_id}")
def get_prospect(prospect_id: uuid.UUID, session: SessionDep, clock: ClockDep) -> ProspectOut:
    with business_errors():
        return prospect_out(prospect_editor.get_view(session, prospect_id, clock))


@router.post("", status_code=status.HTTP_201_CREATED)
def create_prospect(
    body: ProspectCreate, session: SessionDep, actor: CurrentActor, clock: ClockDep
) -> ProspectOut:
    source = ManualSource(**body.provenance.model_dump())
    with business_errors():
        view = prospect_editor.create_prospect(session, actor, prospect_form(body), source, clock)
    return prospect_out(view)


@router.put("/{prospect_id}")
def update_prospect(
    prospect_id: uuid.UUID,
    body: ProspectReplace,
    session: SessionDep,
    actor: CurrentActor,
    clock: ClockDep,
) -> ProspectOut:
    with business_errors():
        view = prospect_editor.update_prospect(
            session, actor, prospect_id, body.version, prospect_form(body), clock
        )
    return prospect_out(view)


@router.put("/{prospect_id}/contactability")
def set_contactability(
    prospect_id: uuid.UUID,
    body: ContactabilityIn,
    session: SessionDep,
    actor: CurrentActor,
    clock: ClockDep,
) -> ProspectOut:
    with business_errors():
        view = prospect_editor.set_contactability(
            session,
            actor,
            prospect_id,
            body.version,
            do_not_contact=body.do_not_contact,
            reason=body.reason,
            clock=clock,
        )
    return prospect_out(view)


@router.delete("/{prospect_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_prospect(
    prospect_id: uuid.UUID,
    version: Annotated[str, Query(max_length=64)],
    session: SessionDep,
    actor: CurrentActor,
) -> None:
    with business_errors():
        prospect_editor.delete_prospect(session, actor, prospect_id, version)
