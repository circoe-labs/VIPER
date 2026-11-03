"""What an agent receives for a task, and what it may return.

`build_payload` is read-only: it snapshots the subject **at claim time**, never at creation, so an
agent never works on stale data. `build_proposal` turns a submitted result into field changes with
before/after — the only shape the review card reads — and collects what could not be normalised
instead of failing the whole submission, so one bad SIREN does not hide three good e-mails.

Both are driven by a per-type Pydantic model: the JSON Schema published to the agent
(`model_json_schema`) and the validator that checks its answer are the same object, so they cannot
drift. Contract: `doc/architecture/agent-missions.md` §5-§7.
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.agent_missions import AgentTask, AgentThread
from app.models.companies import Company, Establishment
from app.models.enums import (
    ActivityStatus,
    AgentTaskType,
    Civility,
    NoteSourceType,
    PhoneType,
    SignalKind,
)
from app.models.missions import Mission, MissionRun
from app.models.prospects import Prospect, ProspectNote
from app.models.taxonomies import ActivityCategory, CommercialSegment, Role
from app.repositories.taxonomies import TaxonomyRow, find_by_label
from app.services.companies import (
    CompanyDetail,
    get_company,
    normalize_email_domain,
    normalize_siren,
    normalize_siret,
    normalize_website,
)
from app.services.contact_channels import normalize_email_address, normalize_phone_number
from app.services.errors import InvalidFieldError
from app.services.imports.matching import company_key

# Bumped when a result shape changes (`agent-missions.md` §6.3). 2: `find_prospects` companies may
# carry `establishments` and a `trigger` (ChatGPT handoff, Slice 04; both optional, so a result in
# the version-1 shape stays valid).
SCHEMA_VERSION = 2

# --- `update_company` ---------------------------------------------------------------------------


class Evidence(BaseModel):
    """Where a proposed value comes from: an agent cites, or it says nothing."""

    model_config = ConfigDict(extra="forbid")

    field: str = Field(min_length=1, max_length=100)
    source: str = Field(min_length=1, max_length=1000)
    quote: str | None = Field(None, max_length=1000)


class CompanyUpdateResult(BaseModel):
    """`update_company`: public, verifiable fields only.

    The Circoe-internal columns (`project_done_with_circoe`, `project_type`, `circoe_references`,
    `client_approach`) are deliberately absent: an agent has no way to know them, and a plausible
    guess there would be worse than a blank.
    """

    model_config = ConfigDict(extra="forbid")

    legal_name: str | None = Field(None, max_length=300)
    siren: str | None = Field(None, max_length=20)
    website_url: str | None = Field(None, max_length=1000)
    email_domain: str | None = Field(None, max_length=255)
    size_label: str | None = Field(None, max_length=100)
    # A label, resolved by VIPER against the taxonomy (never an id the agent cannot know).
    commercial_segment: str | None = Field(None, max_length=200)
    activity_categories: list[str] = Field(default_factory=list, max_length=20)
    confidence: int = Field(ge=0, le=100)
    evidence: list[Evidence] = Field(default_factory=list, max_length=50)
    notes: str | None = Field(None, max_length=2000)


# The fillable columns, in the order the review card shows them, with their French label.
COMPANY_FIELDS: tuple[tuple[str, str], ...] = (
    ("legal_name", "Raison sociale"),
    ("siren", "SIREN"),
    ("website_url", "Site web"),
    ("email_domain", "Domaine e-mail"),
    ("size_label", "Effectif"),
    ("commercial_segment", "Segment"),
    ("activity_categories", "Catégories d’activité"),
)
COMPANY_TEXT_MAX = {
    "legal_name": 300,
    "size_label": 100,
}

# --- `update_employee` --------------------------------------------------------------------------


class PhoneUpdate(BaseModel):
    """A phone number to add, with its type; VIPER normalises the digits before storing them."""

    model_config = ConfigDict(extra="forbid")

    number: str = Field(min_length=1, max_length=40)
    type: PhoneType = PhoneType.OTHER


class EmployeeUpdateResult(BaseModel):
    """`update_employee`: the person's public professional record.

    The commercial state, the durable opposition and the verification date stay out: a person
    chooses them (D7), and an agent proposing them would only produce a refused field.
    """

    model_config = ConfigDict(extra="forbid")

    civility: Civility | None = None
    first_name: str | None = Field(None, max_length=100)
    last_name: str | None = Field(None, max_length=100)
    exact_job_title: str | None = Field(None, max_length=255)
    # A label, resolved by VIPER against the roles taxonomy (never an id the agent cannot know).
    role: str | None = Field(None, max_length=200)
    emails: list[str] = Field(default_factory=list, max_length=20)
    phones: list[PhoneUpdate] = Field(default_factory=list, max_length=20)
    activity_status: ActivityStatus | None = None
    confidence: int = Field(ge=0, le=100)
    evidence: list[Evidence] = Field(default_factory=list, max_length=50)
    notes: str | None = Field(None, max_length=2000)


# --- `find_employees` ---------------------------------------------------------------------------


class PersonProposal(BaseModel):
    """One person the agent found at the company, with the source it read them from."""

    model_config = ConfigDict(extra="forbid")

    civility: Civility | None = None
    first_name: str = Field(min_length=1, max_length=100)
    last_name: str = Field(min_length=1, max_length=100)
    exact_job_title: str | None = Field(None, max_length=255)
    role: str | None = Field(None, max_length=200)
    email: str | None = Field(None, max_length=320)
    phone: str | None = Field(None, max_length=40)
    activity_status: ActivityStatus | None = None
    confidence: int = Field(ge=0, le=100)
    # Where every value comes from; at least one source per person (an agent cites or says nothing).
    evidence: list[Evidence] = Field(default_factory=list, max_length=50)


class FindEmployeesResult(BaseModel):
    """`find_employees`: the people of one company who are not in the base yet."""

    model_config = ConfigDict(extra="forbid")

    people: list[PersonProposal] = Field(default_factory=list, max_length=20)
    summary: str | None = Field(None, max_length=2000)
    confidence: int = Field(ge=0, le=100)
    notes: str | None = Field(None, max_length=2000)


# --- signals (`surveil_signals`, and the discovery trigger of `find_prospects`) ---------------


class SignalSubject(BaseModel):
    """Who the signal is about: the company itself, or one of its people (by name)."""

    model_config = ConfigDict(extra="forbid")

    type: Literal["company", "person"] = "company"
    name: str | None = Field(None, max_length=200)


class SignalProposal(BaseModel):
    """One dated, sourced fact with its commercial reading."""

    model_config = ConfigDict(extra="forbid")

    subject: SignalSubject = Field(default_factory=SignalSubject)
    kind: SignalKind
    signal: str = Field(min_length=1, max_length=1000)
    score: int = Field(ge=-50, le=50)
    score_reason: str = Field(min_length=1, max_length=1000)
    source: str = Field(min_length=1, max_length=2000)
    source_channel: NoteSourceType | None = None
    observed_on: date
    relevance: int = Field(ge=0, le=100)
    sentiment: Literal["positive", "neutral", "negative"] | None = None


# --- `find_prospects` ---------------------------------------------------------------------------


class EstablishmentProposal(BaseModel):
    """One site of a discovered company (« Plateforme de Honfleur », an `entrepôt`).

    Mirrors `companies.EstablishmentInput` for what becomes the row; `opened_on`, `surface_m2` and
    `source` are the facts that made the site worth proposing: they stay on the reviewed result
    (`proposal` and `applied`), the `establishments` table has no column for them yet.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(None, max_length=255)
    kind: str | None = Field(
        None, max_length=100, description="Free text: siège, agence, entrepôt, usine…"
    )
    siret: str | None = Field(None, max_length=20)
    address_line1: str | None = Field(None, max_length=255)
    postal_code: str | None = Field(None, max_length=16)
    city: str | None = Field(None, max_length=255)
    country: str | None = Field(None, max_length=100)
    opened_on: date | None = None
    surface_m2: int | None = Field(None, ge=1, le=10_000_000)
    source: str | None = Field(None, max_length=2000, description="Public http(s) URL.")


