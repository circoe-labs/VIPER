"""Mission supervision read API: `/api/missions/{id}/overview|sessions|activity|results|statistics`.

Contract: `doc/architecture/mission-telemetry.md` §8. Read-only: nothing here touches a session, a
lease or a result, and no agent proposal is applied (the review endpoint stays the only way).
A mission of another organization answers 404. The mission-level role is the same as for the other
mission routes (a signed-in member).
"""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import func, select

from app.api.dependencies import AuthDep, SessionDep
from app.api.errors import business_errors
from app.models.enums import (
    AgentResultStatus,
    AgentTaskType,
    MissionAgentDisconnectReason,
    MissionAgentLogEvent,
    MissionAgentSessionStatus,
    MissionRunStatus,
    MissionStatus,
)
from app.models.mission_telemetry import MissionAgentLog, MissionAgentSession
from app.services import mission_supervision, mission_telemetry

router = APIRouter(prefix="/missions", tags=["mission supervision"])


# --- overview -----------------------------------------------------------------------------------


class RunSummaryOut(BaseModel):
    id: uuid.UUID
    status: MissionRunStatus
    scheduled_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    tasks_total: int
    results_count: int


class LiveAgentOut(BaseModel):
    agent_id: str
    agent_label: str
    session_id: uuid.UUID
    run_id: uuid.UUID
    started_at: datetime
    last_seen_at: datetime


class WarningOut(BaseModel):
    code: str
    message: str
    count: int


class TaskProgressOut(BaseModel):
    total: int
    finished: int
    by_status: dict[str, int]


class OverviewOut(BaseModel):
    mission_id: uuid.UUID
    name: str
    status: MissionStatus
    next_run_at: datetime | None
    current_run: RunSummaryOut | None
    active_sessions: int
    active_agents: int
    agents: list[LiveAgentOut]
    last_activity_at: datetime | None
    tasks: TaskProgressOut
    pending_reviews: int
    warnings: list[WarningOut]


@router.get("/{mission_id}/overview")
def mission_overview(mission_id: uuid.UUID, session: SessionDep, auth: AuthDep) -> OverviewOut:
    with business_errors():
        mission = mission_supervision.visible_mission(session, auth.user, mission_id)
        return OverviewOut.model_validate(
            mission_supervision.overview(session, mission), from_attributes=True
        )


# --- sessions and activity ----------------------------------------------------------------------


class SessionOut(BaseModel):
    id: uuid.UUID
    run_id: uuid.UUID
    agent_id: str
    agent_label: str
    status: MissionAgentSessionStatus
    started_at: datetime
    last_seen_at: datetime
    ended_at: datetime | None
    disconnect_reason: MissionAgentDisconnectReason | None
    logs_count: int


class SessionListOut(BaseModel):
    items: list[SessionOut]
    total: int
    limit: int
    offset: int


class ActivityOut(BaseModel):
    id: uuid.UUID
    session_id: uuid.UUID
    run_id: uuid.UUID
    task_id: uuid.UUID | None
    agent_id: str
    agent_label: str
    session_status: MissionAgentSessionStatus
    event_type: MissionAgentLogEvent
    message: str
    source_url: str | None
    source_published_at: datetime | None
    created_at: datetime
    metadata: dict[str, Any]


class ActivityListOut(BaseModel):
    items: list[ActivityOut]
    next_cursor: uuid.UUID | None


