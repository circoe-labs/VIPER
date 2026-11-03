"""Agent missions: the orchestration itself — opening a thread, claiming, reporting, deciding.

Claiming is the heart. One short transaction:

1. release the expired leases (a task whose agent died returns to the queue without losing the
   attempt it already used);
2. pick one free task under `FOR UPDATE SKIP LOCKED`, highest priority first, oldest first.

`SKIP LOCKED` is what makes several agents safe: two claimers never see the same free row and
neither waits for the other. The dispatcher already relies on the same primitive
(`contact_dispatch.py`). The claim then rotates `claim_id`; every later call must carry it, which
is what makes a submission exactly-once.

Only an `AGENT` may claim or report: a person works in the UI, where the review lives.
"""

import hashlib
import json
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models.agent_missions import AgentTask, AgentTaskResult, AgentThread
from app.models.companies import Company
from app.models.enums import (
    AgentResultStatus,
    AgentTaskStatus,
    AgentTaskType,
    AgentThreadKind,
    AgentThreadStatus,
)
from app.models.prospects import Prospect
from app.services import audit
from app.services.agent_payloads import (
    build_payload,
    build_proposal,
    queueable,
    result_model,
    supports,
)
from app.services.companies import CompanyDetail, get_company
from app.services.errors import (
    ActorNotAllowedError,
    ConflictError,
    InvalidFieldError,
    NotFoundError,
)

DEFAULT_LEASE = timedelta(minutes=15)
# Who releases an expired lease: not the agent that died, not the one that claims next.
LEASE_ACTOR = ActorContext(type=ActorType.SYSTEM, display="VIPER — bail des missions", id="leases")

OPEN_THREAD_STATUSES = (AgentThreadStatus.OPEN, AgentThreadStatus.PAUSED)
OPEN_TASK_STATUSES = (
    AgentTaskStatus.PENDING,
    AgentTaskStatus.CLAIMED,
    AgentTaskStatus.SUBMITTED,
)
# Default priority per type: what unblocks a person first comes first.
TASK_PRIORITIES = {
    AgentTaskType.UPDATE_EMPLOYEE: 60,
    AgentTaskType.UPDATE_COMPANY: 50,
    AgentTaskType.FIND_EMPLOYEES: 40,
    AgentTaskType.SURVEIL_SIGNALS: 30,
    AgentTaskType.FIND_PROSPECTS: 20,
}


@dataclass(frozen=True, slots=True)
class ClaimedTask:
    task: AgentTask
    payload: dict[str, Any]
    lease_seconds: int

    @property
    def claim_id(self) -> uuid.UUID:
        """The token the agent must send back with every later call."""
        if self.task.claim_id is None:
            raise RuntimeError("A claimed task always has a claim id.")
        return self.task.claim_id


def _agent_id(actor: ActorContext) -> str:
    if actor.type is not ActorType.AGENT or not actor.id:
        raise ActorNotAllowedError("Only a registered agent claims or reports a task.")
    return actor.id


def _moment(now: datetime | None) -> datetime:
    return now or datetime.now(UTC)


def _subject(task: AgentTask) -> tuple[str, uuid.UUID] | None:
    """Whose history shows the event: the person, else the company."""
    if task.prospect_id is not None:
        return "prospect", task.prospect_id
    if task.company_id is not None:
        return "company", task.company_id
    return None


def _event(
    session: Session,
    actor: ActorContext,
    action: str,
    task: AgentTask,
    changes: dict[str, Any] | None = None,
    reason: str | None = None,
) -> None:
    audit.record_event(
        session,
        actor,
        action,
        entity_type="agent_task",
        entity_id=task.id,
        subject=_subject(task),
        changes=changes or {},
        reason=reason,
    )


def _clear_claim(task: AgentTask) -> None:
    task.claim_id = None
    task.claimed_by_id = None
    task.claimed_by_label = None
    task.claimed_at = None
    task.lease_expires_at = None
    task.last_heartbeat_at = None


# --- opening a thread ---------------------------------------------------------------------------


def _open_task_exists(
    session: Session, type: AgentTaskType, company_id: uuid.UUID, prospect_id: uuid.UUID | None
) -> bool:
    statement = select(AgentTask.id).where(
        AgentTask.type == type,
        AgentTask.company_id == company_id,
        AgentTask.status.in_(OPEN_TASK_STATUSES),
    )
    if prospect_id is None:
        statement = statement.where(AgentTask.prospect_id.is_(None))
    else:
        statement = statement.where(AgentTask.prospect_id == prospect_id)
    return session.scalar(statement) is not None


