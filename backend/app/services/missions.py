"""Missions: create the rule, launch a run, and read the cards the page shows.

A mission is persistent; a **run** is one execution and owns the tasks an agent claims. The
consigne is never copied into a task: the task carries a `run_id` and a subject id, and the MCP
payload re-reads the mission and the live record at claim time. Nothing here applies a result.

Contract: `doc/architecture/missions.md`.
"""

import calendar
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models.agent_missions import AgentTask, AgentTaskResult
from app.models.companies import Company
from app.models.enums import (
    AgentResultStatus,
    AgentTaskStatus,
    AgentTaskType,
    MissionEndKind,
    MissionResultKind,
    MissionRunStatus,
    MissionRunTrigger,
    MissionStatus,
    MissionType,
    RecurrenceUnit,
)
from app.models.mcp import McpToken
from app.models.missions import Mission, MissionRun, MissionTarget
from app.models.prospects import Prospect
from app.services import agent_missions, audit, companies, mcp_reads
from app.services.errors import ConflictError, DomainError, InvalidFieldError, NotFoundError

# Types whose execution maps to the result schemas that exist today. Discovery and signals need
# their `find_*` / `surveil_signals` schemas (agent-missions.md §5, phase 2): the modal says so.
EXECUTABLE_TYPES = frozenset(
    {
        MissionType.PROSPECTION,
        MissionType.SIGNALS,
        MissionType.ENRICHMENT,
        MissionType.VERIFICATION,
        MissionType.OTHER,
    }
)
EXECUTABLE_RESULT_KINDS = frozenset(
    {
        MissionResultKind.ENRICHMENT,
        MissionResultKind.COMPANIES,
        MissionResultKind.PROSPECTS,
        MissionResultKind.SIGNALS,
    }
)
DEFAULT_RESULT_LIMIT = 20
RESULT_LIMIT_MAX = 500
OPEN_TASK_STATUSES = (
    AgentTaskStatus.PENDING,
    AgentTaskStatus.CLAIMED,
    AgentTaskStatus.SUBMITTED,
)
TERMINAL_TASK_STATUSES = (
    AgentTaskStatus.ACCEPTED,
    AgentTaskStatus.FAILED,
    AgentTaskStatus.CANCELLED,
)


@dataclass(frozen=True, slots=True)
class TargetInput:
    company_id: uuid.UUID | None = None
    prospect_id: uuid.UUID | None = None


@dataclass(frozen=True, slots=True)
class MissionInput:
    name: str
    type: MissionType
    prompt: str
    targets: tuple[TargetInput, ...] = ()
    agent_id: uuid.UUID | None = None
    is_recurring: bool = False
    interval_count: int = 1
    interval_unit: RecurrenceUnit = RecurrenceUnit.DAYS
    starts_at: datetime | None = None
    end_kind: MissionEndKind = MissionEndKind.NEVER
    ends_at: datetime | None = None
    max_runs: int | None = None
    result_kind: MissionResultKind = MissionResultKind.ENRICHMENT
    result_limit: int = DEFAULT_RESULT_LIMIT
    geography: str | None = None
    period_days: int | None = None
    exclusions: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class MissionCard:
    id: uuid.UUID
    name: str
    type: MissionType
    status: MissionStatus
    agent_label: str | None
    prompt: str
    is_recurring: bool
    interval_count: int
    interval_unit: RecurrenceUnit
    targets_count: int
    runs_count: int
    last_run_at: datetime | None
    last_run_status: MissionRunStatus | None
    last_run_results: int
    next_run_at: datetime | None
    tasks_total: int
    tasks_done: int
    results_pending: int
    created_at: datetime


@dataclass(frozen=True, slots=True)
class TargetRow:
    kind: str
    id: uuid.UUID
    label: str
    hint: str | None


@dataclass(frozen=True, slots=True)
class RunRow:
    id: uuid.UUID
    status: MissionRunStatus
    trigger: MissionRunTrigger
    scheduled_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    tasks_total: int
    results_count: int
    note: str | None


