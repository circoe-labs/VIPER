"""Settings API (`/api/settings`): taxonomies and internal referents (Task 06), cohorts and the
Contact parameters (sequences rework D2, D5).

`/settings/referents` for the Circoe referents, `/settings/cohorts` for the cohorts `Sxx` (code and
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

from fastapi import APIRouter, Query, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.services import app_settings, cohorts, referents, taxonomies
from app.services.cohorts import CohortView
from app.services.contact_workflow import MAX_FOLLOW_UPS_LIMIT
from app.services.referents import ReferentInput, ReferentValue
from app.services.taxonomies import Taxonomy, TaxonomyValue

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
Name = Annotated[str, StringConstraints(max_length=referents.NAME_MAX_LENGTH)]
Email = Annotated[str, StringConstraints(max_length=referents.EMAIL_MAX_LENGTH)]


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


class ReferentOut(BaseModel):
    id: uuid.UUID
    first_name: str
    last_name: str
    email: str | None
    active: bool
    usage_count: int
    created_at: datetime
    updated_at: datetime


class ReferentIn(BaseModel):
    first_name: Name
    last_name: Name
    email: Email | None = None


class ActiveUpdate(BaseModel):
    active: bool


def taxonomy_out(value: TaxonomyValue) -> TaxonomyValueOut:
    return TaxonomyValueOut.model_validate(value, from_attributes=True)


def referent_out(value: ReferentValue) -> ReferentOut:
    return ReferentOut.model_validate(value, from_attributes=True)


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
    # After R<max> is sent, the prospect is « Relance terminée » (4 by default).
    max_follow_ups: int


def cohort_out(view: CohortView) -> CohortOut:
    return CohortOut.model_validate(view, from_attributes=True)


# Fixed paths come first: `/settings/referents`, `/settings/cohorts` and `/settings/contact` must
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


@router.get("/referents")
def list_referents(
    session: SessionDep, q: Search = None, active: ActiveFilter = None
) -> list[ReferentOut]:
    values = referents.list_referents(session, search=q, active=active)
    return [referent_out(value) for value in values]


@router.post("/referents", status_code=status.HTTP_201_CREATED)
def create_referent(body: ReferentIn, session: SessionDep, actor: CurrentActor) -> ReferentOut:
    with business_errors():
        value = referents.create_referent(session, actor, ReferentInput(**body.model_dump()))
    return referent_out(value)


@router.put("/referents/{referent_id}")
def update_referent(
    referent_id: uuid.UUID, body: ReferentIn, session: SessionDep, actor: CurrentActor
) -> ReferentOut:
    """Replace the referent's name and e-mail."""
    with business_errors():
        value = referents.update_referent(
            session, actor, referent_id, ReferentInput(**body.model_dump())
        )
    return referent_out(value)


@router.patch("/referents/{referent_id}")
def set_referent_active(
    referent_id: uuid.UUID, body: ActiveUpdate, session: SessionDep, actor: CurrentActor
) -> ReferentOut:
    """Deactivate or reactivate."""
    with business_errors():
        value = referents.set_referent_active(session, actor, referent_id, body.active)
    return referent_out(value)


@router.delete("/referents/{referent_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_referent(referent_id: uuid.UUID, session: SessionDep, actor: CurrentActor) -> None:
    with business_errors():
        referents.delete_referent(session, actor, referent_id)


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