class CompanyProposal(BaseModel):
    """One company the agent found for a discovery mission, with its public source.

    `establishments` and `trigger` are optional (results submitted before them stay valid): the
    sites the brief is about, and the dated event that brought the company in — the same shape as
    a `surveil_signals` signal, always about the company itself.
    """

    model_config = ConfigDict(extra="forbid")

    display_name: str = Field(min_length=1, max_length=200)
    legal_name: str | None = Field(None, max_length=300)
    siren: str | None = Field(None, max_length=20)
    website_url: str | None = Field(None, max_length=1000)
    email_domain: str | None = Field(None, max_length=255)
    size_label: str | None = Field(None, max_length=100)
    commercial_segment: str | None = Field(None, max_length=200)
    activity_categories: list[str] = Field(default_factory=list, max_length=20)
    confidence: int = Field(ge=0, le=100)
    evidence: list[Evidence] = Field(default_factory=list, max_length=50)
    notes: str | None = Field(None, max_length=2000)
    establishments: list[EstablishmentProposal] = Field(
        default_factory=list,
        max_length=20,
        description="The sites the brief is about (a new warehouse, a plant under construction).",
    )
    trigger: SignalProposal | None = Field(
        None,
        description=(
            "The dated, sourced event that makes this company a prospect now (facility_opening, "
            "facility_expansion, construction, relocation…). Always about the company itself."
        ),
    )


class FindProspectsResult(BaseModel):
    """`find_prospects`: companies matching the mission's brief, none of them in the base yet."""

    model_config = ConfigDict(extra="forbid")

    companies: list[CompanyProposal] = Field(default_factory=list, max_length=50)
    summary: str | None = Field(None, max_length=2000)
    confidence: int = Field(ge=0, le=100)
    notes: str | None = Field(None, max_length=2000)


# --- `surveil_signals` --------------------------------------------------------------------------


class SurveilSignalsResult(BaseModel):
    """`surveil_signals`: what changed at the company, and why it matters commercially."""

    model_config = ConfigDict(extra="forbid")

    signals: list[SignalProposal] = Field(default_factory=list, max_length=50)
    company_summary: str | None = Field(None, max_length=2000)
    recommended_action: str | None = Field(None, max_length=2000)
    evidence_gaps: list[str] = Field(default_factory=list, max_length=20)
    notes: str | None = Field(None, max_length=2000)
    confidence: int = Field(ge=0, le=100)


# The fields the review card shows as one item each, with their French label.
EMPLOYEE_FIELDS: tuple[tuple[str, str], ...] = (
    ("civility", "Civilité"),
    ("first_name", "Prénom"),
    ("last_name", "Nom"),
    ("exact_job_title", "Fonction"),
    ("role", "Rôle"),
    ("activity_status", "Statut d’activité"),
)


TASK_LABELS: dict[AgentTaskType, str] = {
    AgentTaskType.UPDATE_COMPANY: "Mettre à jour la société",
    AgentTaskType.UPDATE_EMPLOYEE: "Compléter un employé",
    AgentTaskType.FIND_EMPLOYEES: "Trouver de nouveaux contacts",
    AgentTaskType.SURVEIL_SIGNALS: "Surveiller les signaux",
    AgentTaskType.FIND_PROSPECTS: "Trouver de nouveaux prospects",
}

INSTRUCTIONS: dict[AgentTaskType, str] = {
    AgentTaskType.UPDATE_COMPANY: (
        "Complete this company's missing public information. Cite a public source for every "
        "value; omit a field you cannot source rather than guessing."
    ),
    AgentTaskType.UPDATE_EMPLOYEE: (
        "Complete this person's missing professional information. Cite a public source for every "
        "value; never invent an e-mail address."
    ),
    AgentTaskType.FIND_EMPLOYEES: (
        "Find people who work at this company and are not in the base yet."
    ),
    AgentTaskType.SURVEIL_SIGNALS: (
        "Find dated, sourced signals about this company and its people, and say why each one "
        "matters for a commercial approach."
    ),
    AgentTaskType.FIND_PROSPECTS: (
        "Find companies matching this brief that are not in the base yet. Cite a public source for "
        "each one. When the brief is about sites (a warehouse opened, a plant built or extended, "
        "a move), list those sites under `establishments` (name, kind, SIRET, address, city, "
        "opened_on, surface_m2, source) and give the dated event as `trigger`, with the kind "
        "that names it (facility_opening, facility_expansion, construction, relocation) and why "
        "it matters commercially."
    ),
}

RESULT_MODELS: dict[AgentTaskType, type[BaseModel]] = {
    AgentTaskType.UPDATE_COMPANY: CompanyUpdateResult,
    # Tool mode only for now: a person may post a person update without claiming a mission, but
    # `open_company_review` keeps queuing only the company type (its payload builder is the P1
    # contract), so `supports` stays narrower than `RESULT_MODELS`.
    AgentTaskType.UPDATE_EMPLOYEE: EmployeeUpdateResult,
    AgentTaskType.FIND_EMPLOYEES: FindEmployeesResult,
    AgentTaskType.FIND_PROSPECTS: FindProspectsResult,
    AgentTaskType.SURVEIL_SIGNALS: SurveilSignalsResult,
}