@dataclass(frozen=True, slots=True)
class ProposalRow:
    result_id: uuid.UUID
    task_type: AgentTaskType
    submitted_by_label: str
    submitted_at: datetime
    subject_label: str | None


@dataclass(frozen=True, slots=True)
class MissionTaskRow:
    id: uuid.UUID
    type: AgentTaskType
    status: AgentTaskStatus
    company_id: uuid.UUID | None
    prospect_id: uuid.UUID | None
    prospect_name: str | None
    claimed_by_label: str | None
    assigned_agent_id: uuid.UUID | None
    attempts: int
    max_attempts: int
    result_id: uuid.UUID | None
    submitted_at: datetime | None


@dataclass(frozen=True, slots=True)
class MissionDetail:
    card: MissionCard
    targets: list[TargetRow]
    runs: list[RunRow]
    tasks: list[MissionTaskRow]
    prompt: str
    result_kind: MissionResultKind
    result_limit: int


def _now(now: datetime | None) -> datetime:
    return now or datetime.now(UTC)


def _text(field_name: str, value: str, max_length: int) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise InvalidFieldError(field_name, "A value is required.", "empty")
    if len(cleaned) > max_length:
        raise InvalidFieldError(field_name, f"At most {max_length} characters.", "too_long")
    return cleaned


def _target_rows(session: Session, mission_id: uuid.UUID) -> list[TargetRow]:
    rows: list[TargetRow] = []
    pairs = session.execute(
        select(MissionTarget.company_id, MissionTarget.prospect_id).where(
            MissionTarget.mission_id == mission_id
        )
    ).all()
    company_ids = [company_id for company_id, _ in pairs if company_id is not None]
    prospect_ids = [prospect_id for _, prospect_id in pairs if prospect_id is not None]
    companies_by_id = {
        company.id: company.display_name
        for company in session.scalars(select(Company).where(Company.id.in_(company_ids)))
    }
    prospects_by_id = {
        prospect.id: prospect
        for prospect in session.scalars(select(Prospect).where(Prospect.id.in_(prospect_ids)))
    }
    prospect_companies = {
        company.id: company.display_name
        for company in session.scalars(
            select(Company).where(
                Company.id.in_(
                    {
                        prospect.company_id
                        for prospect in prospects_by_id.values()
                        if prospect.company_id is not None
                    }
                )
            )
        )
    }
    for company_id, prospect_id in pairs:
        if company_id is not None:
            rows.append(
                TargetRow(
                    kind="company",
                    id=company_id,
                    label=companies_by_id.get(company_id, "Société supprimée"),
                    hint=None,
                )
            )
        elif prospect_id is not None:
            prospect = prospects_by_id.get(prospect_id)
            if prospect is None:
                continue
            name = " ".join(
                part for part in (prospect.first_name, prospect.last_name) if part
            ) or "Prospect sans nom"
            company_name = (
                prospect_companies.get(prospect.company_id)
                if prospect.company_id is not None
                else None
            )
            rows.append(
                TargetRow(
                    kind="prospect",
                    id=prospect_id,
                    label=name,
                    hint=company_name,
                )
            )
    rows.sort(key=lambda row: row.label.casefold())
    return rows


def _task_rows(session: Session, mission_id: uuid.UUID) -> list[MissionTaskRow]:
    runs = select(MissionRun.id).where(MissionRun.mission_id == mission_id).scalar_subquery()
    tasks = session.scalars(
        select(AgentTask).where(AgentTask.run_id.in_(runs)).order_by(AgentTask.created_at)
    ).all()
    result_ids = {
        result.task_id: result.id
        for result in session.scalars(
            select(AgentTaskResult).where(AgentTaskResult.task_id.in_([task.id for task in tasks]))
        )
    }
    prospect_ids = {task.prospect_id for task in tasks if task.prospect_id is not None}
    names = {
        prospect.id: " ".join(
            part for part in (prospect.first_name, prospect.last_name) if part
        )
        for prospect in session.scalars(select(Prospect).where(Prospect.id.in_(prospect_ids)))
    }
    rows = [
        MissionTaskRow(
            id=task.id,
            type=task.type,
            status=task.status,
            company_id=task.company_id,
            prospect_id=task.prospect_id,
            prospect_name=names.get(task.prospect_id) if task.prospect_id else None,
            claimed_by_label=task.claimed_by_label,
            assigned_agent_id=task.assigned_agent_id,
            attempts=task.attempts,
            max_attempts=task.max_attempts,
            result_id=result_ids.get(task.id),
            submitted_at=task.updated_at if task.status is AgentTaskStatus.SUBMITTED else None,
        )
        for task in tasks
    ]
    return rows


