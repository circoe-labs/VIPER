"""Internal context references: read-only VIPER records a mission supplies to its agent.

Task `viper_mission_agent_configuration_v2`, Slice 02. Contract:
`doc/architecture/missions.md` § « Bibliothèque de sources, contexte interne et preuves ».

A **context reference** (`mission_context_refs`) points to an allowlisted VIPER record (a company or
a prospect card) that helps the agent do its work. It is deliberately **not** a `MissionTarget`:
a target is the subject a task processes (one task per target, the result is proposed for it);
context is supporting data, never a subject, never evidence (it cannot increment a source counter)
and never a write path.

`resolve` is the runtime contract (Slice 07 puts it in the claim payload): the references of a
mission are read **at that moment** and serialised through a fixed allowlist of fields, bounded in
count and size. No arbitrary table, column or SQL is ever selected. Circoe-internal commercial
notes of a company (`project_done_with_circoe`, `project_type`, `circoe_references`,
`client_approach`) and every contact channel of a person (e-mails, phones, do-not-contact reason)
are **not** in the allowlist: an agent working through a model provider gets the identity and
business context it needs, not the private relationship history.

Operations flush; the caller owns the transaction.
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.companies import Company, Establishment
from app.models.mission_sources import CONTEXT_KINDS, MissionContextRef
from app.models.missions import Mission
from app.models.prospects import Prospect
from app.models.taxonomies import CommercialSegment, Role
from app.services.errors import InvalidFieldError, NotFoundError

MAX_CONTEXT_REFS = 50
NOTE_MAX_LENGTH = 500
VALUE_MAX_LENGTH = 300
MAX_SITES = 5
KIND_COMPANY = "company"
KIND_PROSPECT = "prospect"


@dataclass(frozen=True, slots=True)
class ContextRefInput:
    kind: str
    id: uuid.UUID
    note: str | None = None


@dataclass(frozen=True, slots=True)
class ContextRefRow:
    """A reference as the mission form shows it (a label to recognise the record by)."""

    kind: str
    id: uuid.UUID
    label: str
    hint: str | None
    note: str | None


def _clip(value: str | None) -> str | None:
    cleaned = (value or "").strip()
    if not cleaned:
        return None
    return cleaned if len(cleaned) <= VALUE_MAX_LENGTH else cleaned[: VALUE_MAX_LENGTH - 1] + "…"


def _person_name(prospect: Prospect) -> str:
    return (
        " ".join(part for part in (prospect.first_name, prospect.last_name) if part)
        or "Prospect sans nom"
    )


def _check_kind(kind: str) -> None:
    if kind not in CONTEXT_KINDS:
        raise InvalidFieldError("context_refs", f"Unknown record kind {kind!r}.", "unknown_kind")


def _clean_note(note: str | None) -> str | None:
    cleaned = (note or "").strip()
    if len(cleaned) > NOTE_MAX_LENGTH:
        raise InvalidFieldError(
            "context_refs", f"A note has at most {NOTE_MAX_LENGTH} characters.", "too_long"
        )
    return cleaned or None


# --- links --------------------------------------------------------------------------------------


def list_refs(session: Session, mission_id: uuid.UUID) -> list[ContextRefRow]:
    """The mission's context references with a label each (a deleted record cascaded away)."""
    refs = session.scalars(
        select(MissionContextRef)
        .where(MissionContextRef.mission_id == mission_id)
        .order_by(MissionContextRef.created_at, MissionContextRef.id)
    ).all()
    companies = {
        company.id: company
        for company in session.scalars(
            select(Company).where(
                Company.id.in_([ref.company_id for ref in refs if ref.company_id is not None])
            )
        )
    }
    prospects = {
        prospect.id: prospect
        for prospect in session.scalars(
            select(Prospect).where(
                Prospect.id.in_([ref.prospect_id for ref in refs if ref.prospect_id is not None])
            )
        )
    }
    company_names = {
        company.id: company.display_name
        for company in session.scalars(
            select(Company).where(
                Company.id.in_(
                    {p.company_id for p in prospects.values() if p.company_id is not None}
                )
            )
        )
    }
    rows: list[ContextRefRow] = []
    for ref in refs:
        if ref.company_id is not None and ref.company_id in companies:
            company = companies[ref.company_id]
            rows.append(
                ContextRefRow(KIND_COMPANY, company.id, company.display_name, None, ref.note)
            )
        elif ref.prospect_id is not None and ref.prospect_id in prospects:
            prospect = prospects[ref.prospect_id]
            rows.append(
                ContextRefRow(
                    KIND_PROSPECT,
                    prospect.id,
                    _person_name(prospect),
                    company_names.get(prospect.company_id) if prospect.company_id else None,
                    ref.note,
                )
            )
    return rows