# The types whose claim payload VIPER can build today (a mission may queue them).
MISSION_TYPES = frozenset(
    {
        AgentTaskType.UPDATE_COMPANY,
        AgentTaskType.UPDATE_EMPLOYEE,
        AgentTaskType.FIND_EMPLOYEES,
        AgentTaskType.FIND_PROSPECTS,
        AgentTaskType.SURVEIL_SIGNALS,
    }
)
# The legacy « Analyse » thread only queues the company type; its employee flow is the missions'.
LEGACY_REVIEW_TYPES = frozenset({AgentTaskType.UPDATE_COMPANY})


def _json_safe(value: Any) -> Any:
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    return value


def supports(task_type: AgentTaskType) -> bool:
    """Whether this type can be claimed today (its claim payload must exist)."""
    return task_type in MISSION_TYPES


def queueable(task_type: AgentTaskType) -> bool:
    """Whether the legacy company-review thread may create this task type."""
    return task_type in LEGACY_REVIEW_TYPES


def result_model(task_type: AgentTaskType) -> type[BaseModel]:
    model = RESULT_MODELS.get(task_type)
    if model is None:
        raise InvalidFieldError("task", "This task type has no result schema yet.", "unsupported")
    return model


# --- payload ------------------------------------------------------------------------------------


def _iso(moment: datetime | None) -> str | None:
    return moment.isoformat() if moment else None


def _company_payload_data(company: CompanyDetail) -> dict[str, Any]:
    primary = next((site for site in company.establishments if site.is_primary), None)
    return {
        "id": str(company.id),
        "display_name": company.display_name,
        "legal_name": company.legal_name,
        "siren": company.siren,
        "website_url": company.website_url,
        "email_domain": company.email_domain,
        "size_label": company.size_label,
        "commercial_segment": (
            company.commercial_segment.label if company.commercial_segment else None
        ),
        "activity_categories": [value.label for value in company.activity_categories],
        "address": (
            {"city": primary.city, "country": primary.country} if primary is not None else None
        ),
    }


def _missing_company_fields(company: CompanyDetail) -> list[str]:
    missing = []
    for field, _ in COMPANY_FIELDS:
        current = getattr(company, field)
        if field == "commercial_segment":
            current = company.commercial_segment
        if field == "activity_categories":
            current = company.activity_categories
        if current in (None, "", []):
            missing.append(field)
    return missing


def _sources(company: CompanyDetail) -> list[dict[str, str]]:
    """URLs VIPER already knows. It does not browse: the agent does, with `search_hints`."""
    sources = []
    if company.website_url:
        sources.append({"kind": "website", "url": company.website_url})
    if company.email_domain:
        sources.append({"kind": "email_domain", "url": f"https://{company.email_domain}"})
    return sources


def _search_hints(company: CompanyDetail) -> list[str]:
    name = company.display_name
    city = next((site.city for site in company.establishments if site.is_primary), None)
    where = f" {city}" if city else ""
    return [
        f'"{name}"{where}',
        f'"{name}" société SIREN{where}',
        f"site:linkedin.com/company {name}",
        f'"{name}" recrutement OR levée OR actualité',
    ]


def _employee_payload_data(session: Session, prospect: Prospect) -> dict[str, Any]:
    role = session.get(Role, prospect.role_id) if prospect.role_id else None
    return {
        "prospect_id": str(prospect.id),
        "civility": prospect.civility.value if prospect.civility else None,
        "first_name": prospect.first_name,
        "last_name": prospect.last_name,
        "exact_job_title": prospect.exact_job_title,
        "role": role.label if role is not None else None,
        "emails": [
            {"address": email.address, "is_primary": email.is_primary}
            for email in prospect.emails
            if email.is_active
        ],
        "phones": [
            {"number": phone.number, "type": phone.type.value, "is_primary": phone.is_primary}
            for phone in prospect.phones
            if phone.is_active
        ],
        "activity_status": prospect.activity_status.value,
        "employment_verified_at": _iso(prospect.employment_verified_at),
        "do_not_contact": prospect.contactability_status.value == "do_not_contact",
    }


def _missing_employee_fields(prospect: Prospect) -> list[str]:
    missing = []
    if not any(email.is_active for email in prospect.emails):
        missing.append("emails")
    if not any(phone.is_active for phone in prospect.phones):
        missing.append("phones")
    if prospect.role_id is None:
        missing.append("role")
    if prospect.exact_job_title is None:
        missing.append("exact_job_title")
    if prospect.employment_verified_at is None:
        missing.append("employment_verified_at")
    return missing


def _company_prospect_ids(session: Session, company_id: uuid.UUID) -> list[uuid.UUID]:
    return list(session.scalars(select(Prospect.id).where(Prospect.company_id == company_id)))


def _known_signals(session: Session, company_id: uuid.UUID) -> list[dict[str, Any]]:
    """Signals already stored for the company or its people — the agent must not repeat them."""
    prospect_ids = _company_prospect_ids(session, company_id)
    rows = session.scalars(
        select(ProspectNote).where(
            ProspectNote.source_url.is_not(None),
            (ProspectNote.company_id == company_id) | (ProspectNote.prospect_id.in_(prospect_ids)),
        )
    ).all()
    return [
        {
            "source": row.source_url,
            "kind": row.kind.value if row.kind is not None else None,
            "signal": row.fact_text,
            "valid_until": row.valid_until.isoformat() if row.valid_until else None,
        }
        for row in rows
    ]


def _existing_people(session: Session, company_id: uuid.UUID) -> list[dict[str, Any]]:
    """The people already in the base at this company, with their role and primary e-mail."""
    prospects = session.scalars(
        select(Prospect)
        .where(Prospect.company_id == company_id)
        .order_by(Prospect.last_name, Prospect.first_name)
    ).all()
    role_ids = {prospect.role_id for prospect in prospects if prospect.role_id is not None}
    roles = {
        role.id: role.label for role in session.scalars(select(Role).where(Role.id.in_(role_ids)))
    }
    people = []
    for prospect in prospects:
        primary = next(
            (email.address for email in prospect.emails if email.is_primary and email.is_active),
            None,
        )
        people.append(
            {
                "name": " ".join(
                    part for part in (prospect.first_name, prospect.last_name) if part
                ),
                "role": roles.get(prospect.role_id) if prospect.role_id else None,
                "email": primary,
            }
        )
    return people


def mission_rule(mission: Mission) -> dict[str, Any]:
    """The rule a run works under: the payload's `mission` block. Kept on each run when it starts
    (`MissionRun.config`), so « Modifier la mission » only changes the next runs."""
    return {
        "id": str(mission.id),
        "name": mission.name,
        "type": mission.type.value,
        "prompt": mission.prompt,
        "result_kind": mission.result_kind.value,
        "result_limit": mission.result_limit,
        "geography": mission.geography,
        "period_days": mission.period_days,
        "exclusions": mission.exclusions,
    }