@router.get("/{mission_id}/sessions")
def mission_sessions(
    mission_id: uuid.UUID,
    session: SessionDep,
    auth: AuthDep,
    run_id: uuid.UUID | None = None,
    status: Annotated[list[MissionAgentSessionStatus] | None, Query()] = None,
    agent_id: Annotated[str | None, Query(max_length=128)] = None,
    limit: Annotated[
        int, Query(ge=1, le=mission_telemetry.PAGE_MAX_LIMIT)
    ] = mission_telemetry.SESSIONS_DEFAULT_LIMIT,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> SessionListOut:
    with business_errors():
        mission = mission_supervision.visible_mission(session, auth.user, mission_id)
        page = mission_telemetry.list_sessions(
            session,
            mission.organization_id,
            mission.id,
            run_id=run_id,
            statuses=status or (),
            agent_id=agent_id,
            limit=limit,
            offset=offset,
        )
        counts = {
            owner: total
            for owner, total in session.execute(
                select(MissionAgentLog.session_id, func.count())
                .where(
                    MissionAgentLog.mission_id == mission.id,
                    MissionAgentLog.session_id.in_([row.id for row in page.items]),
                )
                .group_by(MissionAgentLog.session_id)
            ).all()
        }
        items = [
            SessionOut(
                id=row.id,
                run_id=row.run_id,
                agent_id=row.agent_id,
                agent_label=row.agent_label,
                status=row.status,
                started_at=row.started_at,
                last_seen_at=row.last_seen_at,
                ended_at=row.ended_at,
                disconnect_reason=row.disconnect_reason,
                logs_count=counts.get(row.id, 0),
            )
            for row in page.items
        ]
    return SessionListOut(items=items, total=page.total, limit=limit, offset=offset)


@router.get("/{mission_id}/activity")
def mission_activity(
    mission_id: uuid.UUID,
    session: SessionDep,
    auth: AuthDep,
    run_id: uuid.UUID | None = None,
    session_id: uuid.UUID | None = None,
    agent_id: Annotated[str | None, Query(max_length=128)] = None,
    task_id: uuid.UUID | None = None,
    event_type: Annotated[list[MissionAgentLogEvent] | None, Query()] = None,
    since: datetime | None = None,
    before: uuid.UUID | None = None,
    limit: Annotated[
        int, Query(ge=1, le=mission_telemetry.PAGE_MAX_LIMIT)
    ] = mission_telemetry.ACTIVITY_DEFAULT_LIMIT,
) -> ActivityListOut:
    """The log stream, newest first. A live client polls the first page (no `before`) and merges
    by `id`; an older page is `before=<next_cursor>`."""
    with business_errors():
        mission = mission_supervision.visible_mission(session, auth.user, mission_id)
        page = mission_telemetry.list_logs(
            session,
            mission.organization_id,
            mission.id,
            run_id=run_id,
            session_id=session_id,
            agent_id=agent_id,
            task_id=task_id,
            event_types=event_type or (),
            since=since,
            before=before,
            limit=limit,
        )
        owners = {
            row.id: row
            for row in session.scalars(
                select(MissionAgentSession).where(
                    MissionAgentSession.id.in_({log.session_id for log in page.items})
                )
            )
        }
        items = [
            ActivityOut(
                id=log.id,
                session_id=log.session_id,
                run_id=log.run_id,
                task_id=log.task_id,
                agent_id=log.agent_id,
                agent_label=owners[log.session_id].agent_label,
                session_status=owners[log.session_id].status,
                event_type=log.event_type,
                message=log.message,
                source_url=log.source_url,
                source_published_at=log.source_published_at,
                created_at=log.created_at,
                metadata=log.details,
            )
            for log in page.items
        ]
    return ActivityListOut(items=items, next_cursor=page.next_cursor)


# --- results ------------------------------------------------------------------------------------


class ResultCardOut(BaseModel):
    id: uuid.UUID
    task_id: uuid.UUID
    run_id: uuid.UUID
    task_type: AgentTaskType
    status: AgentResultStatus
    agent_id: str | None
    agent_label: str
    subject_label: str | None
    summary: str | None
    confidence: int | None
    items_count: int
    refused_count: int
    sources_count: int
    submitted_at: datetime
    decided_at: datetime | None
    decided_by: str | None


class ResultListOut(BaseModel):
    items: list[ResultCardOut]
    total: int
    limit: int
    offset: int
    status_counts: dict[str, int]


@router.get("/{mission_id}/results")
def mission_results(
    mission_id: uuid.UUID,
    session: SessionDep,
    auth: AuthDep,
    status: Annotated[list[AgentResultStatus] | None, Query()] = None,
    agent_id: Annotated[str | None, Query(max_length=128)] = None,
    run_id: uuid.UUID | None = None,
    limit: Annotated[
        int, Query(ge=1, le=mission_supervision.RESULTS_MAX_LIMIT)
    ] = mission_supervision.RESULTS_DEFAULT_LIMIT,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> ResultListOut:
    with business_errors():
        mission = mission_supervision.visible_mission(session, auth.user, mission_id)
        page = mission_supervision.list_results(
            session,
            mission,
            statuses=status or (),
            agent_id=agent_id,
            run_id=run_id,
            limit=limit,
            offset=offset,
        )
    return ResultListOut(
        items=[ResultCardOut.model_validate(card, from_attributes=True) for card in page.items],
        total=page.total,
        limit=page.limit,
        offset=page.offset,
        status_counts=page.status_counts,
    )


# --- statistics ---------------------------------------------------------------------------------


class ResultsPointOut(BaseModel):
    bucket: datetime
    pending_review: int
    accepted: int
    rejected: int
    superseded: int


class CountPointOut(BaseModel):
    bucket: datetime
    count: int


class AgentStatsOut(BaseModel):
    agent_id: str
    agent_label: str
    sessions: int
    logs: int
    results: int
    accepted: int
    rejected: int
    pending_review: int


class StatisticsOut(BaseModel):
    bucket: Literal["day", "hour"]
    days: int
    since: datetime
    until: datetime
    results_by_status: dict[str, int]
    tasks_by_status: dict[str, int]
    sessions_by_status: dict[str, int]
    logs_by_event_type: dict[str, int]
    results_series: list[ResultsPointOut]
    sessions_series: list[CountPointOut]
    logs_series: list[CountPointOut]
    decided_count: int
    acceptance_rate: float | None
    avg_review_seconds: float | None
    agents: list[AgentStatsOut]


@router.get("/{mission_id}/statistics")
def mission_statistics(
    mission_id: uuid.UUID,
    session: SessionDep,
    auth: AuthDep,
    bucket: Literal["day", "hour"] = "day",
    days: Annotated[int, Query(ge=1, le=mission_supervision.STATS_MAX_DAYS)] = (
        mission_supervision.STATS_DEFAULT_DAYS
    ),
) -> StatisticsOut:
    """Mission aggregates and `days` of time buckets (`hour` is limited to 7 days)."""
    with business_errors():
        mission = mission_supervision.visible_mission(session, auth.user, mission_id)
        stats = mission_supervision.statistics(session, mission, bucket=bucket, days=days)
    return StatisticsOut.model_validate(stats, from_attributes=True)