def _counts(session: Session, mission_id: uuid.UUID) -> tuple[int, int, int]:
    """`(tasks_total, tasks_done, results_pending)` for the card, in two statements."""
    runs = select(MissionRun.id).where(MissionRun.mission_id == mission_id).scalar_subquery()
    tasks = session.execute(
        select(AgentTask.status, func.count())
        .where(AgentTask.run_id.in_(runs))
        .group_by(AgentTask.status)
    ).all()
    by_status = {status: count for status, count in tasks}
    total = sum(by_status.values())
    done = by_status.get(AgentTaskStatus.ACCEPTED, 0)
    pending = by_status.get(AgentTaskStatus.SUBMITTED, 0)
    return total, done, pending


def _card(session: Session, mission: Mission) -> MissionCard:
    runs_count = session.scalar(
        select(func.count()).select_from(MissionRun).where(MissionRun.mission_id == mission.id)
    )
    last_run = session.scalars(
        select(MissionRun)
        .where(MissionRun.mission_id == mission.id)
        .order_by(MissionRun.scheduled_at.desc())
        .limit(1)
    ).first()
    if last_run is not None:
        refresh_run(session, last_run)
    targets_count = session.scalar(
        select(func.count())
        .select_from(MissionTarget)
        .where(MissionTarget.mission_id == mission.id)
    )
    total, done, pending = _counts(session, mission.id)
    return MissionCard(
        id=mission.id,
        name=mission.name,
        type=mission.type,
        status=mission.status,
        agent_label=mission.agent_label,
        prompt=mission.prompt,
        is_recurring=mission.is_recurring,
        interval_count=mission.interval_count,
        interval_unit=mission.interval_unit,
        targets_count=targets_count or 0,
        runs_count=runs_count or 0,
        last_run_at=last_run.scheduled_at if last_run is not None else None,
        last_run_status=last_run.status if last_run is not None else None,
        last_run_results=last_run.results_count if last_run is not None else 0,
        next_run_at=mission.next_run_at,
        tasks_total=total,
        tasks_done=done,
        results_pending=pending,
        created_at=mission.created_at,
    )


def list_cards(session: Session, *, status: MissionStatus | None = None) -> list[MissionCard]:
    statement = select(Mission)
    if status is not None:
        statement = statement.where(Mission.status == status)
    missions = session.scalars(
        statement.order_by(
            Mission.status.asc(), Mission.created_at.desc()
        )
    ).all()
    return [_card(session, mission) for mission in missions]


def detail(session: Session, mission_id: uuid.UUID) -> MissionDetail:
    mission = session.get(Mission, mission_id)
    if mission is None:
        raise NotFoundError("Unknown mission.")
    card = _card(session, mission)
    runs = [
        RunRow(
            id=run.id,
            status=run.status,
            trigger=run.trigger,
            scheduled_at=run.scheduled_at,
            started_at=run.started_at,
            finished_at=run.finished_at,
            tasks_total=run.tasks_total,
            results_count=run.results_count,
            note=run.note,
        )
        for run in session.scalars(
            select(MissionRun)
            .where(MissionRun.mission_id == mission.id)
            .order_by(MissionRun.scheduled_at.desc())
        )
    ]
    return MissionDetail(
        card=card,
        targets=_target_rows(session, mission.id),
        runs=runs,
        tasks=_task_rows(session, mission.id),
        prompt=mission.prompt,
        result_kind=mission.result_kind,
        result_limit=mission.result_limit,
    )


