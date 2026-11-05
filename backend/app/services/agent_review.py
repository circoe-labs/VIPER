"""Reviewing an agent's proposal: accept (apply through the ordinary service) or reject.

This is the only path from an agent's idea into the base. Acceptance runs the **existing** service
(`companies.update_company`) with the **validating person** as actor, so the audit says who really
decided, and `source=agent` keeps the proposal's origin. Nothing is applied item by item outside a
transaction: either the accepted items are written, or none is.

A rejection does not destroy the work: the result keeps `raw` and the reason, and the task returns
to the queue while attempts remain.
"""

import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.agent_missions import AgentTask, AgentTaskResult
from app.models.companies import Company, Establishment
from app.models.enums import (
    ActivityStatus,
    AgentResultStatus,
    AgentTaskStatus,
    AgentTaskType,
    Civility,
    NoteSourceType,
    PhoneType,
    ProspectSourceType,
    SignalKind,
    SignalOrigin,
)
from app.models.prospects import Prospect, ProspectNote
from app.models.taxonomies import Role
from app.repositories.taxonomies import find_by_label
from app.services import audit, companies, prospect_editor
from app.services.agent_payloads import site_place
from app.services.companies import CompanyInput, EstablishmentInput, EstablishmentView, get_company
from app.services.contact_channels import ChannelItem
from app.services.errors import ConflictError, InvalidFieldError, NotFoundError
from app.services.prospect_editor import (
    EditorClock,
    EmploymentVerification,
    ManualSource,
    ProspectForm,
    VerificationAction,
    aggregate_version,
)

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class Review:
    """What the review card needs: the submission, its task and who or what it targets."""

    result: AgentTaskResult
    task: AgentTask
    company_name: str | None
    prospect_name: str | None


def get_review(session: Session, result_id: uuid.UUID) -> Review:
    result = session.get(AgentTaskResult, result_id)
    if result is None:
        raise NotFoundError("Unknown result.")
    task = session.get(AgentTask, result.task_id)
    if task is None:
        raise NotFoundError("Unknown task.")
    company_name = (
        session.scalar(select(Company.display_name).where(Company.id == task.company_id))
        if task.company_id is not None
        else None
    )
    prospect_name = None
    if task.prospect_id is not None:
        prospect = session.get(Prospect, task.prospect_id)
        if prospect is not None:
            prospect_name = (
                " ".join(part for part in (prospect.first_name, prospect.last_name) if part) or None
            )
    return Review(result=result, task=task, company_name=company_name, prospect_name=prospect_name)


def _locked(session: Session, result_id: uuid.UUID) -> tuple[AgentTaskResult, AgentTask]:
    result = session.scalar(
        select(AgentTaskResult).where(AgentTaskResult.id == result_id).with_for_update()
    )
    if result is None:
        raise NotFoundError("Unknown result.")
    if result.status is not AgentResultStatus.PENDING_REVIEW:
        raise ConflictError("This result has already been decided.")
    task = session.scalar(select(AgentTask).where(AgentTask.id == result.task_id).with_for_update())
    if task is None:
        raise NotFoundError("Unknown task.")
    return result, task


def _subject(task: AgentTask) -> tuple[str, uuid.UUID] | None:
    if task.prospect_id is not None:
        return "prospect", task.prospect_id
    if task.company_id is not None:
        return "company", task.company_id
    return None


def _establishment(site: EstablishmentView) -> EstablishmentInput:
    return EstablishmentInput(
        id=site.id,
        name=site.name,
        siret=site.siret,
        address_line1=site.address_line1,
        address_line2=site.address_line2,
        postal_code=site.postal_code,
        city=site.city,
        country=site.country,
        kind=site.kind,
        is_primary=site.is_primary,
    )


def _apply_company(
    session: Session, actor: ActorContext, task: AgentTask, items: Sequence[dict[str, Any]]
) -> dict[str, Any]:
    if task.company_id is None:
        raise InvalidFieldError("task", "This task has no company.", "missing_subject")
    detail = get_company(session, task.company_id)
    values = {item["field"]: item["store"] for item in items}
    segment = values.get("commercial_segment")
    data = CompanyInput(
        display_name=detail.display_name,
        legal_name=values.get("legal_name", detail.legal_name),
        siren=values.get("siren", detail.siren),
        website_url=values.get("website_url", detail.website_url),
        email_domain=values.get("email_domain", detail.email_domain),
        size_label=values.get("size_label", detail.size_label),
        commercial_segment_id=(
            uuid.UUID(str(segment))
            if segment is not None
            else (detail.commercial_segment.id if detail.commercial_segment else None)
        ),
        activity_category_ids=[
            uuid.UUID(str(value))
            for value in values.get(
                "activity_categories",
                [category.id for category in detail.activity_categories],
            )
        ],
        project_done_with_circoe=detail.project_done_with_circoe,
        project_type=detail.project_type,
        circoe_references=detail.circoe_references,
        client_approach=detail.client_approach,
        establishments=[_establishment(site) for site in detail.establishments],
    )
    companies.update_company(session, actor, detail.id, data)
    return {"company_id": str(detail.id), "fields": sorted(values)}


