"""Global search API (`GET /api/search?q=`, Task 17): the shell's search field, read-only.

Grouped, typed results — prospects, companies, establishments — each with how it matched, its badges
and what opening it shows; never raw rows. Matching, ranking and limits:
doc/features/global-search.md.
"""

import dataclasses
import uuid
from typing import Annotated, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from app.api.dependencies import SessionDep
from app.api.errors import business_errors
from app.services import search as service
from app.services.search import Badge, MatchField, MatchKind, SearchType

router = APIRouter(prefix="/search", tags=["search"])


class MatchOut(BaseModel):
    field: MatchField
    kind: MatchKind
    # The matched value when the label does not show it (an e-mail, a SIREN…).
    value: str | None


class OpenOut(BaseModel):
    """The record editor that opens the result (an establishment opens its company)."""

    editor: Literal["prospect", "company"]
    id: uuid.UUID


class RecordOut(BaseModel):
    """The result's row in the Database Explorer."""

    table: Literal["prospects", "companies", "establishments"]
    id: uuid.UUID


class HitOut(BaseModel):
    id: uuid.UUID
    label: str
    sublabel: str | None
    match: MatchOut
    badges: list[Badge]
    open: OpenOut
    record: RecordOut


class ProspectHitOut(HitOut):
    type: Literal[SearchType.PROSPECT]
    company_id: uuid.UUID | None
    company_name: str | None


class CompanyHitOut(HitOut):
    type: Literal[SearchType.COMPANY]
    siren: str | None
    email_domain: str | None
    city: str | None
    prospect_count: int


class EstablishmentHitOut(HitOut):
    type: Literal[SearchType.ESTABLISHMENT]
    company_id: uuid.UUID
    company_name: str
    siret: str | None


type HitUnion = Annotated[
    ProspectHitOut | CompanyHitOut | EstablishmentHitOut, Field(discriminator="type")
]


class GroupOut(BaseModel):
    type: SearchType
    items: list[HitUnion]
    # More results than listed: the user can narrow the query.
    has_more: bool


class SearchOut(BaseModel):
    # The query as searched (spaces collapsed).
    query: str
    # Non-empty groups, best first match first.
    groups: list[GroupOut]


def _hit(hit: service.SearchHit) -> dict[str, object]:
    fields = dataclasses.asdict(hit)
    target = fields.pop("target")
    return {
        **fields,
        "open": {"editor": target["editor"], "id": target["editor_id"]},
        "record": {"table": target["table"], "id": target["record_id"]},
    }


@router.get("")
def search(
    session: SessionDep, q: Annotated[str, Query(max_length=service.MAX_QUERY_LENGTH)]
) -> SearchOut:
    """Prospects (name, e-mail, phone), companies (name, SIREN, domain, website) and establishments
    (SIRET, name, city) matching `q` — 2 characters at least (422 otherwise)."""
    with business_errors():
        results = service.search(session, q)
    return SearchOut.model_validate(
        {
            "query": results.query,
            "groups": [
                {
                    "type": group.type,
                    "items": [_hit(hit) for hit in group.items],
                    "has_more": group.has_more,
                }
                for group in results.groups
            ],
        }
    )