def add_months(moment: datetime, months: int) -> datetime:
    month = moment.month - 1 + months
    year = moment.year + month // 12
    month = month % 12 + 1
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


def add_interval(moment: datetime, count: int, unit: RecurrenceUnit) -> datetime:
    match unit:
        case RecurrenceUnit.HOURS:
            return moment + timedelta(hours=count)
        case RecurrenceUnit.DAYS:
            return moment + timedelta(days=count)
        case RecurrenceUnit.WEEKS:
            return moment + timedelta(weeks=count)
        case RecurrenceUnit.MONTHS:
            return add_months(moment, count)


def next_occurrence(mission: Mission, after: datetime, *, runs_count: int = 0) -> datetime | None:
    """The next moment the recurrence fires, or None for a one-off (or an exhausted run count)."""
    if not mission.is_recurring:
        return None
    if (
        mission.end_kind is MissionEndKind.DATE
        and mission.ends_at is not None
        and after >= mission.ends_at
    ):
        return None
    if (
        mission.end_kind is MissionEndKind.AFTER
        and mission.max_runs is not None
        and runs_count >= mission.max_runs
    ):
        return None
    base = mission.starts_at or after
    moment = base
    guard = 0
    while moment <= after and guard < 10_000:
        moment = add_interval(moment, mission.interval_count, mission.interval_unit)
        guard += 1
    return moment


def _validate(data: MissionInput, now: datetime) -> None:
    """Shape checks only: a type whose schema is not ready can be saved, not launched."""
    if not 1 <= data.result_limit <= RESULT_LIMIT_MAX:
        raise InvalidFieldError("result_limit", "Between 1 and 500.", "range")
    if data.is_recurring:
        if data.interval_count < 1:
            raise InvalidFieldError("interval_count", "At least 1.", "range")
        if data.end_kind is MissionEndKind.DATE and data.ends_at is None:
            raise InvalidFieldError("ends_at", "A date is required.", "missing")
        if data.end_kind is MissionEndKind.AFTER and (data.max_runs or 0) < 1:
            raise InvalidFieldError("max_runs", "At least 1 run.", "range")
    if (
        data.end_kind is MissionEndKind.DATE
        and data.ends_at is not None
        and data.ends_at <= now
    ):
        raise InvalidFieldError("ends_at", "The end must be in the future.", "range")



def _create_targets(
    session: Session, mission: Mission, targets: tuple[TargetInput, ...]
) -> None:
    seen: set[tuple[str, uuid.UUID]] = set()
    for target in targets:
        if (target.company_id is None) == (target.prospect_id is None):
            raise InvalidFieldError("targets", "Exactly one subject per target.", "invalid")
        if target.company_id is not None:
            if session.get(Company, target.company_id) is None:
                raise NotFoundError("Unknown company.")
            key = ("company", target.company_id)
        else:
            assert target.prospect_id is not None
            if session.get(Prospect, target.prospect_id) is None:
                raise NotFoundError("Unknown prospect.")
            key = ("prospect", target.prospect_id)
        if key in seen:
            continue
        seen.add(key)
        session.add(
            MissionTarget(
                mission_id=mission.id,
                company_id=target.company_id,
                prospect_id=target.prospect_id,
            )
        )
    session.flush()


