"""« Réévaluer le score »: the command that asks an agent, and the state the card reads (S4).

`request_reassessment` creates a **one-off mission bound to the prospect** through the ordinary
`missions.create` (type `other`, canonical « other » category, one `prospect_id` target, the forced
task type `reassess_score`). From there it is the usual process: an agent claims the task over MCP
(`viper_claim_task`), returns a structured proposal (`viper_submit_task_result`, contract in
`score_reassessment.py`), a person reviews it (`agent_review.accept|reject`) and only an accepted
proposal changes the score, by writing audited, traceable score notes.

There is no direct LLM call here. A reassessment that fails, is refused or is cancelled leaves the
score untouched: the score is computed on read from the notes, and nothing is written before an
accept.

The command is a reusable seam: the Mission menu (S5) calls `request_reassessment` for its
« Réanalyse son score » preset instead of building its own mission.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.agent_missions import AgentTask, AgentTaskResult
from app.models.enums import (
    AgentResultStatus,
    AgentTaskStatus,
    AgentTaskType,
    MissionResultKind,
    MissionStatus,
    MissionType,
)
from app.models.mcp import McpToken
from app.models.missions import PROMPT_MAX_LENGTH, MissionRun
from app.models.prospects import Prospect
from app.services import mcp_tokens, missions
from app.services.errors import NotFoundError
from app.services.score_reassessment import PROPOSAL_KIND

logger = logging.getLogger(__name__)

ReassessmentStatus = Literal[
    "idle",  # never asked
    "queued",  # waiting for an agent (or requeued after an agent gave up)
    "running",  # an agent holds the task
    "proposal",  # a proposal waits for the person's decision
    "applied",  # accepted: the score notes are written
    "nothing_found",  # the agent found nothing to change
    "rejected",  # the person refused the proposal; the score is unchanged
    "failed",  # the agent could not reach its sources
    "cancelled",
]

OPEN_STATUSES = (AgentTaskStatus.PENDING, AgentTaskStatus.CLAIMED, AgentTaskStatus.SUBMITTED)
EXTRA_NOTE_MAX_LENGTH = 1000
# VIPER launches no agent: external MCP clients poll the queue. An agent that called `/mcp` this
# recently counts as « connected », so the card can say « en attente d'un agent » truthfully.
AGENT_RECENT = timedelta(minutes=10)

PROMPT = (
    "Réévalue le score prospect de la personne ciblée : à quel point elle (et son entreprise) "
    "entre dans les critères cibles de Circoe. Propose des contributions signées, chacune avec une "
    "raison, une source publique et une citation. Le réseau de relations et la proximité avec "
    "l'équipe ne comptent pas dans ce score. Ta réponse est une proposition : une personne la "
    "relit avant tout changement du score."
)


@dataclass(frozen=True, slots=True)
class ReassessmentState:
    """What the score card shows about the latest reassessment of a prospect."""

    status: ReassessmentStatus
    task_id: uuid.UUID | None = None
    mission_id: uuid.UUID | None = None
    run_id: uuid.UUID | None = None
    result_id: uuid.UUID | None = None
    requested_at: datetime | None = None
    agent_label: str | None = None
    failure_code: str | None = None
    failure_message: str | None = None
    # The reviewable proposal (`score_reassessment.build_proposal`) while `status == "proposal"`.
    proposal: dict[str, Any] | None = None
    decided_by: str | None = None
    decided_at: datetime | None = None
    # How many live agents (token used in the last 10 min) may claim a `reassess_score` task.
    # 0 while `queued` = nobody can pick it up: a person must start an agent.
    agents_available: int = 0


def agents_available(session: Session, *, now: datetime | None = None) -> int:
    """Live MCP agents whose scopes let them claim a `reassess_score` task."""
    since = (now or datetime.now(UTC)) - AGENT_RECENT
    tokens = session.scalars(
        select(McpToken).where(McpToken.revoked_at.is_(None), McpToken.last_used_at >= since)
    ).all()
    return sum(AgentTaskType.REASSESS_SCORE in mcp_tokens.task_types(token) for token in tokens)


def _latest_task(session: Session, prospect_id: uuid.UUID) -> AgentTask | None:
    return session.scalar(
        select(AgentTask)
        .where(AgentTask.prospect_id == prospect_id, AgentTask.type == AgentTaskType.REASSESS_SCORE)
        # An open task wins over a closed one (also when two are created in one transaction).
        .order_by(AgentTask.status.in_(OPEN_STATUSES).desc(), AgentTask.created_at.desc())
        .limit(1)
    )


def _latest_result(session: Session, task: AgentTask) -> AgentTaskResult | None:
    return session.scalar(
        select(AgentTaskResult)
        .where(AgentTaskResult.task_id == task.id)
        .order_by(AgentTaskResult.submitted_at.desc())
        .limit(1)
    )


def _status_of(task: AgentTask, result: AgentTaskResult | None) -> ReassessmentStatus:
    match task.status:
        case AgentTaskStatus.PENDING:
            return "rejected" if task.failure_code == "rejected" else "queued"
        case AgentTaskStatus.CLAIMED:
            return "running"
        case AgentTaskStatus.SUBMITTED:
            pending = result is not None and result.status is AgentResultStatus.PENDING_REVIEW
            return "proposal" if pending else "queued"
        case AgentTaskStatus.ACCEPTED:
            accepted = result is not None and result.status is AgentResultStatus.ACCEPTED
            return "applied" if accepted else "nothing_found"
        case AgentTaskStatus.FAILED:
            return "failed"
        case _:
            return "cancelled"


def state(session: Session, prospect_id: uuid.UUID) -> ReassessmentState:
    """The latest reassessment of the prospect, derived from its task (one source of truth)."""
    if session.get(Prospect, prospect_id) is None:
        raise NotFoundError("Unknown prospect.")
    task = _latest_task(session, prospect_id)
    if task is None:
        return ReassessmentState(status="idle")
    result = _latest_result(session, task)
    status = _status_of(task, result)
    run = session.get(MissionRun, task.run_id) if task.run_id else None
    proposal = (
        result.proposal
        if status == "proposal"
        and result is not None
        and result.proposal.get("kind") == PROPOSAL_KIND
        else None
    )
    return ReassessmentState(
        status=status,
        task_id=task.id,
        mission_id=run.mission_id if run is not None else None,
        run_id=task.run_id,
        result_id=result.id if result is not None else None,
        requested_at=task.created_at,
        agent_label=(result.submitted_by_label if result is not None else task.claimed_by_label),
        failure_code=task.failure_code,
        failure_message=task.failure_message,
        proposal=proposal,
        decided_by=result.decided_by_display if result is not None else None,
        decided_at=result.decided_at if result is not None else None,
        agents_available=agents_available(session) if status in ("queued", "running") else 0,
    )


def _prospect_name(prospect: Prospect) -> str:
    return (
        " ".join(part for part in (prospect.first_name, prospect.last_name) if part) or "Prospect"
    )


def request_reassessment(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    *,
    agent_id: uuid.UUID | None = None,
    extra_instruction: str | None = None,
) -> tuple[ReassessmentState, bool]:
    """Ask for a reassessment. Returns `(state, created)`: a second click while one is open
    returns that one (`created=False`) instead of opening a second mission."""
    prospect = session.get(Prospect, prospect_id)
    if prospect is None:
        raise NotFoundError("Unknown prospect.")
    current = state(session, prospect_id)
    if current.status == "rejected":
        # The person refused the last proposal: that attempt ends, a new one starts below.
        cancel_reassessment(session, actor, prospect_id)
    task = _latest_task(session, prospect_id)
    if task is not None and task.status in OPEN_STATUSES:
        logger.info("score reassessment already open prospect=%s task=%s", prospect_id, task.id)
        return current, False
    prompt = PROMPT
    extra = (extra_instruction or "").strip()
    if extra:
        prompt = f"{PROMPT}\n\nPrécision de la personne : {extra[:EXTRA_NOTE_MAX_LENGTH]}"
    mission = missions.create(
        session,
        actor,
        missions.MissionInput(
            name=f"Réévaluer le score — {_prospect_name(prospect)}"[:200],
            type=MissionType.OTHER,
            prompt=prompt[:PROMPT_MAX_LENGTH],
            targets=(missions.TargetInput(prospect_id=prospect_id),),
            agent_id=agent_id,
            result_kind=MissionResultKind.ENRICHMENT,
            task_type=AgentTaskType.REASSESS_SCORE,
        ),
        run_now=True,
    )
    logger.info("score reassessment requested prospect=%s mission=%s", prospect_id, mission.id)
    return state(session, prospect_id), True


def cancel_reassessment(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID
) -> ReassessmentState:
    """Stop the open reassessment (its mission is cancelled, any proposal waiting is rejected).
    The score is untouched. No open one: the state is returned unchanged."""
    current = state(session, prospect_id)
    if current.mission_id is not None and current.status in (
        "queued",
        "running",
        "proposal",
        "rejected",
    ):
        missions.set_status(session, actor, current.mission_id, MissionStatus.CANCELLED)
        logger.info("score reassessment cancelled prospect=%s", prospect_id)
    return state(session, prospect_id)
