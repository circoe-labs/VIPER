"""Composable reads behind the MCP `find_*` tools: filter, cross and page the base freely.

An agent asks « the warehouses with no company », « the people of A and B together », « the
companies to verify with no SIREN » in one call: every finder takes the same few kinds of
criteria and combines them with AND.

- `search`: free text, every word must appear (accents and case ignored);
- `status`: the computed file status (`app.services.file_status` for companies and warehouses,
  `Review` for people) — `to_verify` is « not verified yet » (usable or incomplete);
- `missing`: only the files still missing one of these requirement codes;
- `has` / `lacks`: the field is filled / empty (`lacks: ["company", "postal_code"]`);
- the entity's own links and dates (`company_ids`, `company_names`, `postal_codes`, `cities`,
  `created_from`…).

Nothing here writes. The finders reuse the same expressions as the screens, so an agent and a
person see the same statuses. Contract: `doc/architecture/mcp-server.md` §3.13.
"""

import uuid
from collections.abc import Callable, Sequence
from datetime import date
from typing import Any, Literal

from sqlalchemy import ColumnElement, Text, and_, exists, func, or_, select
from sqlalchemy.dialects.postgresql import array
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.core.creation_period import created_between
from app.models import Company, Establishment, Prospect, Warehouse
from app.models.companies import company_activity_categories
from app.models.taxonomies import CommercialSegment
from app.repositories.list_sort import EntitySort, entity_order_by
from app.repositories.taxonomies import label_key, matches_words
from app.services import companies, warehouses
from app.services.errors import InvalidFieldError
from app.services.file_status import (
    FILE_STATUSES,
    company_missing,
    missing_of,
    status_condition,
    status_of,
    warehouse_missing,
)
from app.services.prospection import query as prospection_query
from app.services.prospection.query import ProspectFilters, ProspectSort
from app.services.prospection.segments import Review, Segment, SegmentContext

LIST_MAX = companies.LIST_MAX_LIMIT
MAX_IDS = 200
MAX_NAMES = 20

type Entity = Literal["company", "warehouse", "prospect"]
ENTITIES: tuple[Entity, ...] = ("company", "warehouse", "prospect")
# `to_verify`: anything not verified yet (usable or incomplete).
STATES = (*FILE_STATUSES, "to_verify")

COMPANY_CODES = (
    "name", "channel", "identity", "kind", "person",
    "siren", "legal_name", "size", "segment", "activity",
)  # fmt: skip
WAREHOUSE_CODES = ("name", "location", "category", "company", "siret", "address", "interlocutor")


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def _filled(column: Any) -> ColumnElement[bool]:
    return func.coalesce(func.btrim(column), "") != ""


# --- shared criteria ----------------------------------------------------------------------------


def _check_codes(field: str, values: Sequence[str] | None, allowed: Sequence[str]) -> list[str]:
    chosen = list(dict.fromkeys(values or ()))
    unknown = [value for value in chosen if value not in allowed]
    if unknown:
        raise InvalidFieldError(field, f"Expected any of: {', '.join(allowed)}.", "format")
    return chosen


def _state_conditions(
    usable: ColumnElement[Any],
    verified: ColumnElement[Any],
    state: str | None,
    missing: list[str],
) -> list[ColumnElement[bool]]:
    conditions: list[ColumnElement[bool]] = []
    if state == "to_verify":
        conditions.append(~status_condition("verified", usable, verified))
    elif state is not None:
        if state not in FILE_STATUSES:
            raise InvalidFieldError("status", f"Expected any of: {', '.join(STATES)}.", "format")
        conditions.append(status_condition(state, usable, verified))
    if missing:
        conditions.append(func.array_cat(usable, verified).op("&&")(array(missing, type_=Text)))
    return conditions


def _presence(
    fields: dict[str, Callable[[], ColumnElement[bool]]],
    has: Sequence[str] | None,
    lacks: Sequence[str] | None,
) -> list[ColumnElement[bool]]:
    names = tuple(fields)
    return [
        *(fields[name]() for name in _check_codes("has", has, names)),
        *(~fields[name]() for name in _check_codes("lacks", lacks, names)),
    ]