def create(
    session: Session,
    actor: ActorContext,
    data: MissionInput,
    *,
    run_now: bool,
    now: datetime | None = None,
) -> Mission:
    moment = _now(now)
    name = _text("name", data.name, 200)
    prompt = _text("prompt", data.prompt, 5000)
    _validate(data, moment)
    token: McpToken | None = None
    if data.agent_id is not None:
        token = session.get(McpToken, data.agent_id)
        if token is None or token.revoked_at is not None:
            raise InvalidFieldError("agent_id", "Unknown or revoked agent.", "not_found")
    starts_at = data.starts_at or moment
    next_run_at: datetime | None
    if data.is_recurring:
        # « Démarrer maintenant »: a start in the past (or omitted) is due immediately, so the
        # scheduler picks it up on its next pass; a future start waits for its moment.
        next_run_at = starts_at if starts_at > moment else moment
    else:
        next_run_at = starts_at if starts_at > moment else None
    mission = Mission(
        name=name,
        type=data.type,
        prompt=prompt,
        status=MissionStatus.ACTIVE,
        agent_id=data.agent_id,
        agent_label=token.label if token is not None else None,
        is_recurring=data.is_recurring,
        interval_count=data.interval_count,
        interval_unit=data.interval_unit,
        starts_at=starts_at,
        end_kind=data.end_kind,
        ends_at=data.ends_at,
        max_runs=data.max_runs,
        result_kind=data.result_kind,
        result_limit=data.result_limit,
        geography=(data.geography or "").strip() or None,
        period_days=data.period_days,
        exclusions=data.exclusions,
        next_run_at=next_run_at,
        created_by_type=actor.type,
        created_by_id=actor.id,
        created_by_display=actor.display,
    )
    session.add(mission)
    session.flush()
    _create_targets(session, mission, data.targets)
    audit.record_event(
        session,
        actor,
        audit.AuditAction.MISSION_CREATED,
        entity_type="mission",
        entity_id=mission.id,
        changes={
            "name": {"after": mission.name},
            "type": {"after": mission.type.value},
        },
    )
    if run_now:
        run_mission(session, actor, mission.id, trigger=MissionRunTrigger.MANUAL, now=moment)
    return mission


def _open_tasks(session: Session, mission_id: uuid.UUID) -> bool:
    runs = select(MissionRun.id).where(MissionRun.mission_id == mission_id).scalar_subquery()
    count = session.scalar(
        select(func.count())
        .select_from(AgentTask)
        .where(
            AgentTask.run_id.in_(runs),
            AgentTask.status.in_(OPEN_TASK_STATUSES),
        )
    )
    return bool(count)


def refresh_run(session: Session, run: MissionRun) -> MissionRun:
    """Derive a run's status and counts from its tasks (no second source of truth)."""
    tasks = session.scalars(select(AgentTask).where(AgentTask.run_id == run.id)).all()
    run.tasks_total = len(tasks)
    if not tasks:
        return run
    statuses = [task.status for task in tasks]
    results = session.scalar(
        select(func.count())
        .select_from(AgentTaskResult)
        .where(AgentTaskResult.task_id.in_([task.id for task in tasks]))
    )
    run.results_count = results or 0
    if any(status in OPEN_TASK_STATUSES for status in statuses):
        run.status = MissionRunStatus.RUNNING
        run.finished_at = None
    else:
        if run.status is not MissionRunStatus.CANCELLED:
            run.status = MissionRunStatus.DONE
            if run.finished_at is None:
                run.finished_at = max(
                    (task.updated_at for task in tasks), default=run.started_at or run.scheduled_at
                )
    return run


