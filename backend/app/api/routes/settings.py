"""Settings API (`/api/settings`): taxonomies (Task 06), cohorts and the
Contact parameters (sequences rework D2, D5).

`/settings/cohorts` for the cohorts `Sxx` (code and
real start date entered by a person; `S0` fixed, out of campaign), `/settings/contact` for
« max relances », `/settings/{taxonomy}` for `roles`, `activity-categories` and
`commercial-segments`. Business refusals answer with a stable `code` the
UI turns into French copy (`app.api.errors`): 409 `duplicate` (with the existing value, which may
be inactive) and 409 `in_use` (with usage counts), 422 `invalid` (with the field), 404 `not_found`.
"""

import uuid
from datetime import date, datetime
from enum import StrEnum
from typing import Annotated, Self

from fastapi import APIRouter, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.api.dependencies import CurrentActor, SessionDep, SettingsDep
from app.api.errors import business_errors
from app.services import app_settings, cohorts, taxonomies, taxonomy_cleanup
from app.services.cohorts import CohortView
from app.services.contact_workflow import MAX_FOLLOW_UPS_LIMIT
from app.services.taxonomies import Taxonomy, TaxonomyValue
from app.services.taxonomy_cleanup_prompt import taxonomy_cleanup_prompt

router = APIRouter(prefix="/settings", tags=["settings"])


class TaxonomyPath(StrEnum):
    ROLES = "roles"
    ACTIVITY_CATEGORIES = "activity-categories"
    COMMERCIAL_SEGMENTS = "commercial-segments"


TAXONOMIES = {
    TaxonomyPath.ROLES: Taxonomy.ROLE,
    TaxonomyPath.ACTIVITY_CATEGORIES: Taxonomy.ACTIVITY_CATEGORY,
    TaxonomyPath.COMMERCIAL_SEGMENTS: Taxonomy.COMMERCIAL_SEGMENT,
}

Search = Annotated[str | None, Query(alias="q", max_length=200)]
ActiveFilter = Annotated[bool | None, Query(description="Only active (true) or inactive (false).")]
Label = Annotated[str, StringConstraints(max_length=taxonomies.LABEL_MAX_LENGTH)]


class TaxonomyValueOut(BaseModel):
    id: uuid.UUID
    label: str
    slug: str
    active: bool
    usage_count: int
    created_at: datetime
    updated_at: datetime


class TaxonomyValueCreate(BaseModel):
    label: Label


class TaxonomyValueUpdate(BaseModel):
    """Rename (`label`) and/or deactivate/reactivate (`active`)."""

    label: Label | None = None
    active: bool | None = None

    @model_validator(mode="after")
    def has_a_change(self) -> Self:
        if self.label is None and self.active is None:
            raise ValueError("Give a label or an active flag.")
        return self


class ActiveUpdate(BaseModel):
    active: bool


def taxonomy_out(value: TaxonomyValue) -> TaxonomyValueOut:
    return TaxonomyValueOut.model_validate(value, from_attributes=True)


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


CohortCode = Annotated[str, StringConstraints(max_length=32)]


class CohortIn(StrictModel):
    # `S37`, « s 37 »… normalized to `S<n>`.
    code: CohortCode
    # The real date of the first send; required except for S0 (never derived from an ISO week).
    starts_on: date | None = None


class CohortUpdate(StrictModel):
    """Rename and/or re-date; either confirms a cohort created by migration (`needs_review`)."""

    code: CohortCode | None = None
    starts_on: date | None = None

    @model_validator(mode="after")
    def has_a_change(self) -> Self:
        if self.code is None and self.starts_on is None:
            raise ValueError("Give a code or a start date.")
        return self


class CohortOut(BaseModel):
    id: uuid.UUID
    code: str
    starts_on: date | None
    out_of_campaign: bool
    needs_review: bool
    # Prospects currently in the cohort, and every sequence ever in it.
    current_count: int
    sequence_count: int


class ContactSettingsIn(StrictModel):
    max_follow_ups: int = Field(ge=0, le=MAX_FOLLOW_UPS_LIMIT)


class ContactSettingsOut(BaseModel):
    # After R<max> is sent, the prospect is « Relance terminée » (2 by default, never more).
    max_follow_ups: int


def cohort_out(view: CohortView) -> CohortOut:
    return CohortOut.model_validate(view, from_attributes=True)


# Fixed paths come first: `/settings/cohorts` and `/settings/contact` must
# not be read as a taxonomy path.


@router.get("/cohorts")
def list_cohorts(session: SessionDep) -> list[CohortOut]:
    """S0 first, then by start date and code."""
    return [cohort_out(view) for view in cohorts.list_cohorts(session)]


@router.post("/cohorts", status_code=status.HTTP_201_CREATED)
def create_cohort(body: CohortIn, session: SessionDep, actor: CurrentActor) -> CohortOut:
    with business_errors():
        cohort = cohorts.create_cohort(session, actor, body.code, body.starts_on)
        return cohort_out(cohorts.get_view(session, cohort.id))


