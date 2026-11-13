"""« Leave work »: an agent hands back what it holds and ends its mission sessions, in one call.

It composes the two existing primitives — `agent_missions.release_claimed` (the task goes back to
the queue, audited like `viper_release_task`) and `mission_telemetry.end_own_active_sessions`
(like `viper_end_mission_session`) — it is not a second lifecycle. Idempotent: a second call finds
nothing and answers zeros. Never required: the 15-minute task lease (`sweep_expired`) and the 3 h
session inactivity timeout (`mission_telemetry.sweep_timed_out`) stay the independent fallbacks;
neither one touches what the other owns, so a timed-out session never strands a claimed task and
an expired lease never ends a session.

Scope: without `task_id`, everything the agent holds; with one of its own tasks, only that task's
run (the whole mission run: every task of the run it holds, and its session).
Contract: `doc/architecture/mcp-server.md` §4.9.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models.agent_missions import AgentTask
from app.models.enums import AgentTaskStatus
from app.services import agent_missions, mission_telemetry
from app.services.errors import ActorNotAllowedError, NotFoundError


def leave_work(
    session: Session,
    actor: ActorContext,
    task_id: uuid.UUID | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Release the claimed tasks of `actor` (of `task_id`'s run when given) and end its active
    sessions there. Returns `{"released_tasks": n, "ended_sessions": m, "scope": "all"|"run"}`."""
    if actor.type is not ActorType.AGENT or not actor.id:
        raise ActorNotAllowedError("Only a registered agent can leave work.")
    held = select(AgentTask).where(
        AgentTask.claimed_by_id == actor.id, AgentTask.status == AgentTaskStatus.CLAIMED
    )
    run_ids: list[uuid.UUID] | None = None
    if task_id is not None:
        anchor = session.get(AgentTask, task_id)
        if anchor is None:
            raise NotFoundError("Unknown task.")
        if anchor.run_id is not None:
            run_ids = [anchor.run_id]
            held = held.where(AgentTask.run_id == anchor.run_id)
        else:
            held = held.where(AgentTask.id == anchor.id)
            run_ids = []
    tasks = session.scalars(held.order_by(AgentTask.id).with_for_update()).all()
    for task in tasks:
        agent_missions.release_claimed(session, actor, task)
    ended = mission_telemetry.end_own_active_sessions(session, actor, run_ids, now)
    return {
        "released_tasks": len(tasks),
        "ended_sessions": ended,
        "scope": "all" if task_id is None else "run",
    }