def _employee_form(prospect: Prospect, items: Sequence[dict[str, Any]]) -> ProspectForm:
    """The whole editable state, current values plus the accepted items, as the editor expects."""
    values = {
        item["field"]: item["store"] for item in items if item["field"] not in ("emails", "phones")
    }
    if prospect.company_id is None:
        raise InvalidFieldError("company_id", "This prospect has no company.", "missing")
    emails = [
        ChannelItem(
            value=row.address,
            id=row.id,
            is_primary=row.is_primary,
            is_active=row.is_active,
            verification_status=row.verification_status,
        )
        for row in prospect.emails
    ]
    phones = [
        ChannelItem(
            value=row.number,
            id=row.id,
            is_primary=row.is_primary,
            is_active=row.is_active,
            verification_status=row.verification_status,
            phone_type=row.type,
        )
        for row in prospect.phones
    ]
    known_emails = {row.value.casefold() for row in emails}
    known_phones = {row.value for row in phones}
    for item in items:
        if item["field"] == "emails":
            address = str(item["store"]["address"])
            if address.casefold() not in known_emails:
                emails.append(ChannelItem(value=address))
                known_emails.add(address.casefold())
        elif item["field"] == "phones":
            number = str(item["store"]["number"])
            if number not in known_phones:
                phones.append(
                    ChannelItem(value=number, phone_type=PhoneType(str(item["store"]["type"])))
                )
                known_phones.add(number)
    return ProspectForm(
        first_name=values.get("first_name", prospect.first_name),
        last_name=values.get("last_name", prospect.last_name),
        company_id=prospect.company_id,
        civility=(
            Civility(str(values["civility"])) if "civility" in values else prospect.civility
        ),
        role_id=uuid.UUID(str(values["role"])) if "role" in values else prospect.role_id,
        exact_job_title=values.get("exact_job_title", prospect.exact_job_title),
        activity_status=(
            ActivityStatus(str(values["activity_status"]))
            if "activity_status" in values
            else prospect.activity_status
        ),
        emails=emails,
        phones=phones,
    )


def _apply_employee(
    session: Session, actor: ActorContext, task: AgentTask, items: Sequence[dict[str, Any]]
) -> dict[str, Any]:
    if task.prospect_id is None:
        raise InvalidFieldError("task", "This task has no prospect.", "missing_subject")
    prospect = session.get(Prospect, task.prospect_id)
    if prospect is None:
        raise NotFoundError("Unknown prospect.")
    form = _employee_form(prospect, items)
    prospect_editor.update_prospect(
        session,
        actor,
        prospect.id,
        aggregate_version(session, prospect.id),
        form,
        EditorClock(now=datetime.now(UTC)),
    )
    return {
        "prospect_id": str(prospect.id),
        "fields": sorted({str(item["field"]) for item in items}),
    }


def _apply_find_employees(
    session: Session, actor: ActorContext, task: AgentTask, items: Sequence[dict[str, Any]]
) -> dict[str, Any]:
    """Create the accepted people under the task's company, with the agent as provenance."""
    if task.company_id is None:
        raise InvalidFieldError("task", "This task has no company.", "missing_subject")
    company = get_company(session, task.company_id)
    clock = EditorClock(now=datetime.now(UTC))
    created: list[str] = []
    for item in items:
        store = item["store"]
        role_id = None
        role_label = None
        if store.get("role"):
            role = find_by_label(session, Role, str(store["role"]))
            if role is not None:
                role_id = role.id
            else:
                role_label = str(store["role"])
        emails = (
            [
                ChannelItem(value=str(store["email"]), is_primary=True, verified_now=True)
            ]
            if store.get("email")
            else []
        )
        phones = (
            [
                ChannelItem(
                    value=str(store["phone"]),
                    is_primary=True,
                    phone_type=PhoneType.OTHER,
                    verified_now=True,
                )
            ]
            if store.get("phone")
            else []
        )
        form = ProspectForm(
            first_name=str(store["first_name"]),
            last_name=str(store["last_name"]),
            company_id=company.id,
            civility=Civility(store["civility"]) if store.get("civility") else None,
            role_id=role_id,
            role_label=role_label,
            exact_job_title=store.get("exact_job_title"),
            activity_status=(
                ActivityStatus(store["activity_status"])
                if store.get("activity_status")
                else ActivityStatus.UNKNOWN
            ),
            employment_verification=EmploymentVerification(
                action=VerificationAction.VERIFIED_NOW
            ),
            emails=emails,
            phones=phones,
        )
        source = ManualSource(
            legal_basis_or_collection_context=str(store["legal_basis"]),
            source_reference=store.get("source"),
            source_type=ProspectSourceType.FUTURE_AGENT,
        )
        view = prospect_editor.create_prospect(session, actor, form, source, clock)
        created.append(str(view.id))
    return {"company_id": str(company.id), "created": created}