def _add_task(
    session: Session,
    actor: ActorContext,
    thread: AgentThread,
    type: AgentTaskType,
    company_id: uuid.UUID,
    prospect_id: uuid.UUID | None = None,
) -> AgentTask | None:
    """Create the task unless an identical open one exists (the DB indexes are the backstop).

    A type without a result schema is not queued: it would be a task no agent can complete.
    """
    if not queueable(type):
        return None
    if _open_task_exists(session, type, company_id, prospect_id):
        return None
    task = AgentTask(
        thread_id=thread.id,
        type=type,
        company_id=company_id,
        prospect_id=prospect_id,
        status=AgentTaskStatus.PENDING,
        priority=TASK_PRIORITIES[type],
    )
    session.add(task)
    session.flush()
    _event(session, actor, audit.AuditAction.AGENT_TASK_CREATED, task)
    return task


def _missing_employee(prospect: Prospect) -> bool:
    primary_email = any(row.is_primary and row.is_active for row in prospect.emails)
    primary_phone = any(row.is_primary and row.is_active for row in prospect.phones)
    return (
        prospect.role_id is None
        or prospect.employment_verified_at is None
        or not primary_email
        or not primary_phone
    )


def open_company_review(
    session: Session, actor: ActorContext, company_id: uuid.UUID
) -> AgentThread:
    """« Ajoute cette société à la liste des sociétés à analyser complètement ».

    Opens the company's thread, or completes the one already open (never a second: the partial
    unique index refuses it, and this function checks first). Only types with a result schema are
    queued (`agent_payloads.supports`): today `update_company`. The employee, surveillance and
    discovery tasks join the same function when their schema exists — a queued type no agent can
    complete would sit in the thread forever.
    """
    company = session.get(Company, company_id)
    if company is None:
        raise NotFoundError("Unknown company.")
    thread = session.scalar(
        select(AgentThread)
        .where(
            AgentThread.kind == AgentThreadKind.COMPANY_REVIEW,
            AgentThread.company_id == company_id,
            AgentThread.status.in_(OPEN_THREAD_STATUSES),
        )
        .with_for_update()
    )
    if thread is None:
        thread = AgentThread(
            kind=AgentThreadKind.COMPANY_REVIEW,
            company_id=company_id,
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
            subject=("company", company_id),
        )
    detail = get_company(session, company_id)
    if _company_is_incomplete(detail):
        _add_task(session, actor, thread, AgentTaskType.UPDATE_COMPANY, company_id)
    prospects = session.scalars(select(Prospect).where(Prospect.company_id == company_id)).all()
    for prospect in prospects:
        if _missing_employee(prospect):
            _add_task(
                session,
                actor,
                thread,
                AgentTaskType.UPDATE_EMPLOYEE,
                company_id,
                prospect.id,
            )
    return thread


def _company_is_incomplete(company: CompanyDetail) -> bool:
    return any(
        value in (None, "", [])
        for value in (
            company.legal_name,
            company.siren,
            company.website_url,
            company.email_domain,
            company.size_label,
            company.commercial_segment,
            company.activity_categories,
        )
    )


# --- the queue ----------------------------------------------------------------------------------


def sweep_expired(session: Session, now: datetime | None = None) -> int:
    """Release the leases that ran out. Returns how many tasks came back to the queue."""
    moment = _moment(now)
    expired = session.scalars(
        select(AgentTask)
        .where(
            AgentTask.status == AgentTaskStatus.CLAIMED,
            AgentTask.lease_expires_at < moment,
        )
        .with_for_update(skip_locked=True)
    ).all()
    for task in expired:
        _clear_claim(task)
        task.status = AgentTaskStatus.PENDING
        _event(session, LEASE_ACTOR, audit.AuditAction.AGENT_TASK_EXPIRED, task)
    if expired:
        session.flush()
    return len(expired)


