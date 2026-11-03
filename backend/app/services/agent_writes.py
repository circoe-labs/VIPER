"""Tool-mode writes: the agent posts a result without claiming a mission.

A mission is VIPER's idea of the work; a tool call is the assistant's. Both end the same way: a
row in `agent_task_results` waiting for a person, never a write to the base. This module opens (or
reuses) the company's thread, creates the task the proposal targets, claims it for the calling
agent, and hands the raw result to the ordinary `submit` — same schema, same proposal, same review
card, same audit.

No new state, no auto-apply. Contract: `doc/architecture/mcp-server.md` §3.4 and
`doc/architecture/agent-missions.md` §3.
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models.agent_missions import AgentTask, AgentTaskResult, AgentThread
from app.models.companies import Company
from app.models.enums import AgentTaskStatus, AgentTaskType, AgentThreadKind, AgentThreadStatus
from app.models.prospects import Prospect
from app.services import agent_missions, audit
from app.services.agent_payloads import TASK_LABELS
from app.services.errors import (
    ActorNotAllowedError,
    ConflictError,
    InvalidFieldError,
    NotFoundError,
)

OPEN_THREADS = (AgentThreadStatus.OPEN, AgentThreadStatus.PAUSED)
OPEN_TASKS = (
    AgentTaskStatus.PENDING,
    AgentTaskStatus.CLAIMED,
    AgentTaskStatus.SUBMITTED,
)


def _require_agent(actor: ActorContext) -> None:
    if actor.type is not ActorType.AGENT:
        raise ActorNotAllowedError("Only an agent may post a proposal.")


def _open_thread(
    session: Session, actor: ActorContext, company: Company
) -> AgentThread:
    """The company's open review thread, or a new one opened by the agent."""
    thread = session.scalar(
        select(AgentThread)
        .where(
            AgentThread.kind == AgentThreadKind.COMPANY_REVIEW,
            AgentThread.company_id == company.id,
            AgentThread.status.in_(OPEN_THREADS),
        )
        .with_for_update()
    )
    if thread is not None:
        return thread
    thread = AgentThread(
        kind=AgentThreadKind.COMPANY_REVIEW,
        company_id=company.id,
        title=company.display_name,
        status=AgentThreadStatus.OPEN,
        created_by_type=actor.type,
        created_by_id=actor.id,
        created_by_display=actor.display,
    )
    session.add(thread)
    session.flush()
    audit.record_event(
        session,
        actor,
        audit.AuditAction.AGENT_THREAD_CREATED,
        entity_type="agent_thread",
        entity_id=thread.id,
        subject=("company", company.id),
    )
    return thread


def _task(
    session: Session,
    actor: ActorContext,
    thread: AgentThread,
    task_type: AgentTaskType,
    company_id: uuid.UUID,
    prospect_id: uuid.UUID | None = None,
) -> AgentTask:
    """The open task this proposal targets, or a fresh one with a single attempt."""
    conditions = [
        AgentTask.type == task_type,
        AgentTask.company_id == company_id,
        AgentTask.status.in_(OPEN_TASKS),
    ]
    if prospect_id is None:
        conditions.append(AgentTask.prospect_id.is_(None))
    else:
        conditions.append(AgentTask.prospect_id == prospect_id)
    task = session.scalar(select(AgentTask).where(*conditions).with_for_update())
    if task is not None:
        return task
    task = AgentTask(
        thread_id=thread.id,
        type=task_type,
        company_id=company_id,
        prospect_id=prospect_id,
        status=AgentTaskStatus.PENDING,
        priority=agent_missions.TASK_PRIORITIES[task_type],
        # A tool proposal has no queue of agents behind it: a rejection closes it and the
        # assistant may post a corrected result in a new call.
        max_attempts=1,
    )
    session.add(task)
    session.flush()
    audit.record_event(
        session,
        actor,
        audit.AuditAction.AGENT_TASK_CREATED,
        entity_type="agent_task",
        entity_id=task.id,
        subject=("company", company_id),
        changes={"type": {"after": task_type.value}, "label": {"after": TASK_LABELS[task_type]}},
    )
    return task


def _claim(session: Session, actor: ActorContext, task: AgentTask) -> None:
    """Claim the task, or explain why the proposal cannot be stored right now."""
    if task.status is AgentTaskStatus.SUBMITTED:
        raise ConflictError(
            "A result for this record is already awaiting a person's review."
        )
    if task.status is AgentTaskStatus.CLAIMED:
        raise ConflictError(
            "This record is already claimed: submit it with viper_submit_task_result, "
            "or release it first."
        )
    agent_missions.claim_specific(session, actor, task.id)


def _submit(
    session: Session, actor: ActorContext, task: AgentTask, raw: dict[str, Any]
) -> AgentTaskResult:
    claim_id = task.claim_id
    assert claim_id is not None  # `_claim` just set it
    return agent_missions.submit(session, actor, task.id, claim_id, raw)


def propose_company_update(
    session: Session, actor: ActorContext, company_id: uuid.UUID, raw: dict[str, Any]
) -> AgentTaskResult:
    """Store a company proposal for review, without requiring a claimed mission."""
    _require_agent(actor)
    company = session.get(Company, company_id)
    if company is None:
        raise NotFoundError("Unknown company.")
    thread = _open_thread(session, actor, company)
    task = _task(session, actor, thread, AgentTaskType.UPDATE_COMPANY, company.id)
    _claim(session, actor, task)
    return _submit(session, actor, task, raw)


def propose_prospect_update(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, raw: dict[str, Any]
) -> AgentTaskResult:
    """Store a person proposal for review, without requiring a claimed mission."""
    _require_agent(actor)
    prospect = session.get(Prospect, prospect_id)
    if prospect is None:
        raise NotFoundError("Unknown prospect.")
    if prospect.company_id is None:
        raise InvalidFieldError(
            "prospect_id", "This prospect has no company to attach the proposal to.", "missing"
        )
    company = session.get(Company, prospect.company_id)
    if company is None:
        raise NotFoundError("Unknown company.")
    thread = _open_thread(session, actor, company)
    task = _task(
        session,
        actor,
        thread,
        AgentTaskType.UPDATE_EMPLOYEE,
        company.id,
        prospect.id,
    )
    _claim(session, actor, task)
    return _submit(session, actor, task, raw)
