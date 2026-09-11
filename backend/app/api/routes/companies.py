"""Companies API (`/api/companies`): the lightweight Company editor and its list (Task 07).

`POST` creates a company with its establishments; `PUT` replaces the whole editable state — every
field, the category list and the **full** establishment list (an establishment left out is
removed), so both lists are required there. Business refusals use the stable codes of
`app.api.errors`: 422 `invalid` with `field` (`siren`, `establishments.1.siret`…) and `reason`
(`format`, `checksum`, `webmail`, `repeated`, `unknown`…), 409 `duplicate` naming the company that
holds a SIREN/SIRET, 409 `in_use` when prospects still reference a company to delete, 404.
"""

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Query, status
from pydantic import BaseModel, Field, StringConstraints

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.api.history import HistoryCursor, HistoryLimit, HistoryPageOut
from app.models.enums import ActivityStatus, Civility, ContactabilityStatus
from app.services import companies, history
from app.services.companies import CompanyDetail, CompanyInput, EstablishmentInput
from app.services.imports.models import MatchReason

router = APIRouter(prefix="/companies", tags=["companies"])

# Raw input bounds only; the service applies the precise limits with field-level codes.
Line = Annotated[str, StringConstraints(max_length=1000)]
Paragraph = Annotated[str, StringConstraints(max_length=20_000)]
MAX_ITEMS = 100


class TaxonomyRefOut(BaseModel):
    id: uuid.UUID
    label: str
    active: bool


class EstablishmentIn(BaseModel):
    # Omitted for a new establishment.
    id: uuid.UUID | None = None
    name: Line | None = None
    siret: Line | None = None
    address_line1: Line | None = None
    address_line2: Line | None = None
    postal_code: Line | None = None
    city: Line | None = None
    country: Line | None = None
    kind: Line | None = None
    is_primary: bool = False


class CompanyIn(BaseModel):
    display_name: Line
    legal_name: Line | None = None
    siren: Line | None = None
    website_url: Line | None = None
    email_domain: Line | None = None
    size_label: Line | None = None
    commercial_segment_id: uuid.UUID | None = None
    activity_category_ids: list[uuid.UUID] = Field(default_factory=list, max_length=MAX_ITEMS)
    project_done_with_circoe: Paragraph | None = None
    project_type: Paragraph | None = None
    circoe_references: Paragraph | None = None
    client_approach: Paragraph | None = None
    establishments: list[EstablishmentIn] = Field(default_factory=list, max_length=MAX_ITEMS)


class CompanyReplace(CompanyIn):
    """Both lists are required: a partial body must not wipe the establishments or categories."""

    activity_category_ids: list[uuid.UUID] = Field(max_length=MAX_ITEMS)
    establishments: list[EstablishmentIn] = Field(max_length=MAX_ITEMS)


class EstablishmentOut(BaseModel):
    id: uuid.UUID
    name: str | None
    siret: str | None
    address_line1: str | None
    address_line2: str | None
    postal_code: str | None
    city: str | None
    country: str | None
    kind: str | None
    is_primary: bool


class ProspectSummaryOut(BaseModel):
    id: uuid.UUID
    civility: Civility | None
    first_name: str | None
    last_name: str | None
    role_label: str | None
    exact_job_title: str | None
    activity_status: ActivityStatus
    contactability_status: ContactabilityStatus


class CompanyOut(BaseModel):
    id: uuid.UUID
    display_name: str
    legal_name: str | None
    siren: str | None
    website_url: str | None
    email_domain: str | None
    size_label: str | None
    commercial_segment: TaxonomyRefOut | None
    activity_categories: list[TaxonomyRefOut]
    project_done_with_circoe: str | None
    project_type: str | None
    circoe_references: str | None
    client_approach: str | None
    establishments: list[EstablishmentOut]
    prospect_count: int
    # The first 100 prospects, by last then first name.
    prospects: list[ProspectSummaryOut]
    created_at: datetime
    updated_at: datetime


class CompanyListItemOut(BaseModel):
    id: uuid.UUID
    display_name: str
    legal_name: str | None
    siren: str | None
    email_domain: str | None
    commercial_segment_label: str | None
    city: str | None
    establishment_count: int
    prospect_count: int
    updated_at: datetime


class CompanyPageOut(BaseModel):
    items: list[CompanyListItemOut]
    total: int


class SimilarCompanyOut(BaseModel):
    id: uuid.UUID
    display_name: str
    legal_name: str | None
    email_domain: str | None
    reasons: list[MatchReason]


def company_out(detail: CompanyDetail) -> CompanyOut:
    return CompanyOut.model_validate(detail, from_attributes=True)


def company_input(body: CompanyIn) -> CompanyInput:
    return CompanyInput(
        **body.model_dump(exclude={"establishments"}),
        establishments=[EstablishmentInput(**item.model_dump()) for item in body.establishments],
    )


@router.get("")
def list_companies(
    session: SessionDep,
    q: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=companies.LIST_MAX_LIMIT)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> CompanyPageOut:
    """Ordered by name; `q` matches every word of the names, e-mail domain and website (case and
    accents ignored), or digits of a SIREN/SIRET."""
    page = companies.list_companies(session, search=q, limit=limit, offset=offset)
    return CompanyPageOut.model_validate(page, from_attributes=True)


@router.get("/similar")
def similar_companies(
    session: SessionDep,
    name: Annotated[str | None, Query(max_length=1000)] = None,
    email_domain: Annotated[str | None, Query(max_length=1000)] = None,
    exclude: uuid.UUID | None = None,
) -> list[SimilarCompanyOut]:
    """Existing companies the typed one may duplicate (warning before creating it)."""
    found = companies.find_similar(
        session, name=name, email_domain=email_domain, exclude_id=exclude
    )
    return [SimilarCompanyOut.model_validate(item, from_attributes=True) for item in found]


@router.get("/{company_id}")
def get_company(company_id: uuid.UUID, session: SessionDep) -> CompanyOut:
    with business_errors():
        return company_out(companies.get_company(session, company_id))


@router.get("/{company_id}/history")
def company_history(
    company_id: uuid.UUID,
    session: SessionDep,
    limit: HistoryLimit = 10,
    before: HistoryCursor = None,
) -> HistoryPageOut:
    """Readable history, newest first: the company's fields, categories and establishments."""
    page = history.history_page(session, "company", company_id, limit=limit, before=before)
    return HistoryPageOut.model_validate(page, from_attributes=True)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_company(body: CompanyIn, session: SessionDep, actor: CurrentActor) -> CompanyOut:
    with business_errors():
        return company_out(companies.create_company(session, actor, company_input(body)))


@router.put("/{company_id}")
def update_company(
    company_id: uuid.UUID, body: CompanyReplace, session: SessionDep, actor: CurrentActor
) -> CompanyOut:
    with business_errors():
        detail = companies.update_company(session, actor, company_id, company_input(body))
    return company_out(detail)


@router.delete("/{company_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_company(company_id: uuid.UUID, session: SessionDep, actor: CurrentActor) -> None:
    with business_errors():
        companies.delete_company(session, actor, company_id)
