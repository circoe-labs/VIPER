"""Agents: the « Analyse » threads, their tasks, and the queue a person organises.

Read and organise from the browser; the tasks themselves are claimed by agents over MCP
(`app.services.agent_missions`). Nothing here applies a result yet: the review comes next, and it
will be the only write path from an agent's proposal into the base.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, ConfigDict

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.models.agent_missions import AgentThread
from app.models.enums import AgentTaskStatus, AgentThreadKind, AgentThreadStatus
from app.services import agent_missions, agent_review

router = APIRouter(prefix="/agents/threads", tags=["agents"])
results_router = APIRouter(prefix="/agents/results", tags=["agents"])


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ThreadCardOut(BaseModel):
    id: uuid.UUID
    kind: AgentThreadKind
    title: str
    status: AgentThreadStatus
    company_id: uuid.UUID | None
    company_name: str | None
    tasks_total: int
    tasks_done: int
    tasks_pending: int
    tasks_claimed: int
    tasks_submitted: int
    tasks_failed: int
    agents: list[str]
    last_activity_at: datetime | None
    created_at: datetime


class ThreadListOut(BaseModel):
    items: list[ThreadCardOut]
    total: int


class TaskRowOut(BaseModel):
    id: uuid.UUID
    type: str
    status: AgentTaskStatus
    priority: int
    attempts: int
    max_attempts: int
    company_id: uuid.UUID | None
    prospect_id: uuid.UUID | None
    prospect_name: str | None
    claimed_by_label: str | None
    claimed_at: datetime | None
    lease_expires_at: datetime | None
    failure_code: str | None
    result_id: uuid.UUID | None
    submitted_at: datetime | None
    created_at: datetime


class ThreadDetailOut(BaseModel):
    thread: ThreadCardOut
    tasks: list[TaskRowOut]


class ThreadCreateIn(StrictModel):
    # « Ajoute cette société dans la liste des sociétés à analyser complètement ».
    company_id: uuid.UUID


class ThreadStatusIn(StrictModel):
    status: AgentThreadStatus


class ResultOut(BaseModel):
    id: uuid.UUID
    task_id: uuid.UUID
    task_type: str
    task_status: AgentTaskStatus
    status: str
    submitted_at: datetime
    submitted_by_label: str
    digest: str
    proposal: dict[str, Any]
    accepted_items: dict[str, Any] | None
    applied: dict[str, Any] | None
    decision_note: str | None
    decided_at: datetime | None
    decided_by_display: str | None
    company_name: str | None
    prospect_name: str | None


class AcceptIn(StrictModel):
    # None accepts every item the agent proposed.
    accepted_items: list[str] | None = None
    note: str | None = None


class RejectIn(StrictModel):
    reason: str


def _card(
    thread: AgentThread,
    tasks: list[agent_missions.TaskRow],
    company_name: str | None = None,
) -> ThreadCardOut:
    """The card of one thread, counted from its tasks (no second aggregate query)."""
    return ThreadCardOut(
        id=thread.id,
        kind=thread.kind,
        title=thread.title,
        status=thread.status,
        company_id=thread.company_id,
        company_name=company_name,
        tasks_total=len(tasks),
        tasks_done=sum(1 for task in tasks if task.status is AgentTaskStatus.ACCEPTED),
        tasks_pending=sum(1 for task in tasks if task.status is AgentTaskStatus.PENDING),
        tasks_claimed=sum(1 for task in tasks if task.status is AgentTaskStatus.CLAIMED),
        tasks_submitted=sum(1 for task in tasks if task.status is AgentTaskStatus.SUBMITTED),
        tasks_failed=sum(1 for task in tasks if task.status is AgentTaskStatus.FAILED),
        agents=sorted(
            {
                task.claimed_by_label
                for task in tasks
                if task.status is AgentTaskStatus.CLAIMED and task.claimed_by_label
            }
        ),
        last_activity_at=max(
            [thread.updated_at, *(task.updated_at for task in tasks)],
            default=None,
        ),
        created_at=thread.created_at,
    )


@router.get("")
def list_threads(
    session: SessionDep,
    status: Annotated[AgentThreadStatus | None, Query()] = None,
) -> ThreadListOut:
    """The cards of the Agents page, open threads first."""
    cards = agent_missions.thread_cards(session, status=status)
    items = [ThreadCardOut.model_validate(card, from_attributes=True) for card in cards]
    return ThreadListOut(items=items, total=len(items))


@router.post("", status_code=201)
def open_thread(
    body: ThreadCreateIn,
    session: SessionDep,
    actor: CurrentActor,
) -> ThreadDetailOut:
    with business_errors():
        thread = agent_missions.open_company_review(session, actor, body.company_id)
        detail, company_name, tasks = agent_missions.thread_detail(session, thread.id)
    return ThreadDetailOut(thread=_card(detail, tasks, company_name), tasks=_rows(tasks))


@router.get("/{thread_id}")
def get_thread(thread_id: uuid.UUID, session: SessionDep) -> ThreadDetailOut:
    with business_errors():
        thread, company_name, tasks = agent_missions.thread_detail(session, thread_id)
    return ThreadDetailOut(thread=_card(thread, tasks, company_name), tasks=_rows(tasks))


@router.patch("/{thread_id}")
def update_thread(
    thread_id: uuid.UUID,
    body: ThreadStatusIn,
    session: SessionDep,
    actor: CurrentActor,
) -> ThreadDetailOut:
    """Pause, resume or close a thread. A person's decision, audited."""
    with business_errors():
        agent_missions.set_status(session, actor, thread_id, body.status)
        thread, company_name, tasks = agent_missions.thread_detail(session, thread_id)
    return ThreadDetailOut(thread=_card(thread, tasks, company_name), tasks=_rows(tasks))