def _prefixes(column: Any, values: Sequence[str] | None) -> list[ColumnElement[bool]]:
    clean = [value.strip() for value in values or () if value and value.strip()]
    if not clean:
        return []
    return [or_(*(column.startswith(value, autoescape=True) for value in clean))]


def _any_words(column: Any, values: Sequence[str] | None) -> list[ColumnElement[bool]]:
    """Any of the phrases, each one matching word by word (accents and case ignored)."""
    phrases = [value.strip() for value in values or () if value and value.strip()]
    if not phrases:
        return []
    return [or_(*(and_(*matches_words(column, phrase)) for phrase in phrases))]


def _page(limit: int, offset: int) -> tuple[int, int]:
    return max(1, min(limit, LIST_MAX)), max(0, offset)


def _sort(value: str | None) -> EntitySort:
    try:
        return EntitySort(value) if value else EntitySort.NAME
    except ValueError as error:
        raise InvalidFieldError("sort", "Expected name, created or updated.", "format") from error


def resolve_company_names(
    session: Session, names: Sequence[str] | None
) -> tuple[list[uuid.UUID], list[dict[str, Any]]]:
    """Company ids for names typed by an agent, and what each name matched (so it can check)."""
    ids: list[uuid.UUID] = []
    report: list[dict[str, Any]] = []
    for name in [value.strip() for value in names or () if value and value.strip()][:MAX_NAMES]:
        text = func.concat_ws(" ", Company.display_name, Company.legal_name)
        rows = session.execute(
            select(Company.id, Company.display_name)
            .where(*matches_words(text, name))
            .order_by(label_key(Company.display_name), Company.id)
            .limit(20)
        ).all()
        ids.extend(row[0] for row in rows)
        report.append(
            {
                "query": name,
                "matches": [{"id": str(row[0]), "display_name": row[1]} for row in rows],
            }
        )
    return list(dict.fromkeys(ids)), report


# --- companies ----------------------------------------------------------------------------------

_COMPANY_FIELDS: dict[str, Callable[[], ColumnElement[bool]]] = {
    "website": lambda: _filled(Company.website_url),
    "email_domain": lambda: _filled(Company.email_domain),
    "siren": lambda: _filled(Company.siren),
    "legal_name": lambda: _filled(Company.legal_name),
    "size": lambda: _filled(Company.size_label),
    "kind": lambda: Company.company_kind.is_not(None),
    "segment": lambda: Company.commercial_segment_id.is_not(None),
    "activity": lambda: exists().where(company_activity_categories.c.company_id == Company.id),
    "establishment": lambda: exists().where(Establishment.company_id == Company.id),
    "postal_code": lambda: exists().where(
        Establishment.company_id == Company.id, _filled(Establishment.postal_code)
    ),
    "city": lambda: exists().where(
        Establishment.company_id == Company.id, _filled(Establishment.city)
    ),
    "prospect": lambda: exists().where(Prospect.company_id == Company.id),
    "warehouse": lambda: exists().where(
        Warehouse.establishment_id == Establishment.id, Establishment.company_id == Company.id
    ),
}
COMPANY_FIELDS = tuple(_COMPANY_FIELDS)