def run_mission(
    session: Session,
    actor: ActorContext,
    mission_id: uuid.UUID,
    *,
    trigger: MissionRunTrigger = MissionRunTrigger.MANUAL,
    now: datetime | None = None,
) -> MissionRun:
    moment = _now(now)
    mission = session.scalar(select(Mission).where(Mission.id == mission_id).with_for_update())
    if mission is None:
        raise NotFoundError("Unknown mission.")
    if mission.status is not MissionStatus.ACTIVE:
        raise ConflictError("This mission is not active.")
    if mission.type not in EXECUTABLE_TYPES:
        raise InvalidFieldError(
            "type",
            "Ce type de mission n’est pas encore exécutable : la découverte et les signaux "
            "arrivent avec leurs schémas de résultat.",
            "unsupported",
        )
    if mission.result_kind not in EXECUTABLE_RESULT_KINDS:
        raise InvalidFieldError(
            "result_kind",
            "Ce résultat attendu n’est pas encore pris en charge (signaux : phase 2).",
            "unsupported",
        )
    targets = _target_rows(session, mission.id)
    discovery = not targets
    if mission.type is MissionType.SIGNALS:
        if mission.result_kind is not MissionResultKind.SIGNALS:
            raise InvalidFieldError(
                "result_kind",
                "Une mission de signaux attend le résultat « Signaux ».",
                "unsupported",
            )
        if discovery or not any(target.kind == "company" for target in targets):
            raise InvalidFieldError(
                "targets",
                "Ajoutez au moins une société à surveiller.",
                "empty",
            )
    elif discovery:
        if (
            mission.type is not MissionType.PROSPECTION
            or mission.result_kind is not MissionResultKind.COMPANIES
        ):
            raise InvalidFieldError(
                "targets",
                "Ajoutez des données liées : cette mission travaille sur des fiches existantes.",
                "empty",
            )
    elif mission.type is MissionType.PROSPECTION:
        if mission.result_kind is not MissionResultKind.PROSPECTS:
            raise InvalidFieldError(
                "result_kind",
                "Avec des sociétés liées, la prospection cherche des contacts : "
                "choisissez « Prospects ».",
                "unsupported",
            )
        if not any(target.kind == "company" for target in targets):
            raise InvalidFieldError(
                "targets",
                "Ajoutez au moins une société à explorer.",
                "empty",
            )
    run = MissionRun(
        mission_id=mission.id,
        status=MissionRunStatus.RUNNING,
        trigger=trigger,
        scheduled_at=moment,
        started_at=moment,
    )
    session.add(run)
    session.flush()
    created = 0
    skipped: list[str] = []
    if discovery:
        _task(
            session,
            actor,
            mission,
            run,
            AgentTaskType.FIND_PROSPECTS,
            company_id=None,
            prospect_id=None,
        )
        created = 1
    elif mission.type is MissionType.SIGNALS:
        company_ids = [target.id for target in targets if target.kind == "company"]
        for company_id in company_ids:
            _task(
                session,
                actor,
                mission,
                run,
                AgentTaskType.SURVEIL_SIGNALS,
                company_id=company_id,
                prospect_id=None,
            )
            created += 1
    elif mission.type is MissionType.PROSPECTION:
        company_ids = [target.id for target in targets if target.kind == "company"]
        for company_id in company_ids:
            _task(
                session,
                actor,
                mission,
                run,
                AgentTaskType.FIND_EMPLOYEES,
                company_id=company_id,
                prospect_id=None,
            )
            created += 1
    else:
        for target in targets:
            if target.kind == "company":
                _task(
                    session,
                    actor,
                    mission,
                    run,
                    AgentTaskType.UPDATE_COMPANY,
                    company_id=target.id,
                    prospect_id=None,
                )
                created += 1
            else:
                prospect = session.get(Prospect, target.id)
                if prospect is None or prospect.company_id is None:
                    skipped.append(target.label)
                    continue
                _task(
                    session,
                    actor,
                    mission,
                    run,
                    AgentTaskType.UPDATE_EMPLOYEE,
                    company_id=prospect.company_id,
                    prospect_id=prospect.id,
                )
                created += 1
    run.tasks_total = created
    if created == 0:
        run.status = MissionRunStatus.FAILED
        run.note = "Aucune tâche exécutable sur ces données liées."
    if skipped:
        run.note = "Sans société, ignorés : " + ", ".join(skipped)
    mission.last_run_at = moment
    runs_count = session.scalar(
        select(func.count()).select_from(MissionRun).where(MissionRun.mission_id == mission.id)
    )
    mission.next_run_at = next_occurrence(mission, moment, runs_count=runs_count or 0)
    if mission.next_run_at is None and mission.is_recurring:
        # The recurrence is exhausted (end date or run count).
        mission.status = MissionStatus.DONE
    session.flush()
    audit.record_event(
        session,
        actor,
        audit.AuditAction.MISSION_RUN_STARTED,
        entity_type="mission_run",
        entity_id=run.id,
        subject=("mission", mission.id),
        changes={"tasks": {"after": created}},
    )
    return run