def claim(
    session: Session,
    actor: ActorContext,
    *,
    types: Sequence[AgentTaskType],
    thread_id: uuid.UUID | None = None,
    lease: timedelta = DEFAULT_LEASE,
    now: datetime | None = None,
) -> ClaimedTask | None:
    """Claim the next free task of an allowed type, or None when the queue is empty for it."""
    agent_id = _agent_id(actor)
    moment = _moment(now)
    # A task whose result schema does not exist yet would fail at submit: never hand it out.
    types = [task_type for task_type in types if supports(task_type)]
    if not types:
        return None
    sweep_expired(session, moment)
    conditions = [
        AgentTask.status == AgentTaskStatus.PENDING,
        AgentTask.type.in_(list(types)),
        AgentTask.attempts < AgentTask.max_attempts,
    ]
    if thread_id is not None:
        conditions.append(AgentTask.thread_id == thread_id)
    # A mission may name its agent: another token never sees its tasks.
    try:
        token_id: uuid.UUID | None = uuid.UUID(agent_id)
    except ValueError:
        token_id = None
    if token_id is None:
        conditions.append(AgentTask.assigned_agent_id.is_(None))
    else:
        conditions.append(
            or_(AgentTask.assigned_agent_id.is_(None), AgentTask.assigned_agent_id == token_id)
        )
    statement = (
        select(AgentTask)
        .where(*conditions)
        .order_by(AgentTask.priority.desc(), AgentTask.created_at.asc())
        .limit(1)
        .with_for_update(skip_locked=True)
    )
    task = session.scalars(statement).first()
    if task is None:
        return None
    task.status = AgentTaskStatus.CLAIMED
    task.claim_id = uuid.uuid7()
    task.claimed_by_id = agent_id
    task.claimed_by_label = actor.display
    task.claimed_at = moment
    task.last_heartbeat_at = moment
    task.lease_expires_at = moment + lease
    task.attempts += 1
    session.flush()
    _event(
        session,
        actor,
        audit.AuditAction.AGENT_TASK_CLAIMED,
        task,
        changes={"status": {"before": "pending", "after": "claimed"}},
    )
    payload = build_payload(session, task, lease_expires_at=task.lease_expires_at, now=moment)
    return ClaimedTask(task=task, payload=payload, lease_seconds=int(lease.total_seconds()))


def claim_specific(
    session: Session,
    actor: ActorContext,
    task_id: uuid.UUID,
    *,
    lease: timedelta = DEFAULT_LEASE,
    now: datetime | None = None,
) -> AgentTask:
    """Claim one named pending task, under the same lease rules as `claim`.

    Tool-mode writes use it: the agent names the record it is proposing, so there is no queue to
    pick from. The task keeps its own lifecycle (submitted, reviewed, rejected), exactly like a
    claimed mission.
    """
    agent_id = _agent_id(actor)
    moment = _moment(now)
    task = session.scalar(select(AgentTask).where(AgentTask.id == task_id).with_for_update())
    if task is None:
        raise NotFoundError("Unknown task.")
    if task.status is not AgentTaskStatus.PENDING or task.attempts >= task.max_attempts:
        raise ConflictError("This task is not waiting to be claimed.")
    task.status = AgentTaskStatus.CLAIMED
    task.claim_id = uuid.uuid7()
    task.claimed_by_id = agent_id
    task.claimed_by_label = actor.display
    task.claimed_at = moment
    task.last_heartbeat_at = moment
    task.lease_expires_at = moment + lease
    task.attempts += 1
    session.flush()
    _event(
        session,
        actor,
        audit.AuditAction.AGENT_TASK_CLAIMED,
        task,
        changes={"status": {"before": "pending", "after": "claimed"}},
    )
    return task


def _claimed(
    session: Session,
    actor: ActorContext,
    task_id: uuid.UUID,
    claim_id: uuid.UUID,
    now: datetime | None = None,
) -> AgentTask:
    _agent_id(actor)
    task = session.scalar(select(AgentTask).where(AgentTask.id == task_id).with_for_update())
    if task is None:
        raise NotFoundError("Unknown task.")
    if task.status is not AgentTaskStatus.CLAIMED or task.claim_id != claim_id:
        raise ConflictError("The claim is lost: this task is no longer yours.")
    if task.claimed_by_id != actor.id:
        raise ActorNotAllowedError("This task is claimed by another agent.")
    if task.lease_expires_at is not None and task.lease_expires_at <= _moment(now):
        raise ConflictError("The lease has expired: claim the task again.")
    return task


def heartbeat(
    session: Session,
    actor: ActorContext,
    task_id: uuid.UUID,
    claim_id: uuid.UUID,
    *,
    lease: timedelta = DEFAULT_LEASE,
    now: datetime | None = None,
) -> datetime:
    """Renew the lease; the task is refused once it has actually expired."""
    moment = _moment(now)
    task = _claimed(session, actor, task_id, claim_id, moment)
    task.last_heartbeat_at = moment
    task.lease_expires_at = moment + lease
    session.flush()
    return task.lease_expires_at