def _site_key(site: dict[str, Any] | EstablishmentView) -> str | tuple[str, str] | None:
    """SIRET first, then (city, name): the identity of a proposed or created site."""
    if isinstance(site, EstablishmentView):
        return site.siret or site_place(site.city, site.name)
    return site.get("siret") or site_place(site.get("city"), site.get("name"))


def _new_sites(
    session: Session, sites: Sequence[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """The proposed sites still to create, and those skipped because they are known.

    Checked again at acceptance: a SIRET may have entered the base since the agent submitted.
    """
    kept: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    seen: set[str | tuple[str, str]] = set()
    for site in sites:
        key = _site_key(site)
        siret = site.get("siret")
        if siret and session.scalar(select(Establishment.id).where(Establishment.siret == siret)):
            skipped.append({"name": site.get("name"), "siret": siret, "reason": "already_known"})
            continue
        if key is None or key in seen:
            skipped.append({"name": site.get("name"), "siret": siret, "reason": "duplicate"})
            continue
        seen.add(key)
        kept.append(site)
    return kept, skipped


def _signal_note(
    store: dict[str, Any],
    result_id: uuid.UUID,
    *,
    company_id: uuid.UUID | None,
    prospect_id: uuid.UUID | None = None,
) -> ProspectNote:
    """The signal row of an accepted proposal (`origin=agent`, its source and its result)."""
    return ProspectNote(
        prospect_id=prospect_id,
        company_id=company_id,
        fact_text=str(store["signal"]),
        noted_on=date.fromisoformat(str(store["observed_on"])),
        source_type=(
            NoteSourceType(str(store["source_channel"])) if store.get("source_channel") else None
        ),
        source_url=str(store["source_url"]),
        kind=SignalKind(str(store["kind"])),
        origin=SignalOrigin.AGENT,
        observed_on=date.fromisoformat(str(store["observed_on"])),
        valid_until=(
            date.fromisoformat(str(store["valid_until"])) if store.get("valid_until") else None
        ),
        relevance=store.get("relevance"),
        sentiment=store.get("sentiment"),
        score_delta=store.get("score_delta"),
        task_result_id=result_id,
    )


def _apply_find_prospects(
    session: Session,
    actor: ActorContext,
    items: Sequence[dict[str, Any]],
    result_id: uuid.UUID,
) -> dict[str, Any]:
    """Create each accepted company with its sites and its trigger signal, in the caller's
    transaction: a failure on any of them leaves nothing written.

    Provenance: the company and its sites are audited as the deciding person's acceptance; the
    signal carries `source_url`, `origin=agent` and `task_result_id`; `applied` maps every created
    id to the source, opening date and surface the agent cited (no column holds those yet).
    Proposals stored before sites and triggers existed have neither key and create the company
    alone.
    """
    created: list[str] = []
    applied: list[dict[str, Any]] = []
    for item in items:
        store = item["store"]
        segment_id = store.get("commercial_segment_id")
        sites, skipped = _new_sites(session, store.get("establishments") or [])
        data = CompanyInput(
            display_name=str(store["display_name"]),
            legal_name=store.get("legal_name"),
            siren=store.get("siren"),
            website_url=store.get("website_url"),
            email_domain=store.get("email_domain"),
            size_label=store.get("size_label"),
            commercial_segment_id=uuid.UUID(str(segment_id)) if segment_id else None,
            activity_category_ids=[
                uuid.UUID(str(value)) for value in store.get("activity_category_ids", [])
            ],
            establishments=[
                EstablishmentInput(
                    name=site.get("name"),
                    siret=site.get("siret"),
                    address_line1=site.get("address_line1"),
                    postal_code=site.get("postal_code"),
                    city=site.get("city"),
                    country=site.get("country"),
                    kind=site.get("kind"),
                )
                for site in sites
            ],
        )
        detail = companies.create_company(session, actor, data)
        created.append(str(detail.id))
        by_key = {_site_key(site): site for site in sites}
        establishments = [
            {
                "id": str(view.id),
                "name": view.name,
                "siret": view.siret,
                "source": by_key.get(_site_key(view), {}).get("source"),
                "opened_on": by_key.get(_site_key(view), {}).get("opened_on"),
                "surface_m2": by_key.get(_site_key(view), {}).get("surface_m2"),
            }
            for view in detail.establishments
        ]
        signal_id = None
        trigger = store.get("trigger")
        if trigger:
            note = _signal_note(trigger, result_id, company_id=detail.id)
            session.add(note)
            session.flush()
            signal_id = str(note.id)
        applied.append(
            {
                "company_id": str(detail.id),
                "source": store.get("source"),
                "establishments": establishments,
                "skipped_establishments": skipped,
                "signal_id": signal_id,
            }
        )
        logger.info(
            "find_prospects accepted: company=%s sites=%d skipped=%d trigger=%s result=%s",
            detail.id,
            len(establishments),
            len(skipped),
            signal_id is not None,
            result_id,
        )
    return {"created": created, "companies": applied}


def _apply_signals(
    session: Session,
    actor: ActorContext,
    task: AgentTask,
    items: Sequence[dict[str, Any]],
    result_id: uuid.UUID,
) -> dict[str, Any]:
    """Insert the accepted signals as notes (the score reads the person ones directly)."""
    created: list[str] = []
    for item in items:
        store = item["store"]
        prospect_id = uuid.UUID(str(store["prospect_id"])) if store.get("prospect_id") else None
        company_id = uuid.UUID(str(store["company_id"])) if store.get("company_id") else None
        note = _signal_note(store, result_id, company_id=company_id, prospect_id=prospect_id)
        session.add(note)
        session.flush()
        created.append(str(note.id))
    return {"signals": len(created), "ids": created}


def accept(
    session: Session,
    actor: ActorContext,
    result_id: uuid.UUID,
    accepted_keys: Sequence[str] | None = None,
    note: str | None = None,
) -> AgentTaskResult:
    """Apply the accepted items. `accepted_keys=None` accepts every item the agent proposed."""
    result, task = _locked(session, result_id)
    items = list(result.proposal.get("items", []))
    known = {item["key"] for item in items}
    chosen = known if accepted_keys is None else set(accepted_keys)
    unknown = sorted(chosen - known)
    if unknown:
        raise InvalidFieldError("accepted_items", f"Unknown item {unknown[0]!r}.", "unknown")
    selected = [item for item in items if item["key"] in chosen]
    if not selected:
        raise InvalidFieldError("accepted_items", "Nothing to accept.", "empty")
    applied: dict[str, Any] = {}
    match task.type:
        case AgentTaskType.UPDATE_COMPANY:
            applied = _apply_company(session, actor, task, selected)
        case AgentTaskType.UPDATE_EMPLOYEE:
            applied = _apply_employee(session, actor, task, selected)
        case AgentTaskType.FIND_EMPLOYEES:
            applied = _apply_find_employees(session, actor, task, selected)
        case AgentTaskType.FIND_PROSPECTS:
            applied = _apply_find_prospects(session, actor, selected, result.id)
        case AgentTaskType.SURVEIL_SIGNALS:
            applied = _apply_signals(session, actor, task, selected, result.id)
        case _:
            raise InvalidFieldError("task", "No apply path for this task type.", "unsupported")
    moment = datetime.now(UTC)
    result.status = AgentResultStatus.ACCEPTED
    result.decided_at = moment
    result.decided_by_id = actor.id
    result.decided_by_display = actor.display
    result.decision_note = note
    result.accepted_items = {"keys": sorted(chosen)}
    result.applied = applied
    task.status = AgentTaskStatus.ACCEPTED
    task.failure_code = None
    task.failure_message = None
    session.flush()
    audit.record_event(
        session,
        actor,
        audit.AuditAction.AGENT_TASK_RESULT_ACCEPTED,
        entity_type="agent_task_result",
        entity_id=result.id,
        subject=_subject(task),
        changes={"status": {"before": "pending_review", "after": "accepted"}},
        reason=note,
    )
    return result


def reject(
    session: Session, actor: ActorContext, result_id: uuid.UUID, reason: str
) -> AgentTaskResult:
    """Refuse the proposal; the task goes back to the queue while attempts remain."""
    if not reason.strip():
        raise InvalidFieldError("reason", "A reason is required.", "empty")
    result, task = _locked(session, result_id)
    moment = datetime.now(UTC)
    result.status = AgentResultStatus.REJECTED
    result.decided_at = moment
    result.decided_by_id = actor.id
    result.decided_by_display = actor.display
    result.decision_note = reason.strip()
    session.flush()
    if task.attempts < task.max_attempts:
        task.status = AgentTaskStatus.PENDING
    else:
        task.status = AgentTaskStatus.FAILED
        task.failure_code = "rejected"
        task.failure_message = reason.strip()
    session.flush()
    audit.record_event(
        session,
        actor,
        audit.AuditAction.AGENT_TASK_RESULT_REJECTED,
        entity_type="agent_task_result",
        entity_id=result.id,
        subject=_subject(task),
        changes={"status": {"before": "pending_review", "after": "rejected"}},
        reason=reason.strip(),
    )
    return result
