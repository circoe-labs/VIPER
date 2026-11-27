"""The tasks of a run work side by side: what the others and the base already hold.

A discovery run creates one task per wanted item, claimed by agents in parallel. This module owns
the two guards against finding the same thing twice:

- `known_values`: what a claimed task is told to avoid (bounded);
- `check`: a submission that proposes nothing new, or an item another task of the mission already
  has pending or accepted, is refused while the task is still claimed, so the agent looks for
  another one.

Duplicates against the base itself are the proposal builders' job (`agent_payloads`).
"""

import logging
from collections.abc import Mapping
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.agent_missions import AgentTask, AgentTaskResult
from app.models.companies import Company
from app.models.enums import AgentResultStatus, AgentTaskType
from app.models.missions import MissionRun
from app.services.errors import InvalidFieldError
from app.services.imports.matching import company_key
from app.services.mission_output import LIST_FIELDS, ONE_ITEM_TYPES

logger = logging.getLogger(__name__)

# The most entries one `known_values` list carries.
KNOWN_MAX = 500
BASE_COMPANIES_MAX = 300

_TAKEN = (AgentResultStatus.PENDING_REVIEW, AgentResultStatus.ACCEPTED)


def _text(value: Any) -> str:
    return " ".join(str(value or "").split()).casefold()


def identities(task: AgentTask, item: Mapping[str, Any]) -> set[str]:
    """What makes a proposed item « the same one » as another."""
    store = item.get("store") or {}
    found: set[str] = set()
    if task.type is AgentTaskType.FIND_EMPLOYEES:
        company = task.company_id
        found.add(
            f"person:{company}:{_text(store.get('first_name'))} {_text(store.get('last_name'))}"
        )
        if store.get("email"):
            found.add(f"email:{_text(store['email'])}")
        return found
    sites = store.get("establishments") or []
    found.update(f"siret:{site['siret']}" for site in sites if site.get("siret"))
    existing = store.get("existing_company_id")
    if existing:
        # New warehouses of a known company: another warehouse of it is another item.
        found.update(
            f"site:{existing}:{_text(site.get('city'))}:{_text(site.get('name'))}"
            for site in sites
            if not site.get("siret")
        )
        return found
    if store.get("display_name"):
        found.add(f"company:{company_key(str(store['display_name']))}")
    if store.get("siren"):
        found.add(f"siren:{store['siren']}")
    if store.get("email_domain"):
        found.add(f"domain:{_text(store['email_domain'])}")
    return found


def _sibling_items(
    session: Session, task: AgentTask, statuses: tuple[AgentResultStatus, ...]
) -> list[tuple[AgentResultStatus, AgentTask, dict[str, Any]]]:
    """The items the other tasks of the mission proposed (an accepted result: only what the
    person kept), newest first."""
    mission_id = select(MissionRun.mission_id).where(MissionRun.id == task.run_id)
    runs = select(MissionRun.id).where(MissionRun.mission_id == mission_id.scalar_subquery())
    rows = session.execute(
        select(AgentTaskResult, AgentTask)
        .join(AgentTask, AgentTask.id == AgentTaskResult.task_id)
        .where(
            AgentTask.run_id.in_(runs),
            AgentTask.id != task.id,
            AgentTask.type == task.type,
            AgentTaskResult.status.in_(statuses),
        )
        .order_by(AgentTaskResult.submitted_at.desc())
    ).all()
    found = []
    for result, sibling in rows:
        kept = (
            set((result.accepted_items or {}).get("keys", []))
            if result.status is AgentResultStatus.ACCEPTED
            else None
        )
        for item in result.proposal.get("items", []):
            if kept is None or item["key"] in kept:
                found.append((result.status, sibling, item))
    return found


def _described(task: AgentTask, item: Mapping[str, Any]) -> str:
    store = item.get("store") or {}
    if task.type is AgentTaskType.FIND_EMPLOYEES:
        return " ".join(
            str(part) for part in (store.get("first_name"), store.get("last_name")) if part
        )
    places = ", ".join(
        str(site.get("city") or site.get("name"))
        for site in store.get("establishments") or []
        if site.get("city") or site.get("name")
    )
    name = str(store.get("display_name") or item.get("label") or "")
    return f"{name} ({places})" if places else name


def known_values(session: Session, task: AgentTask) -> dict[str, Any]:
    """What this task must not bring again: the siblings' proposals (pending, accepted, and the
    refused ones so nobody retries them) and, for companies, the names already in the base."""
    proposed: list[str] = []
    refused: list[str] = []
    for status, sibling, item in _sibling_items(
        session, task, (*_TAKEN, AgentResultStatus.REJECTED)
    ):
        # Finding people: only the same company's matter.
        if sibling.company_id != task.company_id:
            continue
        (refused if status is AgentResultStatus.REJECTED else proposed).append(
            _described(task, item)
        )
    known: dict[str, Any] = {
        "already_proposed": list(dict.fromkeys(proposed))[:KNOWN_MAX],
        "refused_by_reviewer": list(dict.fromkeys(refused))[:KNOWN_MAX],
    }
    if task.type is AgentTaskType.FIND_PROSPECTS:
        known["companies_in_base"] = list(
            session.scalars(
                select(Company.display_name)
                .order_by(Company.created_at.desc(), Company.id)
                .limit(BASE_COMPANIES_MAX)
            )
        )
        known["companies_in_base_total"] = session.scalar(select(func.count()).select_from(Company))
    return known


def check(
    session: Session,
    task: AgentTask,
    rule: Mapping[str, Any] | None,
    proposal: Mapping[str, Any],
) -> None:
    """Refuse a discovery submission of a mission run that brings nothing new. Raises
    `InvalidFieldError`: the task stays claimed and the agent may send something else.

    Locks the run until the transaction ends, so two siblings submitting the same item at the
    same moment cannot both pass. A « Dépôt » drop is what a person asked for: not checked."""
    if (
        rule is None
        or task.run_id is None
        or task.type not in ONE_ITEM_TYPES
        or int(rule.get("items_per_task") or 1) != 1
    ):
        return
    field = LIST_FIELDS[task.type]
    items = list(proposal.get("items", []))
    if not items:
        refused = proposal.get("refused") or []
        why = refused[0]["message"] if refused else "Nothing was proposed."
        logger.info("mission task refused, nothing new: task=%s", task.id)
        raise InvalidFieldError(
            field,
            f"Nothing new to propose: {why} Look for another one, or submit outcome "
            "not_found with notes.",
            str(refused[0]["reason"]) if refused else "empty",
        )
    session.execute(
        select(MissionRun.id).where(MissionRun.id == task.run_id).with_for_update(key_share=True)
    )
    held: set[str] = set()
    for _, sibling, item in _sibling_items(session, task, _TAKEN):
        held |= identities(sibling, item)
    for item in items:
        if identities(task, item) & held:
            logger.info("mission task refused, sibling duplicate: task=%s", task.id)
            raise InvalidFieldError(
                field,
                f"« {item['label']} » is already proposed by another task of this mission. "
                "Look for another one, or submit outcome not_found with notes.",
                "duplicate_sibling",
            )
