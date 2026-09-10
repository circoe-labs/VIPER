"""Settings API (`/api/settings`): taxonomies and internal referents (Task 06).

`/settings/referents` for the Circoe referents, `/settings/{taxonomy}` for `roles`,
`activity-categories` and `commercial-segments`. Business refusals answer with a stable `code` the
UI turns into French copy (`app.api.errors`): 409 `duplicate` (with the existing value, which may
be inactive) and 409 `in_use` (with usage counts), 422 `invalid` (with the field), 404 `not_found`.
"""

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Annotated, Self

from fastapi import APIRouter, Query, status
from pydantic import BaseModel, StringConstraints, model_validator

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.services import referents, taxonomies
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


# Referent routes come first: `/settings/referents` must not be read as a taxonomy path.


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
