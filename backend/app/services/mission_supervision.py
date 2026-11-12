"""Mission supervision read models: Overview, Results and Statistics (Activity and sessions live in
`mission_telemetry.list_logs` / `list_sessions`).

Contract: `doc/architecture/mission-telemetry.md` §8. Everything here is **read-only**: no call
touches a session, a task, a lease or a result, and nothing is applied to business data. A mission
is resolved once through `visible_mission` (404 for a mission of another organization); every other
query is scoped by that mission id. Aggregates are SQL (`GROUP BY`, `date_trunc`); only the page of
rows a card needs is read into Python.
"""

import uuid
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

from sqlalchemy import Select, func, select
from sqlalchemy.orm import Session

from app.models.agent_missions import AgentTask, AgentTaskResult
from app.models.companies import Company
from app.models.enums import (
    AgentResultStatus,
    AgentTaskStatus,
    AgentTaskType,
    MissionAgentLogEvent,
    MissionAgentSessionStatus,
    MissionRunStatus,
    MissionStatus,
)
from app.models.mission_telemetry import MissionAgentLog, MissionAgentSession
from app.models.missions import Mission, MissionRun
from app.models.prospects import Prospect
from app.models.users import User
from app.services.errors import InvalidFieldError, NotFoundError

Bucket = Literal["day", "hour"]

RESULTS_DEFAULT_LIMIT = 25
RESULTS_MAX_LIMIT = 100
SUMMARY_MAX_LENGTH = 280
OVERVIEW_AGENTS_MAX = 50
STATS_DEFAULT_DAYS = 14
STATS_MAX_DAYS = 90
# An hourly series is bounded to a week (168 points) so a chart never receives thousands.
STATS_MAX_HOURLY_DAYS = 7
# A task in one of these statuses is finished (nothing more will happen to it).
FINISHED_TASK_STATUSES = (
    AgentTaskStatus.ACCEPTED,
    AgentTaskStatus.FAILED,
    AgentTaskStatus.CANCELLED,
)


def visible_mission(session: Session, viewer: User, mission_id: uuid.UUID) -> Mission:
    """The mission when it belongs to the viewer's organization; `NotFoundError` otherwise (the same
    answer for an unknown id and for another organization's mission: nothing is revealed)."""
    mission = session.scalar(
        select(Mission).where(
            Mission.id == mission_id, Mission.organization_id == viewer.organization_id
        )
    )
    if mission is None:
        raise NotFoundError("Unknown mission.")
    return mission