def find_companies(
    session: Session,
    *,
    search: str | None = None,
    ids: Sequence[uuid.UUID] | None = None,
    status: str | None = None,
    missing: Sequence[str] | None = None,
    company_kind: str | None = None,
    segment: str | None = None,
    has: Sequence[str] | None = None,
    lacks: Sequence[str] | None = None,
    postal_codes: Sequence[str] | None = None,
    cities: Sequence[str] | None = None,
    min_prospects: int | None = None,
    max_prospects: int | None = None,
    created_from: date | None = None,
    created_to: date | None = None,
    sort: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    limit, offset = _page(limit, offset)
    usable, verified = company_missing()
    prospect_total = select(func.count()).where(Prospect.company_id == Company.id).scalar_subquery()
    establishment_total = (
        select(func.count()).where(Establishment.company_id == Company.id).scalar_subquery()
    )
    warehouse_total = (
        select(func.count())
        .select_from(Warehouse)
        .join(Establishment, Establishment.id == Warehouse.establishment_id)
        .where(Establishment.company_id == Company.id)
        .scalar_subquery()
    )
    where: list[ColumnElement[bool]] = []
    text = func.concat_ws(
        " ", Company.display_name, Company.legal_name, Company.email_domain,
        Company.website_url, Company.siren,
    )  # fmt: skip
    if search and search.strip():
        where.extend(matches_words(text, search.strip()))
    if ids:
        where.append(Company.id.in_(list(ids)))
    where.extend(
        _state_conditions(usable, verified, status, _check_codes("missing", missing, COMPANY_CODES))
    )
    if company_kind == "unclassified":
        where.append(Company.company_kind.is_(None))
    elif company_kind:
        where.append(Company.company_kind == company_kind)
    if segment and segment.strip():
        where.extend(matches_words(CommercialSegment.label, segment.strip()))
    where.extend(_presence(_COMPANY_FIELDS, has, lacks))
    postal = _prefixes(Establishment.postal_code, postal_codes)
    if postal:
        where.append(exists().where(Establishment.company_id == Company.id, *postal))
    city = _any_words(Establishment.city, cities)
    if city:
        where.append(exists().where(Establishment.company_id == Company.id, *city))
    if min_prospects is not None:
        where.append(prospect_total >= min_prospects)
    if max_prospects is not None:
        where.append(prospect_total <= max_prospects)
    where.extend(created_between(Company.created_at, created_from, created_to))

    source = select(Company).outerjoin(
        CommercialSegment, CommercialSegment.id == Company.commercial_segment_id
    )
    total = session.scalar(select(func.count()).select_from(source.where(*where).subquery())) or 0
    rows = session.execute(
        select(
            Company,
            CommercialSegment.label,
            prospect_total,
            establishment_total,
            warehouse_total,
            usable,
            verified,
        )
        .outerjoin(CommercialSegment, CommercialSegment.id == Company.commercial_segment_id)
        .where(*where)
        .order_by(
            *entity_order_by(
                _sort(sort),
                Company.display_name,
                Company.created_at,
                Company.updated_at,
                Company.id,
            )
        )
        .limit(limit)
        .offset(offset)
    ).all()
    items = []
    for company, segment_label, people, sites, depots, usable_missing, verified_missing in rows:
        items.append(
            {
                "id": str(company.id),
                "display_name": company.display_name,
                "legal_name": company.legal_name,
                "siren": company.siren,
                "website_url": company.website_url,
                "email_domain": company.email_domain,
                "size_label": company.size_label,
                "company_kind": company.company_kind.value if company.company_kind else None,
                "commercial_segment": segment_label,
                "status": status_of(usable_missing, verified_missing),
                "missing": missing_of(usable_missing, verified_missing),
                "prospect_count": people,
                "establishment_count": sites,
                "warehouse_count": depots,
                "created_at": _iso(company.created_at),
                "updated_at": _iso(company.updated_at),
            }
        )
    return {"companies": items, "total": total, "limit": limit, "offset": offset}


# --- warehouses ---------------------------------------------------------------------------------

_WAREHOUSE_FIELDS: dict[str, Callable[[], ColumnElement[bool]]] = {
    "company": lambda: Warehouse.establishment_id.is_not(None),
    "establishment": lambda: Warehouse.establishment_id.is_not(None),
    "postal_code": lambda: _filled(Warehouse.postal_code),
    "city": lambda: _filled(Warehouse.city),
    "address": lambda: _filled(Warehouse.address),
    "siret": lambda: _filled(Warehouse.siret),
    "category": lambda: Warehouse.prospecting_category.is_not(None),
    "owner_name": lambda: _filled(Warehouse.owner_name),
    "owner_email": lambda: _filled(Warehouse.owner_email),
    "owner_linkedin": lambda: _filled(Warehouse.owner_linkedin),
    "notes": lambda: _filled(Warehouse.notes),
    "contacts": lambda: func.jsonb_array_length(Warehouse.contacts) > 0,
}
WAREHOUSE_FIELDS = tuple(_WAREHOUSE_FIELDS)


def find_warehouses(
    session: Session,
    *,
    search: str | None = None,
    ids: Sequence[uuid.UUID] | None = None,
    status: str | None = None,
    missing: Sequence[str] | None = None,
    category: str | None = None,
    to_contact: bool | None = None,
    company_ids: Sequence[uuid.UUID] | None = None,
    company_names: Sequence[str] | None = None,
    without_company: bool | None = None,
    has: Sequence[str] | None = None,
    lacks: Sequence[str] | None = None,
    postal_codes: Sequence[str] | None = None,
    cities: Sequence[str] | None = None,
    created_from: date | None = None,
    created_to: date | None = None,
    sort: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """`company_ids` / `company_names` name the owners (any of them); `without_company` is the
    opposite — warehouses linked to no building, so to no company."""
    limit, offset = _page(limit, offset)
    usable, verified = warehouse_missing()
    where: list[ColumnElement[bool]] = []
    text = func.concat_ws(
        " ", Warehouse.name, Warehouse.owner_name, Warehouse.owner_role, Warehouse.city,
        Warehouse.postal_code, Warehouse.address, Warehouse.siret,
    )  # fmt: skip
    if search and search.strip():
        where.extend(matches_words(text, search.strip()))
    if ids:
        where.append(Warehouse.id.in_(list(ids)))
    where.extend(
        _state_conditions(
            usable, verified, status, _check_codes("missing", missing, WAREHOUSE_CODES)
        )
    )
    if category == "unclassified":
        where.append(Warehouse.prospecting_category.is_(None))
    elif category in ("sme", "other"):
        where.append(Warehouse.prospecting_category == category)
    elif category:
        raise InvalidFieldError("category", "Expected sme, other or unclassified.", "format")
    if to_contact:
        where.append(Warehouse.contacts.contains([{"to_contact": True}]))
    owners = list(company_ids or ())
    resolved: list[dict[str, Any]] = []
    if company_names:
        named, resolved = resolve_company_names(session, company_names)
        owners = list(dict.fromkeys([*owners, *named]))
    if company_ids or company_names:
        where.append(Establishment.company_id.in_(owners))
    if without_company:
        where.append(Warehouse.establishment_id.is_(None))
    where.extend(_presence(_WAREHOUSE_FIELDS, has, lacks))
    where.extend(_prefixes(Warehouse.postal_code, postal_codes))
    where.extend(_any_words(Warehouse.city, cities))
    where.extend(created_between(Warehouse.created_at, created_from, created_to))

    source = (
        select(Warehouse.id)
        .outerjoin(Establishment, Establishment.id == Warehouse.establishment_id)
        .where(*where)
    )
    total = session.scalar(select(func.count()).select_from(source.subquery())) or 0
    rows = session.scalars(
        select(Warehouse)
        .outerjoin(Establishment, Establishment.id == Warehouse.establishment_id)
        .where(*where)
        .order_by(
            *entity_order_by(
                _sort(sort),
                Warehouse.name,
                Warehouse.created_at,
                Warehouse.updated_at,
                Warehouse.id,
            )
        )
        .limit(limit)
        .offset(offset)
    ).all()
    items = [item.model_dump(mode="json") for item in warehouses.present_many(session, list(rows))]
    answer: dict[str, Any] = {
        "warehouses": items, "total": total, "limit": limit, "offset": offset
    }  # fmt: skip
    if resolved:
        answer["resolved_companies"] = resolved
    return answer


def get_warehouse(session: Session, warehouse_id: uuid.UUID) -> dict[str, Any]:
    row = warehouses.get_warehouse(session, warehouse_id)
    return warehouses.present(session, row).model_dump(mode="json")


# --- people -------------------------------------------------------------------------------------

# `to_verify` for a person: usable or incomplete, never the ignored (set aside) ones.
_REVIEWS: dict[str, tuple[Review, ...]] = {
    "verified": (Review.VERIFIED,),
    "usable": (Review.USABLE,),
    "incomplete": (Review.INCOMPLETE,),
    "ignored": (Review.IGNORED,),
    "to_verify": (Review.USABLE, Review.INCOMPLETE),
}


def find_prospects(
    session: Session,
    settings: Settings,
    context: SegmentContext,
    *,
    search: str | None = None,
    status: Sequence[str] | None = None,
    segment: str | None = None,
    company_ids: Sequence[uuid.UUID] | None = None,
    company_names: Sequence[str] | None = None,
    without_company: bool = False,
    company_kind: str | None = None,
    reachable: bool = False,
    include_ignored: bool = False,
    created_from: date | None = None,
    created_to: date | None = None,
    sort: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    from app.api.routes.prospection import ProspectRowOut

    reviews: list[Review] = []
    for state in status or ():
        if state not in _REVIEWS:
            raise InvalidFieldError("status", f"Expected any of: {', '.join(_REVIEWS)}.", "format")
        reviews.extend(_REVIEWS[state])
    try:
        chosen_segment = Segment(segment) if segment else Segment.ALL
        chosen_sort = ProspectSort(sort) if sort else ProspectSort.NAME
    except ValueError as error:
        raise InvalidFieldError("segment", "Unknown segment or sort.", "format") from error
    owners = list(company_ids or ())
    resolved: list[dict[str, Any]] = []
    if company_names:
        named, resolved = resolve_company_names(session, company_names)
        owners = list(dict.fromkeys([*owners, *named]))
    limit, offset = _page(limit, offset)
    answer: dict[str, Any]
    if (company_ids or company_names) and not owners:
        # Companies were named and none exists: nobody to list (not « everybody »).
        answer = {"prospects": [], "total": 0, "limit": limit, "offset": offset}
    else:
        filters = ProspectFilters(
            search=(search or "").strip() or None,
            company_ids=tuple(owners),
            without_company=without_company,
            company_kind=company_kind,
            reachable=reachable,
            include_ignored=include_ignored,
            created_from=created_from,
            created_to=created_to,
        )
        page = prospection_query.list_prospects(
            session,
            filters,
            context,
            segment=chosen_segment,
            review=tuple(dict.fromkeys(reviews)),
            sort=chosen_sort,
            limit=limit,
            offset=offset,
        )
        answer = {
            "prospects": [
                ProspectRowOut.model_validate(item, from_attributes=True).model_dump(mode="json")
                for item in page.items
            ],
            "total": page.total,
            "limit": page.limit,
            "offset": page.offset,
        }
    if resolved:
        answer["resolved_companies"] = resolved
    return answer


# --- the verification queue ---------------------------------------------------------------------


def verification_overview(session: Session, context: SegmentContext) -> dict[str, dict[str, int]]:
    """How many companies, warehouses and people are verified / usable / incomplete."""
    usable_c, verified_c = company_missing()
    usable_w, verified_w = warehouse_missing()
    counts: dict[str, dict[str, int]] = {"company": {}, "warehouse": {}, "prospect": {}}
    for state in FILE_STATUSES:
        counts["company"][state] = (
            session.scalar(
                select(func.count())
                .select_from(Company)
                .where(status_condition(state, usable_c, verified_c))
            )
            or 0
        )
        counts["warehouse"][state] = (
            session.scalar(
                select(func.count())
                .select_from(Warehouse)
                .where(status_condition(state, usable_w, verified_w))
            )
            or 0
        )
    reviews = prospection_query.count_segments(session, ProspectFilters(), context).reviews
    for review in (Review.VERIFIED, Review.USABLE, Review.INCOMPLETE, Review.IGNORED):
        counts["prospect"][review.value] = reviews[review].total
    for entity in ENTITIES:
        counts[entity]["to_verify"] = counts[entity].get("usable", 0) + counts[entity].get(
            "incomplete", 0
        )
    return counts