@router.patch("/cohorts/{cohort_id}")
def update_cohort(
    cohort_id: uuid.UUID, body: CohortUpdate, session: SessionDep, actor: CurrentActor
) -> CohortOut:
    with business_errors():
        cohorts.update_cohort(session, actor, cohort_id, code=body.code, starts_on=body.starts_on)
        return cohort_out(cohorts.get_view(session, cohort_id))


@router.delete("/cohorts/{cohort_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_cohort(cohort_id: uuid.UUID, session: SessionDep, actor: CurrentActor) -> None:
    """Only a cohort no sequence ever used (409 `in_use`); never S0 (409 `cohort_s0_fixed`)."""
    with business_errors():
        cohorts.delete_cohort(session, actor, cohort_id)


@router.get("/contact")
def contact_settings(session: SessionDep) -> ContactSettingsOut:
    return ContactSettingsOut(max_follow_ups=app_settings.max_follow_ups(session))


@router.put("/contact")
def update_contact_settings(
    body: ContactSettingsIn, session: SessionDep, actor: CurrentActor
) -> ContactSettingsOut:
    with business_errors():
        value = app_settings.set_max_follow_ups(session, actor, body.max_follow_ups)
    return ContactSettingsOut(max_follow_ups=value)


class CleanupMemberOut(BaseModel):
    id: uuid.UUID
    label: str
    usage_count: int


class CleanupGroupOut(BaseModel):
    # The proposed final label and the current values it replaces (one, or several to merge).
    label: str
    members: list[CleanupMemberOut]


class CleanupProposalOut(BaseModel):
    groups: list[CleanupGroupOut]
    model: str


class CleanupGroupIn(StrictModel):
    label: Annotated[str, StringConstraints(max_length=taxonomies.LABEL_MAX_LENGTH)]
    ids: list[uuid.UUID] = Field(max_length=500)


class CleanupApplyIn(StrictModel):
    groups: list[CleanupGroupIn] = Field(max_length=500)


class CleanupAppliedOut(BaseModel):
    renamed: int
    merged: int
    moved: int


@router.post("/{taxonomy}/cleanup/proposal")
def propose_taxonomy_cleanup(
    taxonomy: TaxonomyPath, request: Request, session: SessionDep, settings: SettingsDep
) -> CleanupProposalOut:
    """Ask the AI for a cleaner list of this taxonomy's labels (homogenised, grouped). Nothing is
    written: the person edits the groups, then sends them to `/cleanup/apply`."""
    with business_errors():
        proposal = taxonomy_cleanup.propose(
            session,
            settings,
            TAXONOMIES[taxonomy],
            prompt=taxonomy_cleanup_prompt(settings),
            transport=request.app.state.openai_transport,
        )
    return CleanupProposalOut.model_validate(proposal, from_attributes=True)


@router.post("/{taxonomy}/cleanup/apply")
def apply_taxonomy_cleanup(
    taxonomy: TaxonomyPath, body: CleanupApplyIn, session: SessionDep, actor: CurrentActor
) -> CleanupAppliedOut:
    """Apply the edited groups: each becomes one value (renamed, the others merged into it, their
    prospects / companies moved over). All or nothing."""
    with business_errors():
        applied = taxonomy_cleanup.apply(
            session,
            actor,
            TAXONOMIES[taxonomy],
            [(group.label, group.ids) for group in body.groups],
        )
    return CleanupAppliedOut.model_validate(applied, from_attributes=True)


@router.get("/{taxonomy}")
def list_taxonomy_values(
    taxonomy: TaxonomyPath, session: SessionDep, q: Search = None, active: ActiveFilter = None
) -> list[TaxonomyValueOut]:
    values = taxonomies.list_values(session, TAXONOMIES[taxonomy], search=q, active=active)
    return [taxonomy_out(value) for value in values]


@router.post("/{taxonomy}", status_code=status.HTTP_201_CREATED)
def create_taxonomy_value(
    taxonomy: TaxonomyPath, body: TaxonomyValueCreate, session: SessionDep, actor: CurrentActor
) -> TaxonomyValueOut:
    """Also used by the inline "Créer « … »" option of form pickers."""
    with business_errors():
        value = taxonomies.create_value(session, actor, TAXONOMIES[taxonomy], body.label)
    return taxonomy_out(value)


@router.patch("/{taxonomy}/{value_id}")
def update_taxonomy_value(
    taxonomy: TaxonomyPath,
    value_id: uuid.UUID,
    body: TaxonomyValueUpdate,
    session: SessionDep,
    actor: CurrentActor,
) -> TaxonomyValueOut:
    kind = TAXONOMIES[taxonomy]
    with business_errors():
        if body.label is not None:
            value = taxonomies.rename_value(session, actor, kind, value_id, body.label)
        if body.active is not None:
            value = taxonomies.set_value_active(session, actor, kind, value_id, body.active)
    return taxonomy_out(value)


@router.delete("/{taxonomy}/{value_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_taxonomy_value(
    taxonomy: TaxonomyPath, value_id: uuid.UUID, session: SessionDep, actor: CurrentActor
) -> None:
    with business_errors():
        taxonomies.delete_value(session, actor, TAXONOMIES[taxonomy], value_id)