# The recurrence runs as VIPER itself: no person is behind a scheduled execution.
SCHEDULER_ACTOR = ActorContext(
    type=ActorType.SYSTEM, display="VIPER — missions", id="mission-scheduler"
)


def run_due(
    session: Session, *, now: datetime | None = None, limit: int = 20
) -> list[MissionRun]:
    """Start the runs whose `next_run_at` is due. Called by the scheduler worker and by tests.

    Each mission is locked `SKIP LOCKED`: two scheduler passes never start the same run. A mission
    whose recurrence is exhausted (end date or max runs) closes; a mission whose type cannot run
    yet is paused rather than retried forever.
    """
    moment = _now(now)
    due = session.scalars(
        select(Mission)
        .where(
            Mission.status == MissionStatus.ACTIVE,
            Mission.is_recurring.is_(True),
            Mission.next_run_at.is_not(None),
            Mission.next_run_at <= moment,
        )
        .order_by(Mission.next_run_at)
        .limit(limit)
        .with_for_update(skip_locked=True)
    ).all()
    started: list[MissionRun] = []
    for mission in due:
        runs_count = session.scalar(
            select(func.count()).select_from(MissionRun).where(MissionRun.mission_id == mission.id)
        )
        if (
            mission.end_kind is MissionEndKind.DATE
            and mission.ends_at is not None
            and moment >= mission.ends_at
        ) or (
            mission.end_kind is MissionEndKind.AFTER
            and mission.max_runs is not None
            and (runs_count or 0) >= mission.max_runs
        ):
            mission.status = MissionStatus.DONE
            mission.next_run_at = None
            audit.record_event(
                session,
                SCHEDULER_ACTOR,
                audit.AuditAction.MISSION_STATUS_CHANGED,
                entity_type="mission",
                entity_id=mission.id,
                changes={"status": {"before": "active", "after": "done"}},
                reason="recurrence exhausted",
            )
            continue
        try:
            started.append(
                run_mission(
                    session,
                    SCHEDULER_ACTOR,
                    mission.id,
                    trigger=MissionRunTrigger.SCHEDULE,
                    now=moment,
                )
            )
        except DomainError:
            # The type cannot run yet (discovery/signals): stop the recurrence instead of
            # retrying every minute forever.
            mission.status = MissionStatus.PAUSED
            mission.next_run_at = None
            audit.record_event(
                session,
                SCHEDULER_ACTOR,
                audit.AuditAction.MISSION_STATUS_CHANGED,
                entity_type="mission",
                entity_id=mission.id,
                changes={"status": {"before": "active", "after": "paused"}},
                reason="type not executable",
            )
    return started


def _task(
    session: Session,
    actor: ActorContext,
    mission: Mission,
    run: MissionRun,
    task_type: AgentTaskType,
    *,
    company_id: uuid.UUID | None,
    prospect_id: uuid.UUID | None,
) -> AgentTask:
    task = AgentTask(
        thread_id=None,
        run_id=run.id,
        type=task_type,
        company_id=company_id,
        prospect_id=prospect_id,
        status=AgentTaskStatus.PENDING,
        priority=agent_missions.TASK_PRIORITIES.get(task_type, 50),
        max_attempts=3,
        assigned_agent_id=mission.agent_id,
    )
    session.add(task)
    session.flush()
    audit.record_event(
        session,
        actor,
        audit.AuditAction.AGENT_TASK_CREATED,
        entity_type="agent_task",
        entity_id=task.id,
        subject=("company", company_id) if company_id is not None else None,
        changes={"type": {"after": task_type.value}},
    )
    return task


