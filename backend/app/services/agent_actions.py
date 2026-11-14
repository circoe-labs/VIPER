"""Stage task-scoped database intentions; only human review can apply them."""

import logging
import uuid
from typing import Any

from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.agent_missions import AgentTask
from app.models.companies import Company
from app.models.enums import AgentTaskType
from app.models.prospects import Prospect
from app.services import agent_missions
from app.services.agent_payloads import (
    CompanyProposal,
    CompanyUpdateResult,
    EmployeeUpdateResult,
    build_proposal,
    task_rule,
)
from app.services.errors import ConflictError, InvalidFieldError

MODELS: dict[str, type[BaseModel]] = {
    "add_company": CompanyProposal,
    "update_company": CompanyUpdateResult,
    "update_prospect": EmployeeUpdateResult,
}
MAX_ACTIONS = 50
# The task type whose single target each update operation may name inside a mission run.
_OPERATION_TASK = {
    "update_company": AgentTaskType.UPDATE_COMPANY,
    "update_prospect": AgentTaskType.UPDATE_EMPLOYEE,
}
logger = logging.getLogger(__name__)


def _check_mission_contract(
    session: Session,
    task: AgentTask,
    operation: str,
    target_id: uuid.UUID | None,
    actions: list[dict[str, Any]],
) -> None:
    """Inside a mission run, staging is another way to fill the same output contract: one target
    per task (an update names only the task's own record) and no more additions than the mission
    returns per task (one when `allow_multiple` is false). A tool-mode task is unconstrained."""
    if task.run_id is None:
        return
    if operation == "add_company":
        rule = task_rule(session, task)
        allow_multiple = bool(rule.get("allow_multiple", True)) if rule else True
        cap = (rule["result_limit"] if rule else MAX_ACTIONS) if allow_multiple else 1
        added = sum(1 for action in actions if action["operation"] == "add_company")
        if added >= cap:
            raise InvalidFieldError(
                "actions",
                "This mission returns one item at a time (allow_multiple=false)."
                if not allow_multiple
                else f"This mission allows at most {cap} items per task.",
                "too_many",
            )
        return
    subject = task.company_id if operation == "update_company" else task.prospect_id
    if task.type is not _OPERATION_TASK[operation] or target_id != subject:
        raise InvalidFieldError(
            "target_id",
            "A mission task works on its own target only: stage updates for this task's record.",
            "wrong_target",
        )


def stage(
    session: Session,
    actor: ActorContext,
    task_id: uuid.UUID,
    claim_id: uuid.UUID,
    action_id: uuid.UUID,
    operation: str,
    data: dict[str, Any],
    target_id: uuid.UUID | None,
) -> dict[str, Any]:
    task = agent_missions._claimed(session, actor, task_id, claim_id)
    model = MODELS[operation]
    if operation == "add_company" and task.type is not AgentTaskType.FIND_PROSPECTS:
        raise InvalidFieldError(
            "operation", "Company discovery requires a find_prospects task.", "unsupported"
        )
    if operation != "add_company" and target_id is None:
        raise InvalidFieldError("target_id", "A target is required.", "missing")
    try:
        validated = model.model_validate(data).model_dump(mode="json")
    except ValidationError as error:
        first = error.errors()[0]
        raise InvalidFieldError("data", first["msg"], "schema") from error
    action = {
        "id": str(action_id),
        "operation": operation,
        "target_id": str(target_id) if target_id else None,
        "data": validated,
    }
    actions = list(task.staged_actions or [])
    _check_mission_contract(session, task, operation, target_id, actions)
    for previous in actions:
        if previous["id"] == action["id"]:
            if previous != action:
                raise ConflictError("This action ID was already used with different data.")
            return {"action_id": str(action_id), "staged_count": len(actions)}
        if (
            target_id
            and previous["operation"] == operation
            and previous["target_id"] == str(target_id)
        ):
            raise ConflictError(
                "This target already has a staged update; combine its changes in one action."
            )
    if len(actions) >= MAX_ACTIONS:
        raise InvalidFieldError("actions", "At most 50 actions per task.", "limit")
    if operation == "update_prospect" and session.get(Prospect, target_id) is None:
        raise InvalidFieldError("target_id", "Unknown prospect.", "unknown")
    # Build now to check the target exists; all proposals are rebuilt at final submission.
    if operation != "add_company":
        kind = (
            AgentTaskType.UPDATE_COMPANY
            if operation == "update_company"
            else AgentTaskType.UPDATE_EMPLOYEE
        )
        virtual = AgentTask(
            type=kind,
            company_id=target_id if operation == "update_company" else None,
            prospect_id=target_id if operation == "update_prospect" else None,
            claimed_at=task.claimed_at,
        )
        build_proposal(session, virtual, validated)
    task.staged_actions = [*actions, action]
    session.flush()
    logger.info(
        "agent action staged: task=%s operation=%s count=%d", task.id, operation, len(actions) + 1
    )
    return {"action_id": str(action_id), "staged_count": len(actions) + 1}


def proposal(session: Session, task: AgentTask, actions: list[dict[str, Any]]) -> dict[str, Any]:
    """Build one review, using the existing validators and diff builders for every operation."""
    groups: list[tuple[str, str, str | None, dict[str, Any]]] = []
    additions = [a for a in actions if a["operation"] == "add_company"]
    if additions:
        result = {"companies": [a["data"] for a in additions], "confidence": 0}
        groups.append(("companies", "add_company", None, build_proposal(session, task, result)))
    for action in actions:
        operation = action["operation"]
        if operation == "add_company":
            continue
        target_uuid = uuid.UUID(action["target_id"])
        kind = (
            AgentTaskType.UPDATE_COMPANY
            if operation == "update_company"
            else AgentTaskType.UPDATE_EMPLOYEE
        )
        virtual = AgentTask(
            type=kind,
            company_id=target_uuid if operation == "update_company" else None,
            prospect_id=target_uuid if operation == "update_prospect" else None,
            claimed_at=task.claimed_at,
        )
        groups.append(
            (
                action["id"],
                operation,
                action["target_id"],
                build_proposal(session, virtual, action["data"]),
            )
        )
    items, refused = [], []
    for group_id, operation, target, group in groups:
        subject = ""
        if target and operation == "update_company":
            company = session.get(Company, uuid.UUID(target))
            subject = company.display_name if company else target
        elif target and operation == "update_prospect":
            person = session.get(Prospect, uuid.UUID(target))
            subject = (
                " ".join(filter(None, (person.first_name, person.last_name))) if person else target
            )
        for item in group["items"]:
            items.append(
                {
                    **item,
                    "label": f"{subject} — {item['label']}" if subject else item["label"],
                    "key": f"{group_id}:{item['key']}",
                    "action_group": group_id,
                    "action_operation": operation,
                    "action_target": target,
                }
            )
        for item in group["refused"]:
            refused.append({**item, "field": f"{group_id}:{item['field']}"})
    return {
        "kind": "actions",
        "items": items,
        "refused": refused,
        "stale": any(group[3]["stale"] for group in groups),
        "confidence": round(sum(a["data"].get("confidence", 0) for a in actions) / len(actions)),
        "notes": None,
    }