def set_refs(
    session: Session, mission: Mission, refs: Sequence[ContextRefInput]
) -> list[ContextRefInput]:
    """Replace the mission's context references. Each record must exist and its kind be
    allowlisted; duplicates collapse (the first note wins). Bounded to `MAX_CONTEXT_REFS`."""
    unique: dict[tuple[str, uuid.UUID], ContextRefInput] = {}
    for ref in refs:
        _check_kind(ref.kind)
        unique.setdefault((ref.kind, ref.id), ref)
    if len(unique) > MAX_CONTEXT_REFS:
        raise InvalidFieldError(
            "context_refs", f"At most {MAX_CONTEXT_REFS} context records.", "too_many"
        )
    session.execute(sql_delete(MissionContextRef).where(MissionContextRef.mission_id == mission.id))
    session.flush()
    stored: list[ContextRefInput] = []
    for (kind, record_id), ref in unique.items():
        if kind == KIND_COMPANY:
            if session.get(Company, record_id) is None:
                raise NotFoundError("Unknown company.")
            session.add(
                MissionContextRef(
                    mission_id=mission.id, company_id=record_id, note=_clean_note(ref.note)
                )
            )
        else:
            if session.get(Prospect, record_id) is None:
                raise NotFoundError("Unknown prospect.")
            session.add(
                MissionContextRef(
                    mission_id=mission.id, prospect_id=record_id, note=_clean_note(ref.note)
                )
            )
        stored.append(ref)
    session.flush()
    return stored


def current_inputs(session: Session, mission_id: uuid.UUID) -> list[ContextRefInput]:
    return [
        ContextRefInput(
            kind=KIND_COMPANY if ref.company_id is not None else KIND_PROSPECT,
            id=ref.company_id or ref.prospect_id,  # type: ignore[arg-type]
            note=ref.note,
        )
        for ref in session.scalars(
            select(MissionContextRef)
            .where(MissionContextRef.mission_id == mission_id)
            .order_by(MissionContextRef.created_at, MissionContextRef.id)
        )
    ]


def add_ref(session: Session, mission: Mission, ref: ContextRefInput) -> None:
    """Link one more record (idempotent: a record already linked keeps its place)."""
    current = current_inputs(session, mission.id)
    if any((item.kind, item.id) == (ref.kind, ref.id) for item in current):
        return
    set_refs(session, mission, [*current, ref])


def remove_ref(session: Session, mission: Mission, kind: str, record_id: uuid.UUID) -> bool:
    """Unlink a record; False when it was not linked."""
    _check_kind(kind)
    current = current_inputs(session, mission.id)
    kept = [item for item in current if (item.kind, item.id) != (kind, record_id)]
    if len(kept) == len(current):
        return False
    set_refs(session, mission, kept)
    return True


# --- runtime resolution -------------------------------------------------------------------------


def _company_fields(session: Session, company: Company) -> dict[str, Any]:
    segment = (
        session.get(CommercialSegment, company.commercial_segment_id)
        if company.commercial_segment_id
        else None
    )
    sites = session.scalars(
        select(Establishment)
        .where(Establishment.company_id == company.id)
        .order_by(Establishment.is_primary.desc(), Establishment.created_at)
        .limit(MAX_SITES)
    ).all()
    return {
        "legal_name": _clip(company.legal_name),
        "siren": company.siren,
        "website_url": _clip(company.website_url),
        "email_domain": company.email_domain,
        "size_label": _clip(company.size_label),
        "commercial_segment": segment.label if segment is not None else None,
        "activity_categories": [category.label for category in company.activity_categories],
        "sites": [
            {"name": _clip(site.name), "city": _clip(site.city), "postal_code": site.postal_code}
            for site in sites
        ],
    }


def _prospect_fields(session: Session, prospect: Prospect) -> dict[str, Any]:
    role = session.get(Role, prospect.role_id) if prospect.role_id else None
    company = session.get(Company, prospect.company_id) if prospect.company_id else None
    return {
        "exact_job_title": _clip(prospect.exact_job_title),
        "role": role.label if role is not None else None,
        "activity_status": prospect.activity_status.value,
        "company": company.display_name if company is not None else None,
    }


def resolve(session: Session, mission_id: uuid.UUID) -> list[dict[str, Any]]:
    """The mission's context as the agent receives it: current, allowlisted, bounded, read-only.

    `[{"kind", "id", "label", "note", "read_only": true, "fields": {...}}]`. A record deleted
    since the link is simply absent (the reference cascaded away). Targets are not included: they
    reach the agent through the task's subject, not through context.
    """
    refs = session.scalars(
        select(MissionContextRef)
        .where(MissionContextRef.mission_id == mission_id)
        .order_by(MissionContextRef.created_at, MissionContextRef.id)
        .limit(MAX_CONTEXT_REFS)
    ).all()
    resolved: list[dict[str, Any]] = []
    for ref in refs:
        company = session.get(Company, ref.company_id) if ref.company_id is not None else None
        prospect = session.get(Prospect, ref.prospect_id) if ref.prospect_id is not None else None
        if company is not None:
            resolved.append(
                {
                    "kind": KIND_COMPANY,
                    "id": str(company.id),
                    "label": company.display_name,
                    "note": ref.note,
                    "read_only": True,
                    "fields": _company_fields(session, company),
                }
            )
        elif prospect is not None:
            resolved.append(
                {
                    "kind": KIND_PROSPECT,
                    "id": str(prospect.id),
                    "label": _person_name(prospect),
                    "note": ref.note,
                    "read_only": True,
                    "fields": _prospect_fields(session, prospect),
                }
            )
    return resolved
