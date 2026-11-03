"""Read models behind the MCP tools: the basic lookups an agent needs before proposing anything.

The tools return JSON-ready dictionaries (ids as strings, dates as ISO-8601), never ORM objects:
the MCP layer only serialises, it does not reshape. Every read reuses the service the browser
uses (`companies.list_companies`, `companies.get_company`, `prospect_editor.get_view`) so an agent
and a person see the same labels and the same verification states.

Nothing here writes. Contract: `doc/architecture/mcp-server.md` §3.2.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session, selectinload

from app.core.config import Settings
from app.models.companies import Company
from app.models.prospects import Prospect
from app.models.taxonomies import Role
from app.services import companies
from app.services.prospect_editor import EditorClock, get_view
from app.services.prospect_score import ScoreConfig

# The domain's page cap (`companies.LIST_MAX_LIMIT`); one page per tool call, the agent loops.
LIST_MAX = companies.LIST_MAX_LIMIT
MAX_COMPANY_IDS = 50


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


def _value(value: Any) -> Any:
    """JSON-safe scalar: an enum becomes its value, everything else is left to `json.dumps`."""
    return value.value if hasattr(value, "value") else value


def _person(first_name: str | None, last_name: str | None) -> str | None:
    name = " ".join(part for part in (first_name, last_name) if part)
    return name or None


def _company_row(company: companies.CompanyListItem) -> dict[str, Any]:
    return {
        "id": str(company.id),
        "display_name": company.display_name,
        "legal_name": company.legal_name,
        "siren": company.siren,
        "email_domain": company.email_domain,
        "commercial_segment": company.commercial_segment_label,
        "city": company.city,
        "establishment_count": company.establishment_count,
        "prospect_count": company.prospect_count,
        "updated_at": _iso(company.updated_at),
    }


def _company_prospects(company: companies.CompanyDetail) -> list[dict[str, Any]]:
    return [
        {
            "id": str(prospect.id),
            "civility": _value(prospect.civility),
            "first_name": prospect.first_name,
            "last_name": prospect.last_name,
            "name": _person(prospect.first_name, prospect.last_name),
            "role": prospect.role_label,
            "exact_job_title": prospect.exact_job_title,
            "activity_status": _value(prospect.activity_status),
            "contactability_status": _value(prospect.contactability_status),
        }
        for prospect in company.prospects
    ]


def _company_detail(company: companies.CompanyDetail) -> dict[str, Any]:
    """The company record an agent may read.

    The Circoe-internal columns (`project_done_with_circoe`, `project_type`, `circoe_references`,
    `client_approach`) stay out: they are a commercial judgement, not public data, and the same
    rule that keeps them out of a mission payload applies to a read tool.
    """
    return {
        "id": str(company.id),
        "display_name": company.display_name,
        "legal_name": company.legal_name,
        "siren": company.siren,
        "website_url": company.website_url,
        "email_domain": company.email_domain,
        "size_label": company.size_label,
        "commercial_segment": (
            {"id": str(company.commercial_segment.id), "label": company.commercial_segment.label}
            if company.commercial_segment
            else None
        ),
        "activity_categories": [
            {"id": str(category.id), "label": category.label}
            for category in company.activity_categories
        ],
        "establishments": [
            {
                "id": str(site.id),
                "name": site.name,
                "siret": site.siret,
                "address_line1": site.address_line1,
                "address_line2": site.address_line2,
                "postal_code": site.postal_code,
                "city": site.city,
                "country": site.country,
                "kind": site.kind,
                "is_primary": site.is_primary,
            }
            for site in company.establishments
        ],
        "prospect_count": company.prospect_count,
        "prospects": _company_prospects(company),
        "created_at": _iso(company.created_at),
        "updated_at": _iso(company.updated_at),
    }


def list_companies(
    session: Session, *, search: str | None = None, limit: int = 50, offset: int = 0
) -> dict[str, Any]:
    """One page of companies, ordered by name; `search` matches names, domain, website or SIREN."""
    page = companies.list_companies(session, search=search, limit=limit, offset=offset)
    return {
        "companies": [_company_row(company) for company in page.items],
        "total": page.total,
        "limit": max(1, min(limit, LIST_MAX)),
        "offset": max(0, offset),
    }


def get_company(session: Session, company_id: uuid.UUID) -> dict[str, Any]:
    return _company_detail(companies.get_company(session, company_id))


def _search_pattern(search: str | None) -> str | None:
    text = (search or "").strip()
    if not text:
        return None
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _prospect_labels(
    session: Session, prospects: list[Prospect]
) -> tuple[dict[uuid.UUID, str], dict[uuid.UUID, str]]:
    company_ids = {row.company_id for row in prospects if row.company_id is not None}
    role_ids = {row.role_id for row in prospects if row.role_id is not None}
    companies_by_id = {
        company.id: company.display_name
        for company in session.scalars(select(Company).where(Company.id.in_(company_ids)))
    }
    roles_by_id = {
        role.id: role.label for role in session.scalars(select(Role).where(Role.id.in_(role_ids)))
    }
    return companies_by_id, roles_by_id


def _primary_email(prospect: Prospect) -> str | None:
    for email in prospect.emails:
        if email.is_primary and email.is_active:
            return email.address
    return None


def _primary_phone(prospect: Prospect) -> str | None:
    for phone in prospect.phones:
        if phone.is_primary and phone.is_active:
            return phone.number
    return None


def _prospect_row(
    prospect: Prospect, companies_by_id: dict[uuid.UUID, str], roles_by_id: dict[uuid.UUID, str]
) -> dict[str, Any]:
    return {
        "id": str(prospect.id),
        "civility": _value(prospect.civility),
        "first_name": prospect.first_name,
        "last_name": prospect.last_name,
        "name": _person(prospect.first_name, prospect.last_name),
        "company": (
            {
                "id": str(prospect.company_id),
                "display_name": companies_by_id.get(prospect.company_id),
            }
            if prospect.company_id is not None
            else None
        ),
        "role": (
            {"id": str(prospect.role_id), "label": roles_by_id.get(prospect.role_id)}
            if prospect.role_id is not None
            else None
        ),
        "exact_job_title": prospect.exact_job_title,
        "activity_status": _value(prospect.activity_status),
        "employment_verified_at": _iso(prospect.employment_verified_at),
        "contactability_status": _value(prospect.contactability_status),
        "primary_email": _primary_email(prospect),
        "primary_phone": _primary_phone(prospect),
        "updated_at": _iso(prospect.updated_at),
    }


def list_prospects(
    session: Session,
    *,
    company_ids: list[uuid.UUID] | None = None,
    search: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> dict[str, Any]:
    """One page of people, companies first: filter by employer and/or name.

    `company_ids` is the cheap, self-sufficient way to "read the people of these companies"; a
    search alone is allowed but capped like every list (≤ 200 per page).
    """
    limit = max(1, min(limit, LIST_MAX))
    offset = max(0, offset)
    where: list[Any] = []
    if company_ids:
        where.append(Prospect.company_id.in_(company_ids))
    pattern = _search_pattern(search)
    if pattern is not None:
        where.append(
            or_(
                Prospect.first_name.ilike(pattern, escape="\\"),
                Prospect.last_name.ilike(pattern, escape="\\"),
            )
        )
    statement = (
        select(Prospect)
        .options(selectinload(Prospect.emails), selectinload(Prospect.phones))
        .where(*where)
        .order_by(
            func.coalesce(Prospect.last_name, ""),
            func.coalesce(Prospect.first_name, ""),
            Prospect.id,
        )
        .limit(limit)
        .offset(offset)
    )
    rows = list(session.scalars(statement))
    total = session.scalar(select(func.count()).select_from(Prospect).where(*where)) or 0
    companies_by_id, roles_by_id = _prospect_labels(session, rows)
    return {
        "prospects": [_prospect_row(row, companies_by_id, roles_by_id) for row in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


def editor_clock(settings: Settings) -> EditorClock:
    """The same clock the prospect editor uses when a person opens the record."""
    return EditorClock(
        now=datetime.now(UTC),
        stale_days=settings.verification_stale_days,
        score=ScoreConfig.from_settings(settings),
    )


def get_prospect(session: Session, prospect_id: uuid.UUID, settings: Settings) -> dict[str, Any]:
    """The full record, with the same verification states and score the browser shows."""
    view = get_view(session, prospect_id, editor_clock(settings))
    return {
        "id": str(view.id),
        "version": view.version,
        "civility": _value(view.civility),
        "first_name": view.first_name,
        "last_name": view.last_name,
        "name": _person(view.first_name, view.last_name),
        "company": (
            {
                "id": str(view.company.id),
                "display_name": view.company.display_name,
                "siren": view.company.siren,
                "city": view.company.city,
            }
            if view.company
            else None
        ),
        "role": (
            {"id": str(view.role.id), "label": view.role.label} if view.role else None
        ),
        "exact_job_title": view.exact_job_title,
        "activity_status": _value(view.activity_status),
        "employment_verified_at": _iso(view.employment_verified_at),
        "verification_state": _value(view.verification_state),
        "contactability_status": _value(view.contactability_status),
        "do_not_contact": (
            {
                "at": _iso(view.do_not_contact_at),
                "reason": view.do_not_contact_reason,
            }
            if view.contactability_status.value == "do_not_contact"
            else None
        ),
        "emails": [
            {
                "address": email.address,
                "is_primary": email.is_primary,
                "is_active": email.is_active,
                "verification_status": _value(email.verification_status),
            }
            for email in view.emails
        ],
        "phones": [
            {
                "number": phone.number,
                "type": _value(phone.type),
                "is_primary": phone.is_primary,
                "is_active": phone.is_active,
                "verification_status": _value(phone.verification_status),
            }
            for phone in view.phones
        ],
        "tracking": (
            {"status": _value(view.tracking.status)} if view.tracking is not None else None
        ),
        "contact": {
            "level": view.contact.level,
            "level_label": view.contact.level_label,
            "sent_count": view.contact.sent_count,
            "next_step": view.contact.next_step,
            "next_due_on": view.contact.next_due_on.isoformat()
            if view.contact.next_due_on
            else None,
            "finished": view.contact.finished,
        },
        "score": {
            "total": view.score.total,
            "band": _value(view.score.band),
            "summary": view.score.summary,
        },
        "sources": [
            {
                "type": _value(source.source_type),
                "reference": source.source_reference,
                "collected_at": _iso(source.collected_at),
            }
            for source in view.sources
        ],
        "created_at": _iso(view.created_at),
        "updated_at": _iso(view.updated_at),
    }