def _utc(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


# --- overview -----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class RunSummary:
    id: uuid.UUID
    status: MissionRunStatus
    scheduled_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    tasks_total: int
    results_count: int


@dataclass(frozen=True, slots=True)
class LiveAgent:
    agent_id: str
    agent_label: str
    session_id: uuid.UUID
    run_id: uuid.UUID
    started_at: datetime
    last_seen_at: datetime


@dataclass(frozen=True, slots=True)
class Warning_:
    code: str
    message: str
    count: int


@dataclass(frozen=True, slots=True)
class TaskProgress:
    total: int
    finished: int
    by_status: dict[str, int]


@dataclass(frozen=True, slots=True)
class Overview:
    mission_id: uuid.UUID
    name: str
    status: MissionStatus
    next_run_at: datetime | None
    current_run: RunSummary | None
    active_sessions: int
    active_agents: int
    agents: list[LiveAgent]
    last_activity_at: datetime | None
    tasks: TaskProgress
    pending_reviews: int
    warnings: list[Warning_] = field(default_factory=list)


def _mission_run_ids(mission_id: uuid.UUID) -> Select[tuple[uuid.UUID]]:
    return select(MissionRun.id).where(MissionRun.mission_id == mission_id)


def _task_counts(session: Session, run_ids: Select[tuple[uuid.UUID]]) -> dict[str, int]:
    rows = session.execute(
        select(AgentTask.status, func.count())
        .where(AgentTask.run_id.in_(run_ids))
        .group_by(AgentTask.status)
    ).all()
    counts = {status.value: 0 for status in AgentTaskStatus}
    for status, count in rows:
        counts[status.value] = count
    return counts


def _results_scope(mission_id: uuid.UUID) -> Select[Any]:
    """`agent_task_results` joined to its task, restricted to the runs of the mission. Tool-mode
    results (task without a run) never belong to a mission."""
    return (
        select(AgentTaskResult)
        .join(AgentTask, AgentTask.id == AgentTaskResult.task_id)
        .where(AgentTask.run_id.in_(_mission_run_ids(mission_id)))
    )


def overview(session: Session, mission: Mission) -> Overview:
    """Compact live state in a handful of statements; never loads tasks, logs or results."""
    run = session.scalar(
        select(MissionRun)
        .where(MissionRun.mission_id == mission.id)
        .order_by(MissionRun.scheduled_at.desc(), MissionRun.id.desc())
        .limit(1)
    )
    live_rows = session.scalars(
        select(MissionAgentSession)
        .where(
            MissionAgentSession.mission_id == mission.id,
            MissionAgentSession.status == MissionAgentSessionStatus.ACTIVE,
        )
        .order_by(MissionAgentSession.last_seen_at.desc(), MissionAgentSession.id.desc())
    ).all()
    last_session_seen = session.scalar(
        select(func.max(MissionAgentSession.last_seen_at)).where(
            MissionAgentSession.mission_id == mission.id
        )
    )
    last_log = session.scalar(
        select(MissionAgentLog.created_at)
        .where(MissionAgentLog.mission_id == mission.id)
        .order_by(MissionAgentLog.created_at.desc(), MissionAgentLog.id.desc())
        .limit(1)
    )
    last_submitted = session.scalar(
        select(func.max(AgentTaskResult.submitted_at))
        .join(AgentTask, AgentTask.id == AgentTaskResult.task_id)
        .where(AgentTask.run_id.in_(_mission_run_ids(mission.id)))
    )
    moments = [m for m in (last_session_seen, last_log, last_submitted) if m is not None]

    by_status = _task_counts(session, _mission_run_ids(mission.id))
    total = sum(by_status.values())
    finished = sum(by_status[status.value] for status in FINISHED_TASK_STATUSES)
    pending_reviews = session.scalar(
        _results_scope(mission.id)
        .where(AgentTaskResult.status == AgentResultStatus.PENDING_REVIEW)
        .with_only_columns(func.count())
        .order_by(None)
    )

    timed_out = 0
    if run is not None:
        timed_out = (
            session.scalar(
                select(func.count())
                .select_from(MissionAgentSession)
                .where(
                    MissionAgentSession.run_id == run.id,
                    MissionAgentSession.status == MissionAgentSessionStatus.TIMED_OUT,
                )
            )
            or 0
        )
    warnings: list[Warning_] = []
    if timed_out:
        warnings.append(
            Warning_(
                "sessions_timed_out",
                "Des sessions d'agent ont expiré (3 h d'inactivité) dans la dernière exécution.",
                timed_out,
            )
        )
    if by_status[AgentTaskStatus.FAILED.value] and run is not None:
        failed = session.scalar(
            select(func.count())
            .select_from(AgentTask)
            .where(AgentTask.run_id == run.id, AgentTask.status == AgentTaskStatus.FAILED)
        )
        if failed:
            warnings.append(
                Warning_("tasks_failed", "Des tâches de la dernière exécution ont échoué.", failed)
            )
    open_in_run = (
        run is not None
        and run.status is MissionRunStatus.RUNNING
        and (
            by_status[AgentTaskStatus.PENDING.value] + by_status[AgentTaskStatus.CLAIMED.value] > 0
        )
    )
    if open_in_run and not live_rows:
        warnings.append(
            Warning_("no_active_agent", "Des tâches attendent, aucun agent n'est actif.", 0)
        )

    return Overview(
        mission_id=mission.id,
        name=mission.name,
        status=mission.status,
        next_run_at=mission.next_run_at,
        current_run=(
            RunSummary(
                id=run.id,
                status=run.status,
                scheduled_at=run.scheduled_at,
                started_at=run.started_at,
                finished_at=run.finished_at,
                tasks_total=run.tasks_total,
                results_count=run.results_count,
            )
            if run is not None
            else None
        ),
        active_sessions=len(live_rows),
        active_agents=len({row.agent_id for row in live_rows}),
        agents=[
            LiveAgent(
                agent_id=row.agent_id,
                agent_label=row.agent_label,
                session_id=row.id,
                run_id=row.run_id,
                started_at=row.started_at,
                last_seen_at=row.last_seen_at,
            )
            for row in live_rows[:OVERVIEW_AGENTS_MAX]
        ],
        last_activity_at=max(moments) if moments else None,
        tasks=TaskProgress(total=total, finished=finished, by_status=by_status),
        pending_reviews=pending_reviews or 0,
        warnings=warnings,
    )


# --- results ------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ResultCard:
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


@dataclass(frozen=True, slots=True)
class ResultPage:
    items: list[ResultCard]
    total: int
    limit: int
    offset: int
    status_counts: dict[str, int]


def _proposal_facts(proposal: Any, raw: Any) -> tuple[str | None, int | None, int, int, int]:
    """`(summary, confidence, items, refused, sources)` read defensively from a stored proposal.

    Historical results predate the per-item evidence fields and some shapes (staged actions) carry
    no `confidence` or `notes`: missing data is read as unknown (`None` / 0), never invented. The
    global confidence falls back to the raw payload's, then to `None`.
    """
    proposal = proposal if isinstance(proposal, dict) else {}
    items = proposal.get("items")
    items = items if isinstance(items, list) else []
    refused = proposal.get("refused")
    notes = proposal.get("notes")
    summary = notes.strip() if isinstance(notes, str) and notes.strip() else None
    if summary is not None and len(summary) > SUMMARY_MAX_LENGTH:
        summary = summary[: SUMMARY_MAX_LENGTH - 1].rstrip() + "…"
    confidence = proposal.get("confidence")
    if not isinstance(confidence, int) or isinstance(confidence, bool):
        raw_confidence = raw.get("confidence") if isinstance(raw, dict) else None
        confidence = (
            raw_confidence
            if isinstance(raw_confidence, int) and not isinstance(raw_confidence, bool)
            else None
        )
    sources = {
        item["source"].strip()
        for item in items
        if isinstance(item, dict) and isinstance(item.get("source"), str) and item["source"].strip()
    }
    return (
        summary,
        confidence,
        len(items),
        len(refused) if isinstance(refused, list) else 0,
        len(sources),
    )


def _subject_labels(session: Session, rows: Sequence[Any]) -> dict[uuid.UUID, str]:
    company_ids = {task.company_id for _, task in rows if task.company_id is not None}
    prospect_ids = {task.prospect_id for _, task in rows if task.prospect_id is not None}
    labels: dict[uuid.UUID, str] = {}
    if company_ids:
        for company in session.scalars(select(Company).where(Company.id.in_(company_ids))):
            labels[company.id] = company.display_name
    if prospect_ids:
        for prospect in session.scalars(select(Prospect).where(Prospect.id.in_(prospect_ids))):
            name = " ".join(part for part in (prospect.first_name, prospect.last_name) if part)
            if name:
                labels[prospect.id] = name
    return labels


def list_results(
    session: Session,
    mission: Mission,
    *,
    statuses: Sequence[AgentResultStatus] = (),
    agent_id: str | None = None,
    run_id: uuid.UUID | None = None,
    limit: int = RESULTS_DEFAULT_LIMIT,
    offset: int = 0,
) -> ResultPage:
    """Review-queue cards of the mission, `submitted_at` descending, offset-paginated with a total.

    The full payload stays behind the existing review endpoint; a card carries the summary
    (the agent's notes), the global confidence, item and source counts. `status_counts` ignores the
    `status` filter so the tabs can show every count at once.
    """
    size = max(1, min(limit, RESULTS_MAX_LIMIT))
    start = max(0, offset)
    base = _results_scope(mission.id)
    if agent_id is not None:
        base = base.where(AgentTaskResult.submitted_by_id == agent_id)
    if run_id is not None:
        base = base.where(AgentTask.run_id == run_id)
    filtered = base
    if statuses:
        filtered = base.where(AgentTaskResult.status.in_(list(statuses)))
    total = session.scalar(select(func.count()).select_from(filtered.subquery())) or 0
    counts = {status.value: 0 for status in AgentResultStatus}
    scoped = base.subquery()
    for status, count in session.execute(
        select(scoped.c.status, func.count()).group_by(scoped.c.status)
    ).all():
        counts[getattr(status, "value", status)] = count
    rows = session.execute(
        filtered.with_only_columns(AgentTaskResult, AgentTask)
        .order_by(AgentTaskResult.submitted_at.desc(), AgentTaskResult.id.desc())
        .limit(size)
        .offset(start)
    ).all()
    labels = _subject_labels(session, rows)
    cards: list[ResultCard] = []
    for result, task in rows:
        summary, confidence, items, refused, sources = _proposal_facts(result.proposal, result.raw)
        subject = task.company_id if task.company_id is not None else task.prospect_id
        assert task.run_id is not None  # `_results_scope` keeps only tasks of the mission's runs
        cards.append(
            ResultCard(
                id=result.id,
                task_id=task.id,
                run_id=task.run_id,
                task_type=task.type,
                status=result.status,
                agent_id=result.submitted_by_id,
                agent_label=result.submitted_by_label,
                subject_label=labels.get(subject) if subject is not None else None,
                summary=summary,
                confidence=confidence,
                items_count=items,
                refused_count=refused,
                sources_count=sources,
                submitted_at=result.submitted_at,
                decided_at=result.decided_at,
                decided_by=result.decided_by_display,
            )
        )
    return ResultPage(items=cards, total=total, limit=size, offset=start, status_counts=counts)


# --- statistics ---------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ResultsPoint:
    bucket: datetime
    pending_review: int = 0
    accepted: int = 0
    rejected: int = 0
    superseded: int = 0


@dataclass(frozen=True, slots=True)
class CountPoint:
    bucket: datetime
    count: int


@dataclass(frozen=True, slots=True)
class AgentStats:
    agent_id: str
    agent_label: str
    sessions: int = 0
    logs: int = 0
    results: int = 0
    accepted: int = 0
    rejected: int = 0
    pending_review: int = 0


@dataclass(frozen=True, slots=True)
class Statistics:
    bucket: Bucket
    days: int
    since: datetime
    until: datetime
    results_by_status: dict[str, int]
    tasks_by_status: dict[str, int]
    sessions_by_status: dict[str, int]
    logs_by_event_type: dict[str, int]
    results_series: list[ResultsPoint]
    sessions_series: list[CountPoint]
    logs_series: list[CountPoint]
    decided_count: int
    acceptance_rate: float | None
    avg_review_seconds: float | None
    agents: list[AgentStats] = field(default_factory=list)


def _floor(moment: datetime, bucket: Bucket) -> datetime:
    moment = moment.astimezone(UTC)
    if bucket == "hour":
        return moment.replace(minute=0, second=0, microsecond=0)
    return moment.replace(hour=0, minute=0, second=0, microsecond=0)


def _bucket_expr(column: Any, bucket: Bucket) -> Any:
    # UTC wall-clock, then truncated: buckets never depend on the database session time zone.
    return func.date_trunc(bucket, func.timezone("UTC", column))


def statistics(
    session: Session,
    mission: Mission,
    *,
    bucket: Bucket = "day",
    days: int = STATS_DEFAULT_DAYS,
    now: datetime | None = None,
) -> Statistics:
    """Aggregates and time series of a mission, all computed by the database.

    Totals (`*_by_status`, review figures, `agents`) cover the whole mission; the three series cover
    the last `days` days, one point per bucket (empty buckets are zero, so a chart is continuous).
    """
    if days < 1 or days > STATS_MAX_DAYS:
        raise InvalidFieldError("days", f"Between 1 and {STATS_MAX_DAYS}.", "range")
    if bucket == "hour" and days > STATS_MAX_HOURLY_DAYS:
        raise InvalidFieldError(
            "days", f"At most {STATS_MAX_HOURLY_DAYS} days with hourly buckets.", "range"
        )
    until = now or datetime.now(UTC)
    since = _floor(until - timedelta(days=days), bucket)
    step = timedelta(hours=1) if bucket == "hour" else timedelta(days=1)
    starts: list[datetime] = []
    cursor = since
    while cursor <= until:
        starts.append(cursor)
        cursor += step

    run_ids = _mission_run_ids(mission.id)
    tasks_by_status = _task_counts(session, run_ids)

    result_status = {status.value: 0 for status in AgentResultStatus}
    scope = _results_scope(mission.id).subquery()
    for status, count in session.execute(
        select(scope.c.status, func.count()).group_by(scope.c.status)
    ).all():
        result_status[getattr(status, "value", status)] = count

    sessions_status = {status.value: 0 for status in MissionAgentSessionStatus}
    for status, count in session.execute(
        select(MissionAgentSession.status, func.count())
        .where(MissionAgentSession.mission_id == mission.id)
        .group_by(MissionAgentSession.status)
    ).all():
        sessions_status[status.value] = count

    events = {event.value: 0 for event in MissionAgentLogEvent}
    for event, count in session.execute(
        select(MissionAgentLog.event_type, func.count())
        .where(MissionAgentLog.mission_id == mission.id)
        .group_by(MissionAgentLog.event_type)
    ).all():
        events[event.value] = count

    # Series: only the buckets that have rows come back; the gaps are filled with zero.
    result_bucket = _bucket_expr(AgentTaskResult.submitted_at, bucket)
    by_bucket: dict[datetime, dict[str, int]] = defaultdict(dict)
    for moment, status, count in session.execute(
        _results_scope(mission.id)
        .where(AgentTaskResult.submitted_at >= since)
        .with_only_columns(result_bucket, AgentTaskResult.status, func.count())
        .group_by(result_bucket, AgentTaskResult.status)
        .order_by(None)
    ).all():
        by_bucket[_utc(moment) or since][status.value] = count
    results_series = [ResultsPoint(start, **by_bucket.get(start, {})) for start in starts]

    session_bucket = _bucket_expr(MissionAgentSession.started_at, bucket)
    sessions_counts = {
        _utc(moment): count
        for moment, count in session.execute(
            select(session_bucket, func.count())
            .where(
                MissionAgentSession.mission_id == mission.id,
                MissionAgentSession.started_at >= since,
            )
            .group_by(session_bucket)
        ).all()
    }
    log_bucket = _bucket_expr(MissionAgentLog.created_at, bucket)
    logs_counts = {
        _utc(moment): count
        for moment, count in session.execute(
            select(log_bucket, func.count())
            .where(MissionAgentLog.mission_id == mission.id, MissionAgentLog.created_at >= since)
            .group_by(log_bucket)
        ).all()
    }

    decided = session.execute(
        _results_scope(mission.id)
        .where(AgentTaskResult.status.in_((AgentResultStatus.ACCEPTED, AgentResultStatus.REJECTED)))
        .with_only_columns(
            func.count(),
            func.count().filter(AgentTaskResult.status == AgentResultStatus.ACCEPTED),
            func.avg(
                func.extract("epoch", AgentTaskResult.decided_at - AgentTaskResult.submitted_at)
            ),
        )
        .order_by(None)
    ).one()
    decided_count, accepted_count, avg_seconds = decided

    return Statistics(
        bucket=bucket,
        days=days,
        since=since,
        until=until,
        results_by_status=result_status,
        tasks_by_status=tasks_by_status,
        sessions_by_status=sessions_status,
        logs_by_event_type=events,
        results_series=results_series,
        sessions_series=[CountPoint(start, sessions_counts.get(start, 0)) for start in starts],
        logs_series=[CountPoint(start, logs_counts.get(start, 0)) for start in starts],
        decided_count=decided_count,
        acceptance_rate=(accepted_count / decided_count) if decided_count else None,
        avg_review_seconds=float(avg_seconds) if avg_seconds is not None else None,
        agents=_agent_stats(session, mission.id),
    )


def _agent_stats(session: Session, mission_id: uuid.UUID) -> list[AgentStats]:
    """Per-agent counts (sessions, logs, results by decision), merged by `agent_id`. Three grouped
    queries; the agent set is the handful of tokens that worked the mission."""
    labels: dict[str, str] = {}
    sessions: dict[str, int] = {}
    for agent, label, count in session.execute(
        select(
            MissionAgentSession.agent_id,
            func.max(MissionAgentSession.agent_label),
            func.count(),
        )
        .where(MissionAgentSession.mission_id == mission_id)
        .group_by(MissionAgentSession.agent_id)
    ).all():
        labels[agent] = label
        sessions[agent] = count
    logs: dict[str, int] = {
        agent: count
        for agent, count in session.execute(
            select(MissionAgentLog.agent_id, func.count())
            .where(MissionAgentLog.mission_id == mission_id)
            .group_by(MissionAgentLog.agent_id)
        ).all()
    }
    results: dict[str, dict[str, int]] = defaultdict(dict)
    for agent, label, status, count in session.execute(
        _results_scope(mission_id)
        .with_only_columns(
            AgentTaskResult.submitted_by_id,
            func.max(AgentTaskResult.submitted_by_label),
            AgentTaskResult.status,
            func.count(),
        )
        .where(AgentTaskResult.submitted_by_id.is_not(None))
        .group_by(AgentTaskResult.submitted_by_id, AgentTaskResult.status)
        .order_by(None)
    ).all():
        labels.setdefault(agent, label)
        results[agent][status.value] = count
    agents = set(sessions) | set(logs) | set(results)
    return [
        AgentStats(
            agent_id=agent,
            agent_label=labels.get(agent, agent),
            sessions=sessions.get(agent, 0),
            logs=logs.get(agent, 0),
            results=sum(results[agent].values()) if agent in results else 0,
            accepted=results[agent].get(AgentResultStatus.ACCEPTED.value, 0)
            if agent in results
            else 0,
            rejected=results[agent].get(AgentResultStatus.REJECTED.value, 0)
            if agent in results
            else 0,
            pending_review=(
                results[agent].get(AgentResultStatus.PENDING_REVIEW.value, 0)
                if agent in results
                else 0
            ),
        )
        for agent in sorted(agents, key=lambda key: (labels.get(key, key), key))
    ]