def _task_mission(
    session: Session, task: AgentTask
) -> tuple[Mission | None, dict[str, Any] | None]:
    """`(mission, rule)` of a mission task: the rule kept by its run, or the live one for a run
    made before migration 0027; `(None, None)` for a tool-mode task or a deleted mission."""
    run = session.get(MissionRun, task.run_id) if task.run_id else None
    mission = session.get(Mission, run.mission_id) if run is not None else None
    if run is None or mission is None:
        return None, None
    return mission, run.config if run.config is not None else mission_rule(mission)


def build_payload(
    session: Session,
    task: AgentTask,
    *,
    lease_expires_at: datetime,
    now: datetime | None = None,
) -> dict[str, Any]:
    """The JSON an agent receives when it claims `task`. Read-only."""
    thread = session.get(AgentThread, task.thread_id) if task.thread_id else None
    _, rule = _task_mission(session, task)
    moment = now or datetime.now(UTC)
    model = result_model(task.type)
    payload: dict[str, Any] = {
        "task_id": str(task.id),
        "task": task.type.value,
        "task_label": TASK_LABELS[task.type],
        "instruction": INSTRUCTIONS[task.type],
        "thread": ({"id": str(thread.id), "title": thread.title} if thread is not None else None),
        "mission": rule,
        "subject": {},
        "user_data": None,
        "company_data": None,
        "missing_fields": [],
        "sources": [],
        "search_hints": [],
        "known_values": {},
        "known_signals": [],
        "output_schema": model.model_json_schema(),
        "output_schema_version": SCHEMA_VERSION,
        "constraints": {
            "no_guessing": True,
            "quote_evidence": True,
            "language": "fr",
        },
        "lease": {
            "expires_at": _iso(lease_expires_at),
            "heartbeat_every_seconds": 300,
        },
        "context": {"today": moment.date().isoformat(), "locale": "fr-FR"},
    }
    match task.type:
        case AgentTaskType.UPDATE_COMPANY:
            if task.company_id is None:
                raise InvalidFieldError("task", "This task has no company.", "missing_subject")
            company = get_company(session, task.company_id)
            payload["subject"] = {"company_id": str(company.id)}
            payload["company_data"] = _company_payload_data(company)
            payload["missing_fields"] = _missing_company_fields(company)
            payload["sources"] = _sources(company)
            payload["search_hints"] = _search_hints(company)
        case AgentTaskType.UPDATE_EMPLOYEE:
            if task.prospect_id is None or task.company_id is None:
                raise InvalidFieldError("task", "This task has no prospect.", "missing_subject")
            prospect = session.get(Prospect, task.prospect_id)
            if prospect is None:
                raise InvalidFieldError("task", "This task has no prospect.", "missing_subject")
            company = get_company(session, task.company_id)
            payload["subject"] = {
                "prospect_id": str(prospect.id),
                "company_id": str(company.id),
            }
            payload["user_data"] = _employee_payload_data(session, prospect)
            payload["company_data"] = _company_payload_data(company)
            payload["missing_fields"] = _missing_employee_fields(prospect)
            payload["sources"] = _sources(company)
            name = " ".join(part for part in (prospect.first_name, prospect.last_name) if part)
            payload["search_hints"] = [
                f'"{name}" {company.display_name}',
                f'site:linkedin.com/in "{name}" {company.display_name}',
                f'"{name}" {company.display_name} email',
            ]
        case AgentTaskType.FIND_EMPLOYEES:
            if task.company_id is None:
                raise InvalidFieldError("task", "This task has no company.", "missing_subject")
            company = get_company(session, task.company_id)
            payload["subject"] = {"company_id": str(company.id)}
            payload["company_data"] = _company_payload_data(company)
            payload["missing_fields"] = ["people"]
            payload["known_values"] = {"people": _existing_people(session, company.id)}
            payload["sources"] = _sources(company)
            payload["search_hints"] = [
                f'"{company.display_name}" responsable',
                f'site:linkedin.com/company "{company.display_name}"',
                f'"{company.display_name}" organigramme',
            ]
        case AgentTaskType.FIND_PROSPECTS:
            # Discovery: the brief lives in the mission block; there is no subject record.
            payload["missing_fields"] = ["companies"]
            if rule is not None:
                payload["constraints"]["max_items"] = rule["result_limit"]
                payload["search_hints"] = [
                    rule["prompt"],
                    (
                        f"entreprises {rule['geography']}"
                        if rule["geography"]
                        else "annuaire des entreprises"
                    ),
                ]
        case AgentTaskType.SURVEIL_SIGNALS:
            if task.company_id is None:
                raise InvalidFieldError("task", "This task has no company.", "missing_subject")
            company = get_company(session, task.company_id)
            payload["subject"] = {"company_id": str(company.id)}
            payload["company_data"] = _company_payload_data(company)
            payload["known_signals"] = _known_signals(session, company.id)
            payload["sources"] = _sources(company)
            payload["search_hints"] = [
                f'"{company.display_name}" recrutement',
                f'"{company.display_name}" levée de fonds',
                f'"{company.display_name}" actualité',
                f'site:linkedin.com/company "{company.display_name}"',
            ]
            if rule is not None:
                payload["constraints"]["max_items"] = rule["result_limit"]
        case _:
            raise InvalidFieldError("task", "This task type has no payload yet.", "unsupported")
    return payload


# --- proposal -----------------------------------------------------------------------------------