def submit(
    session: Session,
    actor: ActorContext,
    task_id: uuid.UUID,
    claim_id: uuid.UUID,
    raw: dict[str, Any],
    now: datetime | None = None,
) -> AgentTaskResult:
    """Store a submission as a proposal awaiting review. Never applies anything."""
    moment = _moment(now)
    task = _claimed(session, actor, task_id, claim_id, moment)
    try:
        validated = result_model(task.type).model_validate(raw).model_dump(mode="json")
    except ValidationError as error:
        first = error.errors()[0]
        field = ".".join(str(part) for part in first["loc"]) or "result"
        raise InvalidFieldError(field, first["msg"], "schema") from error
    proposal = build_proposal(session, task, validated)
    digest = hashlib.sha256(
        json.dumps(validated, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    result = AgentTaskResult(
        task_id=task.id,
        attempt=task.attempts,
        submitted_by_id=actor.id,
        submitted_by_label=actor.display,
        submitted_at=moment,
        raw=validated,
        proposal=proposal,
        digest=digest,
        status=AgentResultStatus.PENDING_REVIEW,
    )
    session.add(result)
    task.status = AgentTaskStatus.SUBMITTED
    _clear_claim(task)
    session.flush()
    _event(
        session,
        actor,
        audit.AuditAction.AGENT_TASK_SUBMITTED,
        task,
        changes={"status": {"before": "claimed", "after": "submitted"}},
        reason=f"attempt {task.attempts}",
    )
    return result


def fail(
    session: Session,
    actor: ActorContext,
    task_id: uuid.UUID,
    claim_id: uuid.UUID,
    code: str,
    message: str,
    now: datetime | None = None,
) -> AgentTask:
    """The agent could not do the work. Back to the queue until `max_attempts`, then `failed`."""
    task = _claimed(session, actor, task_id, claim_id, now)
    task.failure_code = code[:64]
    task.failure_message = message
    _clear_claim(task)
    task.status = (
        AgentTaskStatus.PENDING if task.attempts < task.max_attempts else AgentTaskStatus.FAILED
    )
    session.flush()
    _event(
        session,
        actor,
        audit.AuditAction.AGENT_TASK_FAILED,
        task,
        changes={"status": {"before": "claimed", "after": task.status.value}},
        reason=code,
    )
    return task


def release(
    session: Session,
    actor: ActorContext,
    task_id: uuid.UUID,
    claim_id: uuid.UUID,
    now: datetime | None = None,
) -> AgentTask:
    """The agent gives the task back without failing it (it stops, another may take it)."""
    task = _claimed(session, actor, task_id, claim_id, now)
    _clear_claim(task)
    if task.attempts >= task.max_attempts:
        task.status = AgentTaskStatus.FAILED
        task.failure_code = "released"
        task.failure_message = "The last agent gave the task back without a result."
    else:
        task.status = AgentTaskStatus.PENDING
    session.flush()
    _event(
        session,
        actor,
        audit.AuditAction.AGENT_TASK_RELEASED,
        task,
        changes={"status": {"before": "claimed", "after": task.status.value}},
    )
    return task


# --- reading the page ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ThreadCard:
    """One « Analyse » as the Agents page shows it: counts, who is working, last activity."""

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
    agents: tuple[str, ...]
    last_activity_at: datetime | None
    created_at: datetime


@dataclass(frozen=True, slots=True)
class TaskRow:
    """One task as the thread detail shows it, with the person it targets and its pending result."""

    id: uuid.UUID
    type: AgentTaskType
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
    result_status: AgentResultStatus | None
    submitted_at: datetime | None
    created_at: datetime
    updated_at: datetime


def thread_cards(session: Session, *, status: AgentThreadStatus | None = None) -> list[ThreadCard]:
    """Every thread with its counts, in two statements whatever the number of threads."""
    counts = (
        select(
            AgentTask.thread_id.label("thread_id"),
            func.count(AgentTask.id).label("total"),
            func.count(AgentTask.id)
            .filter(AgentTask.status == AgentTaskStatus.ACCEPTED)
            .label("done"),
            func.count(AgentTask.id)
            .filter(AgentTask.status == AgentTaskStatus.PENDING)
            .label("pending"),
            func.count(AgentTask.id)
            .filter(AgentTask.status == AgentTaskStatus.CLAIMED)
            .label("claimed"),
            func.count(AgentTask.id)
            .filter(AgentTask.status == AgentTaskStatus.SUBMITTED)
            .label("submitted"),
            func.count(AgentTask.id)
            .filter(AgentTask.status == AgentTaskStatus.FAILED)
            .label("failed"),
            func.max(AgentTask.updated_at).label("last_task_at"),
        )
        .group_by(AgentTask.thread_id)
        .subquery()
    )
    statement = (
        select(
            AgentThread,
            Company.display_name,
            counts.c.total,
            counts.c.done,
            counts.c.pending,
            counts.c.claimed,
            counts.c.submitted,
            counts.c.failed,
            counts.c.last_task_at,
        )
        .outerjoin(Company, Company.id == AgentThread.company_id)
        .outerjoin(counts, counts.c.thread_id == AgentThread.id)
        .order_by(AgentThread.priority.desc(), AgentThread.created_at.desc())
    )
    if status is not None:
        statement = statement.where(AgentThread.status == status)
    rows = session.execute(statement).all()
    working = session.execute(
        select(AgentTask.thread_id, AgentTask.claimed_by_label)
        .where(AgentTask.status == AgentTaskStatus.CLAIMED)
        .distinct()
    ).all()
    agents: dict[uuid.UUID, list[str]] = {}
    for thread_id, label in working:
        if label:
            agents.setdefault(thread_id, []).append(label)
    cards = []
    for (
        thread,
        company_name,
        total,
        done,
        pending,
        claimed,
        submitted,
        failed,
        last_task_at,
    ) in rows:
        cards.append(
            ThreadCard(
                id=thread.id,
                kind=thread.kind,
                title=thread.title,
                status=thread.status,
                company_id=thread.company_id,
                company_name=company_name,
                tasks_total=total or 0,
                tasks_done=done or 0,
                tasks_pending=pending or 0,
                tasks_claimed=claimed or 0,
                tasks_submitted=submitted or 0,
                tasks_failed=failed or 0,
                agents=tuple(sorted(agents.get(thread.id, []))),
                last_activity_at=max(
                    [moment for moment in (thread.updated_at, last_task_at) if moment is not None],
                    default=None,
                ),
                created_at=thread.created_at,
            )
        )
    return cards


def thread_detail(
    session: Session, thread_id: uuid.UUID
) -> tuple[AgentThread, str | None, list[TaskRow]]:
    thread = session.get(AgentThread, thread_id)
    if thread is None:
        raise NotFoundError("Unknown thread.")
    company_name = (
        session.scalar(select(Company.display_name).where(Company.id == thread.company_id))
        if thread.company_id is not None
        else None
    )
    rows = session.execute(
        select(AgentTask, Prospect.first_name, Prospect.last_name, AgentTaskResult)
        .outerjoin(Prospect, Prospect.id == AgentTask.prospect_id)
        .outerjoin(
            AgentTaskResult,
            (AgentTaskResult.task_id == AgentTask.id)
            & (AgentTaskResult.status == AgentResultStatus.PENDING_REVIEW),
        )
        .where(AgentTask.thread_id == thread_id)
        .order_by(AgentTask.priority.desc(), AgentTask.created_at.asc())
    ).all()
    tasks = [
        TaskRow(
            id=task.id,
            type=task.type,
            status=task.status,
            priority=task.priority,
            attempts=task.attempts,
            max_attempts=task.max_attempts,
            company_id=task.company_id,
            prospect_id=task.prospect_id,
            prospect_name=" ".join(part for part in (first, last) if part) or None,
            claimed_by_label=task.claimed_by_label,
            claimed_at=task.claimed_at,
            lease_expires_at=task.lease_expires_at,
            failure_code=task.failure_code,
            result_id=result.id if result is not None else None,
            result_status=result.status if result is not None else None,
            submitted_at=result.submitted_at if result is not None else None,
            created_at=task.created_at,
            updated_at=task.updated_at,
        )
        for task, first, last, result in rows
    ]
    return thread, company_name, tasks


def set_status(
    session: Session, actor: ActorContext, thread_id: uuid.UUID, status: AgentThreadStatus
) -> AgentThread:
    """A person pauses, resumes or closes a thread. Nothing else changes."""
    thread = session.get(AgentThread, thread_id)
    if thread is None:
        raise NotFoundError("Unknown thread.")
    if thread.status is status:
        return thread
    before = thread.status.value
    thread.status = status
    session.flush()
    audit.record_event(
        session,
        actor,
        audit.AuditAction.AGENT_THREAD_STATUS_CHANGED,
        entity_type="agent_thread",
        entity_id=thread.id,
        subject=("company", thread.company_id) if thread.company_id else None,
        changes={"status": {"before": before, "after": status.value}},
    )
    return thread


def queue_counts(session: Session, types: Sequence[AgentTaskType]) -> dict[str, int]:
    """How many tasks of each allowed type wait for an agent — cheap polling, no claim."""
    if not types:
        return {}
    rows = session.execute(
        select(AgentTask.type, func.count(AgentTask.id))
        .where(
            AgentTask.status == AgentTaskStatus.PENDING,
            AgentTask.type.in_(list(types)),
            AgentTask.attempts < AgentTask.max_attempts,
        )
        .group_by(AgentTask.type)
    ).all()
    return {task_type.value: count for task_type, count in rows}