def set_status(
    session: Session,
    actor: ActorContext,
    mission_id: uuid.UUID,
    status: MissionStatus,
    now: datetime | None = None,
) -> Mission:
    mission = session.scalar(select(Mission).where(Mission.id == mission_id).with_for_update())
    if mission is None:
        raise NotFoundError("Unknown mission.")
    if mission.status in (MissionStatus.DONE, MissionStatus.CANCELLED):
        raise ConflictError("This mission is closed.")
    previous = mission.status
    mission.status = status
    if status is MissionStatus.ACTIVE:
        runs_count = session.scalar(
            select(func.count()).select_from(MissionRun).where(MissionRun.mission_id == mission.id)
        )
        mission.next_run_at = next_occurrence(
            mission, _now(now), runs_count=runs_count or 0
        )
    elif status is MissionStatus.PAUSED:
        mission.next_run_at = None
    else:
        mission.next_run_at = None
    session.flush()
    audit.record_event(
        session,
        actor,
        audit.AuditAction.MISSION_STATUS_CHANGED,
        entity_type="mission",
        entity_id=mission.id,
        changes={"status": {"before": previous.value, "after": status.value}},
    )
    return mission


def pending_proposals(session: Session) -> list[ProposalRow]:
    """Tool-mode submissions waiting for a person: they live outside any mission run.

    An agent that calls `viper_update_company` without a mission still produces a result to review;
    the page lists it here instead of hiding it in a legacy thread.
    """
    rows = session.execute(
        select(AgentTaskResult, AgentTask)
        .join(AgentTask, AgentTask.id == AgentTaskResult.task_id)
        .where(
            AgentTaskResult.status == AgentResultStatus.PENDING_REVIEW,
            AgentTask.run_id.is_(None),
        )
        .order_by(AgentTaskResult.submitted_at.desc())
    ).all()
    company_ids = {task.company_id for _, task in rows if task.company_id is not None}
    prospect_ids = {task.prospect_id for _, task in rows if task.prospect_id is not None}
    company_names = {
        company.id: company.display_name
        for company in session.scalars(select(Company).where(Company.id.in_(company_ids)))
    }
    prospect_names = {
        prospect.id: " ".join(
            part for part in (prospect.first_name, prospect.last_name) if part
        )
        for prospect in session.scalars(select(Prospect).where(Prospect.id.in_(prospect_ids)))
    }
    proposals = []
    for result, task in rows:
        subject = (
            company_names.get(task.company_id)
            if task.company_id is not None
            else prospect_names.get(task.prospect_id)
        )
        proposals.append(
            ProposalRow(
                result_id=result.id,
                task_type=task.type,
                submitted_by_label=result.submitted_by_label,
                submitted_at=result.submitted_at,
                subject_label=subject,
            )
        )
    return proposals


def agents(session: Session) -> list[dict[str, Any]]:
    tokens = session.scalars(
        select(McpToken).where(McpToken.revoked_at.is_(None)).order_by(McpToken.label)
    ).all()
    return [
        {"id": str(token.id), "label": token.label, "scopes": token.scopes}
        for token in tokens
    ]


def target_options(
    session: Session, kind: str, search: str | None, limit: int = 20
) -> list[dict[str, Any]]:
    if kind == "company":
        company_page = companies.list_companies(session, search=search, limit=limit)
        return [
            {
                "kind": "company",
                "id": str(company.id),
                "label": company.display_name,
                "hint": " · ".join(
                    part
                    for part in (company.city, company.commercial_segment_label)
                    if part
                )
                or None,
            }
            for company in company_page.items
        ]
    if kind == "prospect":
        prospect_page = mcp_reads.list_prospects(session, search=search, limit=limit)
        return [
            {
                "kind": "prospect",
                "id": prospect["id"],
                "label": prospect["name"] or "Prospect sans nom",
                "hint": (prospect.get("company") or {}).get("display_name"),
            }
            for prospect in prospect_page["prospects"]
        ]
    raise InvalidFieldError("kind", "Unknown target kind.", "unknown")


def options() -> dict[str, Any]:
    return {
        "types": [
            {"value": type_.value, "executable": type_ in EXECUTABLE_TYPES}
            for type_ in MissionType
        ],
        "result_kinds": [
            {"value": kind.value, "executable": kind in EXECUTABLE_RESULT_KINDS}
            for kind in MissionResultKind
        ],
        "units": [unit.value for unit in RecurrenceUnit],
        "end_kinds": [kind.value for kind in MissionEndKind],
        "result_limit_max": RESULT_LIMIT_MAX,
    }