def _clean_text(field: str, value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise InvalidFieldError(field, "Empty value.", "empty")
    limit = COMPANY_TEXT_MAX.get(field, 1000)
    if len(cleaned) > limit:
        raise InvalidFieldError(field, f"At most {limit} characters.", "too_long")
    return cleaned


def _evidence_for(
    result: CompanyUpdateResult | EmployeeUpdateResult, field: str
) -> tuple[str | None, str | None]:
    for evidence in result.evidence:
        if evidence.field == field:
            return evidence.source, evidence.quote
    return None, None


def _segment(session: Session, label: str) -> TaxonomyRow:
    segment = find_by_label(session, CommercialSegment, label)
    if segment is None:
        raise InvalidFieldError("commercial_segment", "Unknown commercial segment.", "unknown")
    return segment


def _categories(session: Session, labels: list[str]) -> list[TaxonomyRow]:
    found = []
    for label in dict.fromkeys(labels):
        category = find_by_label(session, ActivityCategory, label)
        if category is None:
            raise InvalidFieldError("activity_categories", "Unknown activity category.", "unknown")
        found.append(category)
    return found


def _clean_company_field(
    session: Session, field: str, value: Any, current: CompanyDetail
) -> tuple[Any, Any]:
    """`(stored value, displayed value)` normalised like the import and the editor do."""
    match field:
        case "siren":
            siren = normalize_siren(value, current=current.siren)
            return siren, siren
        case "website_url":
            url = normalize_website(value)
            return url, url
        case "email_domain":
            domain = normalize_email_domain(value)
            return domain, domain
        case "commercial_segment":
            segment = _segment(session, str(value))
            return segment.id, segment.label
        case "activity_categories":
            categories = _categories(session, [str(item) for item in value])
            return [row.id for row in categories], [row.label for row in categories]
        case _:
            cleaned = _clean_text(field, str(value))
            return cleaned, cleaned


def _current_company_value(company: CompanyDetail, field: str) -> tuple[Any, Any]:
    """`(stored value, displayed value)` of a field on the company as it is now."""
    match field:
        case "commercial_segment":
            segment = company.commercial_segment
            return (segment.id if segment else None, segment.label if segment else None)
        case "activity_categories":
            return (
                [category.id for category in company.activity_categories],
                [category.label for category in company.activity_categories],
            )
        case _:
            value = getattr(company, field)
            return value, value


def _company_proposal(
    session: Session, task: AgentTask, raw: dict[str, Any], company_id: uuid.UUID
) -> dict[str, Any]:
    result = CompanyUpdateResult.model_validate(raw)
    company = get_company(session, company_id)
    items: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    for field, label in COMPANY_FIELDS:
        value = getattr(result, field)
        if value is None or value == []:
            continue
        try:
            stored, shown = _clean_company_field(session, field, value, company)
        except InvalidFieldError as error:
            refused.append(
                {
                    "field": field,
                    "label": label,
                    "reason": error.reason or "invalid",
                    "message": str(error),
                }
            )
            continue
        before_stored, before_shown = _current_company_value(company, field)
        if field == "activity_categories":
            # The agent adds what is missing; accepting never removes a category a person set.
            added = [row for row in stored if row not in before_stored]
            if not added:
                continue
            stored = [*before_stored, *added]
            shown = [*before_shown, *(row for row in shown if row not in before_shown)]
            status = "add"
        else:
            if stored == before_stored:
                continue
            status = "add" if before_stored in (None, "") else "change"
        source, quote = _evidence_for(result, field)
        items.append(
            {
                "key": field,
                "field": field,
                "label": label,
                "before": before_shown,
                "after": shown,
                "status": status,
                # What acceptance writes, already normalised (a taxonomy id, not its label).
                "store": _json_safe(stored),
                "source": source,
                "quote": quote,
            }
        )
    stale = bool(task.claimed_at and company.updated_at > task.claimed_at)
    return {
        "kind": "company_update",
        "items": items,
        "refused": refused,
        "stale": stale,
        "confidence": result.confidence,
        "notes": result.notes,
    }


CIVILITY_LABELS: dict[Civility, str] = {Civility.MR: "M.", Civility.MS: "Mme"}
ACTIVITY_LABELS: dict[ActivityStatus, str] = {
    ActivityStatus.ACTIVE: "En poste",
    ActivityStatus.INACTIVE: "Parti",
    ActivityStatus.UNKNOWN: "Inconnu",
}


def _employee_refusal(field: str, label: str, error: InvalidFieldError) -> dict[str, Any]:
    return {
        "field": field,
        "label": label,
        "reason": error.reason or "invalid",
        "message": str(error),
    }


def _employee_proposal(
    session: Session, task: AgentTask, raw: dict[str, Any], prospect_id: uuid.UUID
) -> dict[str, Any]:
    result = EmployeeUpdateResult.model_validate(raw)
    prospect = session.get(Prospect, prospect_id)
    if prospect is None:
        raise InvalidFieldError("task", "This task has no prospect.", "missing_subject")
    current_role = session.get(Role, prospect.role_id) if prospect.role_id else None
    items: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    for field, label in EMPLOYEE_FIELDS:
        value = getattr(result, field)
        if value is None:
            continue
        stored: Any
        shown: Any
        before_stored: Any
        before_shown: Any
        try:
            match field:
                case "civility":
                    stored = value
                    shown = CIVILITY_LABELS.get(value, value.value)
                    before_stored = prospect.civility
                    before_shown = (
                        CIVILITY_LABELS.get(prospect.civility, prospect.civility.value)
                        if prospect.civility
                        else None
                    )
                case "activity_status":
                    stored = value
                    shown = ACTIVITY_LABELS.get(value, value.value)
                    before_stored = prospect.activity_status
                    before_shown = ACTIVITY_LABELS.get(
                        prospect.activity_status, prospect.activity_status.value
                    )
                case "role":
                    role = find_by_label(session, Role, str(value))
                    if role is None:
                        raise InvalidFieldError("role", "Unknown role.", "unknown")
                    stored = role.id
                    shown = role.label
                    before_stored = prospect.role_id
                    before_shown = current_role.label if current_role else None
                case _:
                    stored = _clean_text(field, str(value))
                    shown = stored
                    before_stored = getattr(prospect, field)
                    before_shown = before_stored
        except InvalidFieldError as error:
            refused.append(_employee_refusal(field, label, error))
            continue
        if stored == before_stored:
            continue
        source, quote = _evidence_for(result, field)
        items.append(
            {
                "key": field,
                "field": field,
                "label": label,
                "before": before_shown,
                "after": shown,
                "status": "add" if before_stored in (None, "") else "change",
                "store": _json_safe(stored),
                "source": source,
                "quote": quote,
            }
        )

    known_emails = {email.address.casefold() for email in prospect.emails}
    for value in dict.fromkeys(result.emails):
        try:
            address = normalize_email_address("emails", value)
        except InvalidFieldError as error:
            refused.append(_employee_refusal("emails", "E-mail", error))
            continue
        if address in known_emails:
            continue
        known_emails.add(address)
        source, quote = _evidence_for(result, "emails")
        items.append(
            {
                "key": f"email:{address}",
                "field": "emails",
                "label": "E-mail",
                "before": None,
                "after": address,
                "status": "add",
                "store": {"address": address},
                "source": source,
                "quote": quote,
            }
        )

    known_phones = {phone.number for phone in prospect.phones}
    for phone in result.phones:
        try:
            number = normalize_phone_number("phones", phone.number)
        except InvalidFieldError as error:
            refused.append(_employee_refusal("phones", "Téléphone", error))
            continue
        if number in known_phones:
            continue
        known_phones.add(number)
        source, quote = _evidence_for(result, "phones")
        items.append(
            {
                "key": f"phone:{number}",
                "field": "phones",
                "label": "Téléphone",
                "before": None,
                "after": number,
                "status": "add",
                "store": {"number": number, "type": phone.type.value},
                "source": source,
                "quote": quote,
            }
        )

    stale = bool(task.claimed_at and prospect.updated_at > task.claimed_at)
    return {
        "kind": "employee_update",
        "items": items,
        "refused": refused,
        "stale": stale,
        "confidence": result.confidence,
        "notes": result.notes,
    }


def _mission_context(session: Session, task: AgentTask) -> str:
    mission, rule = _task_mission(session, task)
    if mission is None or rule is None:
        return "Informations professionnelles publiques."
    return (
        "Recherche d’informations professionnelles publiques pour la mission "
        f"« {rule['name']} », demandée par {mission.created_by_display} "
        "et validée par une personne."
    )


def _person_key(first: str, last: str) -> tuple[str, str]:
    return (first.casefold().strip(), last.casefold().strip())


def _find_employees_proposal(
    session: Session, task: AgentTask, raw: dict[str, Any], company_id: uuid.UUID
) -> dict[str, Any]:
    result = FindEmployeesResult.model_validate(raw)
    company = get_company(session, company_id)
    existing = session.scalars(select(Prospect).where(Prospect.company_id == company_id)).all()
    known_names = {_person_key(row.first_name or "", row.last_name or "") for row in existing}
    known_emails = {email.address.casefold() for row in existing for email in row.emails}
    legal_basis = _mission_context(session, task)
    items: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    for index, person in enumerate(result.people):
        field = f"people.{index}"
        label = f"{person.first_name} {person.last_name}".strip()
        try:
            first = _clean_text("first_name", person.first_name)
            last = _clean_text("last_name", person.last_name)
        except InvalidFieldError as error:
            refused.append(
                {
                    "field": field,
                    "label": label,
                    "reason": error.reason or "invalid",
                    "message": str(error),
                }
            )
            continue
        key = _person_key(first, last)
        if key in known_names:
            refused.append(
                {
                    "field": field,
                    "label": label,
                    "reason": "already_known",
                    "message": "Cette personne est déjà dans la base pour cette société.",
                }
            )
            continue
        email: str | None = None
        if person.email:
            try:
                email = normalize_email_address("email", person.email)
            except InvalidFieldError as error:
                refused.append(
                    {
                        "field": field,
                        "label": label,
                        "reason": error.reason or "invalid",
                        "message": str(error),
                    }
                )
                continue
            if email in known_emails:
                refused.append(
                    {
                        "field": field,
                        "label": label,
                        "reason": "already_known",
                        "message": "Cette adresse est déjà rattachée à un contact.",
                    }
                )
                continue
        phone: str | None = None
        if person.phone:
            try:
                phone = normalize_phone_number("phone", person.phone)
            except InvalidFieldError as error:
                refused.append(
                    {
                        "field": field,
                        "label": label,
                        "reason": error.reason or "invalid",
                        "message": str(error),
                    }
                )
                continue
        sources = [evidence for evidence in person.evidence if evidence.source.strip()]
        if not sources:
            refused.append(
                {
                    "field": field,
                    "label": label,
                    "reason": "source_required",
                    "message": "Aucune source publique : un contact sans preuve n’est pas proposé.",
                }
            )
            continue
        known_names.add(key)
        if email is not None:
            known_emails.add(email)
        title = person.exact_job_title or person.role
        items.append(
            {
                "key": f"person:{index}:{email or first.casefold() + '.' + last.casefold()}",
                "field": field,
                "label": f"{label}{f' — {title}' if title else ''}",
                "before": None,
                "after": "Nouveau contact",
                "status": "add",
                "store": {
                    "civility": person.civility.value if person.civility else None,
                    "first_name": first,
                    "last_name": last,
                    "exact_job_title": person.exact_job_title,
                    "role": person.role,
                    "email": email,
                    "phone": phone,
                    "activity_status": (
                        person.activity_status.value if person.activity_status else None
                    ),
                    "source": sources[0].source,
                    "legal_basis": legal_basis,
                },
                "source": sources[0].source,
                "quote": sources[0].quote,
            }
        )
    stale = bool(task.claimed_at and company.updated_at > task.claimed_at)
    return {
        "kind": "find_employees",
        "items": items,
        "refused": refused,
        "stale": stale,
        "confidence": result.confidence,
        "notes": result.notes or result.summary,
    }


def _optional_text(value: str | None) -> str | None:
    return (value or "").strip() or None


def site_place(city: Any, name: Any) -> tuple[str, str] | None:
    """The (city, name) pair that identifies a site without SIRET; None when either is missing."""
    city_key = " ".join(str(city or "").split()).casefold()
    name_key = " ".join(str(name or "").split()).casefold()
    return (city_key, name_key) if city_key and name_key else None


def _refusal(field: str, label: str, reason: str, message: str) -> dict[str, Any]:
    return {"field": field, "label": label, "reason": reason, "message": message}


def _establishments_store(
    session: Session,
    sites: list[EstablishmentProposal],
    field: str,
    claimed_sirets: set[str],
    refused: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """The cleaned sites of one discovered company, deduplicated by SIRET, then by (city, name).

    A site whose SIRET is already in the base (or already proposed for another company of this
    result) is refused, not recreated; an invalid site is refused alone, never its company.
    """
    wanted: list[str] = []
    for site in sites:
        try:
            siret = normalize_siret("siret", site.siret) if site.siret else None
        except InvalidFieldError:
            # intentional: an invalid SIRET is reported below, in the loop that refuses the site.
            siret = None
        if siret is not None:
            wanted.append(siret)
    in_base = (
        set(session.scalars(select(Establishment.siret).where(Establishment.siret.in_(wanted))))
        if wanted
        else set()
    )
    kept: list[dict[str, Any]] = []
    places: set[tuple[str, str]] = set()
    for index, site in enumerate(sites):
        path = f"{field}.establishments.{index}"
        name = _optional_text(site.name)
        city = _optional_text(site.city)
        label = name or city or site.siret or f"Établissement {index + 1}"
        try:
            siret = normalize_siret(f"{path}.siret", site.siret) if site.siret else None
            source = _signal_url(site.source) if site.source else None
        except InvalidFieldError as error:
            refused.append(_refusal(path, label, error.reason or "invalid", str(error)))
            continue
        place = site_place(city, name)
        if siret is None and place is None:
            refused.append(
                _refusal(
                    path,
                    label,
                    "unidentified",
                    "Un établissement sans SIRET doit avoir un nom et une ville.",
                )
            )
            continue
        if siret is not None and siret in in_base:
            refused.append(
                _refusal(
                    path, label, "already_known", "Cet établissement (SIRET) est déjà dans la base."
                )
            )
            continue
        if (siret is not None and siret in claimed_sirets) or (siret is None and place in places):
            refused.append(
                _refusal(path, label, "duplicate", "Cet établissement est proposé deux fois.")
            )
            continue
        if siret is not None:
            claimed_sirets.add(siret)
        if place is not None:
            places.add(place)
        kept.append(
            {
                "name": name,
                "kind": _optional_text(site.kind),
                "siret": siret,
                "address_line1": _optional_text(site.address_line1),
                "postal_code": _optional_text(site.postal_code),
                "city": city,
                "country": _optional_text(site.country),
                "opened_on": site.opened_on.isoformat() if site.opened_on else None,
                "surface_m2": site.surface_m2,
                "source": source,
            }
        )
    return kept


def _site_owner(
    session: Session, sites: list[EstablishmentProposal], siren_owners: dict[str, uuid.UUID]
) -> uuid.UUID | None:
    """The existing company a proposed site already belongs to: by its SIRET in `establishments`,
    or by its first nine digits (the SIREN) on a company. A company found through one of its
    sites is that company, whatever name or SIREN the agent gave it."""
    sirets: list[str] = []
    for site in sites:
        try:
            siret = normalize_siret("siret", site.siret) if site.siret else None
        except InvalidFieldError:
            # intentional: an invalid SIRET identifies nothing; `_establishments_store` refuses it.
            siret = None
        if siret is not None:
            sirets.append(siret)
    if not sirets:
        return None
    holder = session.scalar(
        select(Establishment.company_id).where(Establishment.siret.in_(sirets)).limit(1)
    )
    if holder is not None:
        return holder
    return next((siren_owners[s[:9]] for s in sirets if s[:9] in siren_owners), None)


def _signal_store(
    signal: SignalProposal, source: str, subject: str, *, unresolved: str | None = None
) -> dict[str, Any]:
    """What an accepted signal row is built from (`agent_review._signal_note`)."""
    valid_until = signal.observed_on + timedelta(days=SIGNAL_VALID_DAYS[signal.kind])
    return {
        "subject": subject,
        "kind": signal.kind.value,
        "signal": signal.signal,
        "score_delta": signal.score,
        "score_reason": signal.score_reason,
        "source_url": source,
        "source_channel": signal.source_channel.value if signal.source_channel else None,
        "observed_on": signal.observed_on.isoformat(),
        "valid_until": valid_until.isoformat(),
        "relevance": signal.relevance,
        "sentiment": signal.sentiment,
        "unresolved_person": unresolved,
    }


def _signal_date_refusal(
    observed_on: date, today: date, period: int | None
) -> tuple[str, str] | None:
    """(reason, message) when a signal's date is outside what a mission accepts."""
    if observed_on > today:
        return "future", "Un signal ne peut pas être daté dans le futur."
    if period is not None and observed_on < today - timedelta(days=period):
        return "too_old", f"Plus ancien que la période recherchée ({period} jours)."
    return None


def _trigger_store(
    trigger: SignalProposal,
    field: str,
    company_name: str,
    period: int | None,
    refused: list[dict[str, Any]],
) -> dict[str, Any] | None:
    """The discovery trigger, checked like a `surveil_signals` signal; refused alone if invalid."""
    path = f"{field}.trigger"
    label = trigger.signal[:80]
    try:
        source = _signal_url(trigger.source)
    except InvalidFieldError as error:
        refused.append(_refusal(path, label, error.reason or "invalid", str(error)))
        return None
    dated = _signal_date_refusal(trigger.observed_on, datetime.now(UTC).date(), period)
    if dated is not None:
        refused.append(_refusal(path, label, *dated))
        return None
    # A brand-new company has no people yet: a person subject stays on the company, flagged.
    unresolved = (
        (trigger.subject.name or "personne sans nom") if trigger.subject.type == "person" else None
    )
    return _signal_store(trigger, source, company_name, unresolved=unresolved)


def _find_prospects_proposal(
    session: Session, task: AgentTask, raw: dict[str, Any]
) -> dict[str, Any]:
    result = FindProspectsResult.model_validate(raw)
    _, rule = _task_mission(session, task)
    limit = rule["result_limit"] if rule is not None else 20
    period = rule["period_days"] if rule is not None else None
    claimed_sirets: set[str] = set()
    legal_basis = _mission_context(session, task)
    known_names: set[str] = set()
    known_sirens: set[str] = set()
    known_domains: set[str] = set()
    siren_owners: dict[str, uuid.UUID] = {}
    for company_id, display_name, siren, domain in session.execute(
        select(Company.id, Company.display_name, Company.siren, Company.email_domain)
    ):
        known_names.add(company_key(display_name))
        if siren:
            known_sirens.add(siren)
            siren_owners[siren] = company_id
        if domain:
            known_domains.add(domain)
    items: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    for index, company in enumerate(result.companies):
        field = f"companies.{index}"
        label = company.display_name.strip()
        if len(items) >= limit:
            refused.append(
                {
                    "field": field,
                    "label": label,
                    "reason": "limit",
                    "message": f"La mission est limitée à {limit} sociétés par exécution.",
                }
            )
            continue
        try:
            name = _clean_text("display_name", company.display_name)
            key = company_key(name)
        except InvalidFieldError as error:
            refused.append(
                {
                    "field": field,
                    "label": label,
                    "reason": error.reason or "invalid",
                    "message": str(error),
                }
            )
            continue
        if key in known_names:
            refused.append(
                {
                    "field": field,
                    "label": label,
                    "reason": "already_known",
                    "message": "Cette société est déjà dans la base.",
                }
            )
            continue
        try:
            siren = normalize_siren(company.siren, current=None) if company.siren else None
            website = normalize_website(company.website_url) if company.website_url else None
            domain = normalize_email_domain(company.email_domain) if company.email_domain else None
            segment = (
                _segment(session, company.commercial_segment)
                if company.commercial_segment
                else None
            )
            categories = _categories(session, company.activity_categories)
        except InvalidFieldError as error:
            refused.append(
                {
                    "field": field,
                    "label": label,
                    "reason": error.reason or "invalid",
                    "message": str(error),
                }
            )
            continue
        if siren is not None and siren in known_sirens:
            refused.append(
                {
                    "field": field,
                    "label": label,
                    "reason": "already_known",
                    "message": "Ce SIREN est déjà rattaché à une société.",
                }
            )
            continue
        if domain is not None and domain in known_domains:
            refused.append(
                {
                    "field": field,
                    "label": label,
                    "reason": "already_known",
                    "message": "Ce domaine e-mail est déjà rattaché à une société.",
                }
            )
            continue
        owner = _site_owner(session, company.establishments, siren_owners)
        if owner is not None:
            refused.append(
                {
                    "field": field,
                    "label": label,
                    "reason": "already_known",
                    "message": (
                        "Un de ses établissements (SIRET) appartient déjà à une société de la base."
                    ),
                    "company_id": str(owner),
                }
            )
            continue
        sources = [evidence for evidence in company.evidence if evidence.source.strip()]
        if not sources:
            refused.append(
                {
                    "field": field,
                    "label": label,
                    "reason": "source_required",
                    "message": (
                        "Aucune source publique : une société sans preuve n’est pas proposée."
                    ),
                }
            )
            continue
        known_names.add(key)
        if siren is not None:
            known_sirens.add(siren)
        if domain is not None:
            known_domains.add(domain)
        sites = _establishments_store(
            session, company.establishments, field, claimed_sirets, refused
        )
        trigger = (
            _trigger_store(company.trigger, field, name, period, refused)
            if company.trigger is not None
            else None
        )
        items.append(
            {
                "key": f"company:{index}:{key}",
                "field": field,
                "label": name,
                "before": None,
                "after": "Nouvelle société",
                "status": "add",
                "store": {
                    "display_name": name,
                    "legal_name": (
                        _clean_text("legal_name", company.legal_name)
                        if company.legal_name
                        else None
                    ),
                    "siren": siren,
                    "website_url": website,
                    "email_domain": domain,
                    "size_label": (
                        _clean_text("size_label", company.size_label)
                        if company.size_label
                        else None
                    ),
                    "commercial_segment_id": str(segment.id) if segment is not None else None,
                    "activity_category_ids": [str(row.id) for row in categories],
                    "source": sources[0].source,
                    "legal_basis": legal_basis,
                    "establishments": sites,
                    "trigger": trigger,
                },
                "source": sources[0].source,
                "quote": sources[0].quote,
            }
        )
    return {
        "kind": "find_prospects",
        "items": items,
        "refused": refused,
        "stale": False,
        "confidence": result.confidence,
        "notes": result.notes or result.summary,
    }


SIGNAL_VALID_DAYS: dict[SignalKind, int] = {
    SignalKind.HIRING: 90,
    SignalKind.FUNDING: 180,
    SignalKind.NEWS: 30,
    SignalKind.SOCIAL_POST: 30,
    SignalKind.EVENT: 30,
    SignalKind.PRODUCT_LAUNCH: 180,
    SignalKind.PARTNERSHIP: 180,
    SignalKind.TECH_CHANGE: 365,
    SignalKind.NEED_EXPRESSED: 90,
    # A site event stays a reason to call for months: the site is fitted out after it opens.
    SignalKind.FACILITY_OPENING: 180,
    SignalKind.FACILITY_EXPANSION: 180,
    SignalKind.CONSTRUCTION: 365,
    SignalKind.RELOCATION: 180,
    SignalKind.OTHER: 90,
}


def _signal_url(value: str) -> str:
    url = value.strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise InvalidFieldError("source", "A public http(s) URL is required.", "format")
    return url


def _signals_proposal(
    session: Session, task: AgentTask, raw: dict[str, Any], company_id: uuid.UUID
) -> dict[str, Any]:
    result = SurveilSignalsResult.model_validate(raw)
    company = get_company(session, company_id)
    _, rule = _task_mission(session, task)
    limit = rule["result_limit"] if rule is not None else 20
    period = rule["period_days"] if rule is not None else None
    people = session.scalars(select(Prospect).where(Prospect.company_id == company_id)).all()
    names: dict[str, uuid.UUID] = {}
    for person in people:
        first = (person.first_name or "").strip().casefold()
        last = (person.last_name or "").strip().casefold()
        if first or last:
            names[f"{first} {last}".strip()] = person.id
            names[f"{last} {first}".strip()] = person.id
    known_sources = {item["source"] for item in _known_signals(session, company_id)}
    today = datetime.now(UTC).date()
    items: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    for index, signal in enumerate(result.signals):
        field = f"signals.{index}"
        if len(items) >= limit:
            refused.append(
                {
                    "field": field,
                    "label": signal.signal[:80],
                    "reason": "limit",
                    "message": f"La mission est limitée à {limit} signaux par exécution.",
                }
            )
            continue
        try:
            source = _signal_url(signal.source)
        except InvalidFieldError as error:
            refused.append(
                {
                    "field": field,
                    "label": signal.signal[:80],
                    "reason": error.reason or "invalid",
                    "message": str(error),
                }
            )
            continue
        if source in known_sources:
            refused.append(
                {
                    "field": field,
                    "label": signal.signal[:80],
                    "reason": "already_known",
                    "message": "Ce signal est déjà enregistré pour cette société.",
                }
            )
            continue
        dated = _signal_date_refusal(signal.observed_on, today, period)
        if dated is not None:
            refused.append(_refusal(field, signal.signal[:80], *dated))
            continue
        prospect_id: uuid.UUID | None = None
        unresolved: str | None = None
        if signal.subject.type == "person":
            wanted = " ".join((signal.subject.name or "").split()).casefold()
            if wanted:
                prospect_id = names.get(wanted)
                if prospect_id is None:
                    unresolved = signal.subject.name
            else:
                unresolved = "personne sans nom"
        subject_name = (
            " ".join(
                part
                for person in people
                if person.id == prospect_id
                for part in (person.first_name, person.last_name)
                if part
            )
            if prospect_id is not None
            else company.display_name
        )
        known_sources.add(source)
        items.append(
            {
                "key": f"signal:{index}:{source}",
                "field": field,
                "label": f"{subject_name} — {signal.kind.value}",
                "before": None,
                "after": signal.signal,
                "status": "add",
                "store": {
                    **_signal_store(signal, source, subject_name, unresolved=unresolved),
                    "prospect_id": str(prospect_id) if prospect_id is not None else None,
                    "company_id": None if prospect_id is not None else str(company_id),
                },
                "source": source,
                "quote": signal.score_reason,
            }
        )
    return {
        "kind": "signals",
        "items": items,
        "refused": refused,
        "stale": False,
        "confidence": result.confidence,
        "notes": result.notes or result.company_summary,
    }


def build_proposal(session: Session, task: AgentTask, raw: dict[str, Any]) -> dict[str, Any]:
    """The reviewable reading of a submitted result. Raises `InvalidFieldError` on a schema error
    (the agent may fix it: the task stays claimed)."""
    match task.type:
        case AgentTaskType.UPDATE_COMPANY:
            if task.company_id is None:
                raise InvalidFieldError("task", "This task has no company.", "missing_subject")
            return _company_proposal(session, task, raw, task.company_id)
        case AgentTaskType.UPDATE_EMPLOYEE:
            if task.prospect_id is None:
                raise InvalidFieldError("task", "This task has no prospect.", "missing_subject")
            return _employee_proposal(session, task, raw, task.prospect_id)
        case AgentTaskType.FIND_EMPLOYEES:
            if task.company_id is None:
                raise InvalidFieldError("task", "This task has no company.", "missing_subject")
            return _find_employees_proposal(session, task, raw, task.company_id)
        case AgentTaskType.FIND_PROSPECTS:
            return _find_prospects_proposal(session, task, raw)
        case AgentTaskType.SURVEIL_SIGNALS:
            if task.company_id is None:
                raise InvalidFieldError("task", "This task has no company.", "missing_subject")
            return _signals_proposal(session, task, raw, task.company_id)
        case _:
            raise InvalidFieldError("task", "This task type has no proposal yet.", "unsupported")