def _result_out(review: agent_review.Review) -> ResultOut:
    result = review.result
    return ResultOut(
        id=result.id,
        task_id=result.task_id,
        task_type=review.task.type.value,
        task_status=review.task.status,
        status=result.status.value,
        submitted_at=result.submitted_at,
        submitted_by_label=result.submitted_by_label,
        digest=result.digest,
        proposal=result.proposal,
        accepted_items=result.accepted_items,
        applied=result.applied,
        decision_note=result.decision_note,
        decided_at=result.decided_at,
        decided_by_display=result.decided_by_display,
        company_name=review.company_name,
        prospect_name=review.prospect_name,
    )


@results_router.get("/{result_id}")
def get_result(result_id: uuid.UUID, session: SessionDep) -> ResultOut:
    with business_errors():
        return _result_out(agent_review.get_review(session, result_id))


@results_router.post("/{result_id}/accept")
def accept_result(
    result_id: uuid.UUID,
    body: AcceptIn,
    session: SessionDep,
    actor: CurrentActor,
) -> ResultOut:
    """Apply the accepted items through the ordinary service, as the person deciding."""
    with business_errors():
        agent_review.accept(session, actor, result_id, body.accepted_items, body.note)
        return _result_out(agent_review.get_review(session, result_id))


@results_router.post("/{result_id}/reject")
def reject_result(
    result_id: uuid.UUID,
    body: RejectIn,
    session: SessionDep,
    actor: CurrentActor,
) -> ResultOut:
    with business_errors():
        agent_review.reject(session, actor, result_id, body.reason)
        return _result_out(agent_review.get_review(session, result_id))


def _rows(tasks: list[agent_missions.TaskRow]) -> list[TaskRowOut]:
    return [
        TaskRowOut(
            id=task.id,
            type=task.type.value,
            status=task.status,
            priority=task.priority,
            attempts=task.attempts,
            max_attempts=task.max_attempts,
            company_id=task.company_id,
            prospect_id=task.prospect_id,
            prospect_name=task.prospect_name,
            claimed_by_label=task.claimed_by_label,
            claimed_at=task.claimed_at,
            lease_expires_at=task.lease_expires_at,
            failure_code=task.failure_code,
            result_id=task.result_id,
            submitted_at=task.submitted_at,
            created_at=task.created_at,
        )
        for task in tasks
    ]
