"""Missions: create the rule, launch a run, and read the cards the page shows.

A mission is persistent; a **run** is one execution and owns the tasks an agent claims. The
consigne is never copied into a task: the task carries a `run_id` and a subject id. The run keeps
the rule it started under (`MissionRun.config`), and the MCP payload reads that rule and the live
record at claim time, so modifying a mission changes only its next runs. Nothing here applies a
result.

Contract: `doc/architecture/missions.md`.
"""

import calendar
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete as sql_delete
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models.agent_missions import AgentTask, AgentTaskResult
from app.models.companies import Company
from app.models.enums import (
    AgentResultStatus,
    AgentTaskStatus,
    AgentTaskType,
    MissionAgentDisconnectReason,
    MissionEndKind,
    MissionResultKind,
    MissionRunStatus,
    MissionRunTrigger,
    MissionStatus,
    MissionType,
    RecurrenceUnit,
)
from app.models.mcp import McpToken
from app.models.mission_categories import MissionCategory
from app.models.missions import (
    Mission,
    MissionRun,
    MissionTarget,
)
from app.models.prospects import Prospect
from app.models.warehouses import Warehouse
from app.services import (
    agent_missions,
    agent_payloads,
    audit,
    companies,
    mcp_reads,
    mission_categories,
    mission_context,
    mission_output,
    mission_sources,
    mission_telemetry,
)
from app.services.errors import ConflictError, DomainError, InvalidFieldError, NotFoundError
from app.services.mission_categories import CategoryRef, MissionInheritance, SkillRef

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
    """What « Créer / Modifier la mission » sends. `type` (the technical discriminator) and
    `prompt` may be left out when a category gives them: a missing `prompt` inherits the
    category's general prompt, a given one overrides it (see `mission_categories`)."""

    name: str
    type: MissionType | None
    prompt: str | None
    targets: tuple[TargetInput, ...] = ()
    # None = follow the category's default sources; a tuple (possibly empty) overrides them.
    source_ids: tuple[uuid.UUID, ...] | None = None
    # Read-only internal records supplied as context (never targets); None = keep on update.
    context_refs: tuple[mission_context.ContextRefInput, ...] | None = None
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
    # One item per submission by default; true = the list envelope (Slice 04).
    allow_multiple: bool = False
    # The machine-evaluable goal (`mission_output.MissionObjective` as a dict); None = default.
    objective: dict[str, Any] | None = None
    geography: str | None = None
    period_days: int | None = None
    exclusions: dict[str, Any] = field(default_factory=dict)
    category_id: uuid.UUID | None = None
    # None = follow the category's default skills; a tuple (possibly empty) overrides them.
    skill_ids: tuple[uuid.UUID, ...] | None = None
    # On update: the inheritable fields the request did not mention (`prompt`, `skills`,
    # `sources`) keep
    # their value and their inherited/overridden state.
    unchanged_fields: frozenset[str] = frozenset()


@dataclass(frozen=True, slots=True)
class MissionCard:
    id: uuid.UUID
    name: str
    type: MissionType
    # The category's visual identity (icon, colour): what the card shows. None only for a mission
    # written outside the service.
    category: CategoryRef | None
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
    objective_met_at: datetime | None = None


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
    result_id: uuid.UUID | None
    submitted_at: datetime | None


@dataclass(frozen=True, slots=True)
class MissionRule:
    """The rest of the rule, for « Modifier la mission » (the card holds the visible part)."""

    agent_id: uuid.UUID | None
    starts_at: datetime | None
    end_kind: MissionEndKind
    ends_at: datetime | None
    max_runs: int | None
    geography: str | None
    period_days: int | None
    exclusions: dict[str, Any]
    allow_multiple: bool
    objective: dict[str, Any]


@dataclass(frozen=True, slots=True)
class MissionDetail:
    card: MissionCard
    targets: list[TargetRow]
    # The external sources the mission works with (own list, else its category's defaults).
    sources: list[mission_sources.SourceRow]
    # Read-only internal records linked as context; distinct from `targets`.
    context_refs: list[mission_context.ContextRefRow]
    runs: list[RunRow]
    tasks: list[MissionTaskRow]
    prompt: str
    result_kind: MissionResultKind
    result_limit: int
    rule: MissionRule
    inheritance: MissionInheritance
    # The instruction skills the mission works with (its own list, else its category's defaults).
    skills: list[SkillRef]
    # The latest run's standing against its objective (None before any run).
    objective_progress: dict[str, Any] | None


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
            name = (
                " ".join(part for part in (prospect.first_name, prospect.last_name) if part)
                or "Prospect sans nom"
            )
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
        prospect.id: " ".join(part for part in (prospect.first_name, prospect.last_name) if part)
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
    category = session.get(MissionCategory, mission.category_id) if mission.category_id else None
    return MissionCard(
        id=mission.id,
        name=mission.name,
        type=mission.type,
        category=mission_categories.category_ref(category) if category is not None else None,
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
        statement.order_by(Mission.status.asc(), Mission.created_at.desc())
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
            objective_met_at=run.objective_met_at,
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
        sources=mission_sources.effective_source_rows(session, mission),
        context_refs=mission_context.list_refs(session, mission.id),
        runs=runs,
        tasks=_task_rows(session, mission.id),
        prompt=mission.prompt,
        result_kind=mission.result_kind,
        result_limit=mission.result_limit,
        rule=MissionRule(
            agent_id=mission.agent_id,
            starts_at=mission.starts_at,
            end_kind=mission.end_kind,
            ends_at=mission.ends_at,
            max_runs=mission.max_runs,
            geography=mission.geography,
            period_days=mission.period_days,
            exclusions=dict(mission.exclusions or {}),
            allow_multiple=mission.allow_multiple,
            objective=mission_output.parse_objective(mission.objective),
        ),
        inheritance=mission_categories.inheritance(session, mission),
        skills=[
            SkillRef(id=skill.id, name=skill.name)
            for skill in mission_categories.effective_skills(session, mission)
        ],
        objective_progress=_latest_progress(session, runs[0].id if runs else None),
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
    objective = mission_output.parse_objective(data.objective)
    if objective["kind"] == mission_output.OBJECTIVE_ACCEPTED_ITEMS:
        if data.targets and data.type not in (MissionType.PROSPECTION, MissionType.SIGNALS):
            raise InvalidFieldError(
                "objective.kind",
                "Counting accepted items needs a discovery, prospection or signals mission.",
                "unsupported",
            )
        # A goal above `result_limit` is allowed: the run's cap is raised to the goal (`mission_rule`).
    if data.is_recurring and data.interval_count < 1:
        raise InvalidFieldError("interval_count", "At least 1.", "range")
    # The end rule is checked for every mission, one-off included: the table's constraints
    # (`ck_missions_end_date_required`, `ck_missions_end_runs_required`) apply to all of them.
    if data.end_kind is MissionEndKind.DATE and data.ends_at is None:
        raise InvalidFieldError("ends_at", "A date is required.", "missing")
    if data.end_kind is MissionEndKind.AFTER and (data.max_runs or 0) < 1:
        raise InvalidFieldError("max_runs", "At least 1 run.", "range")
    if data.end_kind is MissionEndKind.DATE and data.ends_at is not None and data.ends_at <= now:
        raise InvalidFieldError("ends_at", "The end must be in the future.", "range")


def _stored_objective(raw: dict[str, Any] | None) -> dict[str, Any] | None:
    """The objective as persisted: None stays « default » (every task accepted)."""
    return None if raw is None else mission_output.parse_objective(raw)


def _target_kinds(targets: tuple[TargetInput, ...]) -> list[str]:
    return ["company" if target.company_id is not None else "prospect" for target in targets]


def _create_targets(session: Session, mission: Mission, targets: tuple[TargetInput, ...]) -> None:
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
    category, mission_type = mission_categories.resolve_category(
        session, data.category_id, data.type
    )
    _validate(data, moment)
    check_runnable(mission_type, data.result_kind, _target_kinds(data.targets))
    token: McpToken | None = None
    if data.agent_id is not None:
        token = session.get(McpToken, data.agent_id)
        if token is None or token.revoked_at is not None:
            raise InvalidFieldError("agent_id", "Unknown or revoked agent.", "not_found")
    starts_at = data.starts_at or moment
    # An active mission is open to the agents: started (now or at a past date), its first run
    # and its tasks are created right away; a future start waits for its moment (scheduler).
    starts_now = starts_at <= moment
    next_run_at: datetime | None = None if starts_now else starts_at
    mission = Mission(
        name=name,
        type=mission_type,
        category_id=category.id if category is not None else None,
        overridden_fields=[],
        # Replaced by `apply_inheritance` below (the category's or the person's text).
        prompt="-",
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
        allow_multiple=data.allow_multiple,
        objective=_stored_objective(data.objective),
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
    mission_categories.apply_inheritance(
        session,
        mission,
        category,
        prompt=data.prompt,
        skill_ids=data.skill_ids,
        source_ids=data.source_ids,
        creating=True,
    )
    _create_targets(session, mission, data.targets)
    mission_context.set_refs(session, mission, data.context_refs or ())
    audit.record_event(
        session,
        actor,
        audit.AuditAction.MISSION_CREATED,
        entity_type="mission",
        entity_id=mission.id,
        changes={
            "name": {"after": mission.name},
            "type": {"after": mission.type.value},
            "category_id": {"after": str(category.id) if category is not None else None},
            "overridden_fields": {"after": list(mission.overridden_fields)},
        },
    )
    if run_now or starts_now:
        trigger = MissionRunTrigger.MANUAL if run_now else MissionRunTrigger.SCHEDULE
        run_mission(session, actor, mission.id, trigger=trigger, now=moment)
    return mission


# The fields « Modifier la mission » rewrites, compared for the audit entry.
EDITED_FIELDS = (
    "name",
    "type",
    "prompt",
    "agent_id",
    "is_recurring",
    "interval_count",
    "interval_unit",
    "starts_at",
    "end_kind",
    "ends_at",
    "max_runs",
    "result_kind",
    "result_limit",
    "allow_multiple",
    "objective",
    "geography",
    "period_days",
    "exclusions",
)


def _audit_value(value: object) -> object:
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, MissionType | RecurrenceUnit | MissionEndKind | MissionResultKind):
        return value.value
    return value


# The category link and the inherited/overridden state are audited with the rule, but are not
# plain edited fields (`MissionInput.category_id`, `skill_ids`).
AUDITED_INHERITANCE_FIELDS = ("category_id", "overridden_fields")


def _audited_rule(mission: Mission) -> dict[str, object]:
    return {
        field_name: _audit_value(getattr(mission, field_name))
        for field_name in (*EDITED_FIELDS, *AUDITED_INHERITANCE_FIELDS)
    }


def _update_category(
    session: Session, mission: Mission, data: MissionInput
) -> tuple[MissionCategory | None, MissionType]:
    """The category and technical type an edited mission ends up with. Nothing named: it keeps
    its own. Only a type named (the legacy form): the current category if that is its type, else
    the seeded category of the type."""
    if data.category_id is None and (data.type is None or data.type is mission.type):
        current = session.get(MissionCategory, mission.category_id) if mission.category_id else None
        if current is not None or data.type is None:
            return current, mission.type
    return mission_categories.resolve_category(session, data.category_id, data.type)


def update(
    session: Session,
    actor: ActorContext,
    mission_id: uuid.UUID,
    data: MissionInput,
    now: datetime | None = None,
) -> Mission:
    """« Modifier la mission »: the whole rule is rewritten, linked data included. Runs already
    made and their tasks stay as they are; the next run follows the new rule. A closed mission
    (done, cancelled) is not edited: create a new one."""
    moment = _now(now)
    mission = session.scalar(select(Mission).where(Mission.id == mission_id).with_for_update())
    if mission is None:
        raise NotFoundError("Unknown mission.")
    if mission.status in (MissionStatus.DONE, MissionStatus.CANCELLED):
        raise ConflictError("This mission is closed.")
    name = _text("name", data.name, 200)
    category, mission_type = _update_category(session, mission, data)
    _validate(data, moment)
    check_runnable(mission_type, data.result_kind, _target_kinds(data.targets))
    agent_label: str | None = None
    if data.agent_id is not None and data.agent_id == mission.agent_id:
        # Unchanged agent: keep the snapshotted label even if its token was revoked since.
        agent_label = mission.agent_label
    elif data.agent_id is not None:
        token = session.get(McpToken, data.agent_id)
        if token is None or token.revoked_at is not None:
            raise InvalidFieldError("agent_id", "Unknown or revoked agent.", "not_found")
        agent_label = token.label
    before = _audited_rule(mission)

    mission.name = name
    mission.type = mission_type
    mission.category_id = category.id if category is not None else None
    mission_categories.apply_inheritance(
        session,
        mission,
        category,
        prompt=data.prompt,
        skill_ids=data.skill_ids,
        source_ids=data.source_ids,
        creating=False,
        keep=data.unchanged_fields,
    )
    mission.agent_id = data.agent_id
    mission.agent_label = agent_label
    mission.is_recurring = data.is_recurring
    mission.interval_count = data.interval_count
    mission.interval_unit = data.interval_unit
    mission.starts_at = data.starts_at or mission.starts_at or moment
    mission.end_kind = data.end_kind
    mission.ends_at = data.ends_at
    mission.max_runs = data.max_runs
    mission.result_kind = data.result_kind
    mission.result_limit = data.result_limit
    mission.allow_multiple = data.allow_multiple
    mission.objective = _stored_objective(data.objective)
    mission.geography = (data.geography or "").strip() or None
    mission.period_days = data.period_days
    mission.exclusions = data.exclusions

    # A paused mission keeps no next run: « Reprendre » computes it.
    if mission.status is MissionStatus.ACTIVE:
        runs_count = session.scalar(
            select(func.count()).select_from(MissionRun).where(MissionRun.mission_id == mission.id)
        )
        if mission.starts_at is not None and mission.starts_at > moment:
            mission.next_run_at = mission.starts_at
        elif not runs_count:
            # Never run yet: due now, the scheduler opens it to the agents on its next pass.
            mission.next_run_at = moment
        else:
            mission.next_run_at = next_occurrence(mission, moment, runs_count=runs_count or 0)

    session.execute(sql_delete(MissionTarget).where(MissionTarget.mission_id == mission.id))
    session.flush()
    _create_targets(session, mission, data.targets)
    if data.context_refs is not None:
        mission_context.set_refs(session, mission, data.context_refs)
    after = _audited_rule(mission)
    changes: dict[str, dict[str, Any]] = {
        field_name: {"before": before[field_name], "after": after[field_name]}
        for field_name in before
        if before[field_name] != after[field_name]
    }
    audit.record_event(
        session,
        actor,
        audit.AuditAction.MISSION_UPDATED,
        entity_type="mission",
        entity_id=mission.id,
        changes=changes,
        reason=f"targets={len(data.targets)}",
    )
    return mission


def set_sources(
    session: Session,
    actor: ActorContext,
    mission_id: uuid.UUID,
    source_ids: tuple[uuid.UUID, ...] | None,
) -> Mission:
    """Change only the external sources of a mission: `None` = follow the category's defaults,
    a tuple = the mission's own list (empty = no source at all). A closed mission is not edited."""
    mission = session.scalar(select(Mission).where(Mission.id == mission_id).with_for_update())
    if mission is None:
        raise NotFoundError("Unknown mission.")
    if mission.status in (MissionStatus.DONE, MissionStatus.CANCELLED):
        raise ConflictError("This mission is closed.")
    category = session.get(MissionCategory, mission.category_id) if mission.category_id else None
    before = [str(row.id) for row in mission_sources.effective_sources(session, mission)]
    mission_categories.apply_inheritance(
        session,
        mission,
        category,
        prompt=None,
        skill_ids=None,
        source_ids=source_ids,
        creating=False,
        keep=frozenset({mission_categories.PROMPT_FIELD, mission_categories.SKILLS_FIELD}),
    )
    after = [str(row.id) for row in mission_sources.effective_sources(session, mission)]
    audit.record_event(
        session,
        actor,
        audit.AuditAction.MISSION_UPDATED,
        entity_type="mission",
        entity_id=mission.id,
        changes={"sources": {"before": before, "after": after}},
        reason=f"sources={len(after)}",
    )
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


def _run_objective(session: Session, run: MissionRun) -> dict[str, Any] | None:
    """The objective a run works under: its snapshot, else the live mission's (runs made before
    migration 0049 have none and use the default)."""
    snapshot = (run.config or {}).get("objective")
    if snapshot is not None:
        return dict(snapshot)
    if run.config is not None:
        return None
    mission = session.get(Mission, run.mission_id)
    return mission.objective if mission is not None else None


def _latest_progress(session: Session, run_id: uuid.UUID | None) -> dict[str, Any] | None:
    run = session.get(MissionRun, run_id) if run_id is not None else None
    if run is None:
        return None
    tasks = session.scalars(select(AgentTask).where(AgentTask.run_id == run.id)).all()
    return mission_output.progress(session, tasks, _run_objective(session, run)).as_dict()


def _continue_discovery(
    session: Session, mission: Mission, run: MissionRun, tasks: list[AgentTask]
) -> bool:
    """Discovery work one item at a time: while the objective is not met and the last accepted
    result brought something, open the next task of the same run. Bounded: each step needs a
    non-empty accepted result, and the count is capped by `result_limit`."""
    if not tasks or any(task.type is not AgentTaskType.FIND_PROSPECTS for task in tasks):
        return False
    state = mission_output.progress(session, tasks, _run_objective(session, run))
    if (
        state.kind != mission_output.OBJECTIVE_ACCEPTED_ITEMS
        or state.met
        or state.last_accepted_items < 1
        or state.items_accepted >= int((run.config or {}).get("result_limit", RESULT_LIMIT_MAX))
        or tasks[-1].status is not AgentTaskStatus.ACCEPTED
    ):
        return False
    _task(
        session,
        SCHEDULER_ACTOR,
        mission,
        run,
        AgentTaskType.FIND_PROSPECTS,
        company_id=None,
        prospect_id=None,
    )
    return True


def _settle_objective(
    session: Session, run: MissionRun, tasks: list[AgentTask], now: datetime
) -> None:
    """A finished run is checked against its own objective. Fulfilled: stamp it, and close a
    one-off mission (a recurring one stays scheduled; its end rule is the scheduler's).
    Not fulfilled: say so on the run and leave the mission open: never « done » by default."""
    mission = session.get(Mission, run.mission_id)
    if mission is None:
        return
    state = mission_output.progress(session, tasks, _run_objective(session, run))
    if state.met:
        if run.objective_met_at is None:
            run.objective_met_at = now
        if not mission.is_recurring and mission.status is MissionStatus.ACTIVE:
            mission.status = MissionStatus.DONE
            mission.next_run_at = None
            audit.record_event(
                session,
                SCHEDULER_ACTOR,
                audit.AuditAction.MISSION_STATUS_CHANGED,
                entity_type="mission",
                entity_id=mission.id,
                changes={"status": {"before": "active", "after": "done"}},
                reason="objective fulfilled",
            )
    elif run.note is None:
        run.note = f"Objectif non atteint ({state.current}/{state.target})."


def refresh_run(session: Session, run: MissionRun) -> MissionRun:
    """Derive a run's status and counts from its tasks (no second source of truth)."""
    tasks = list(
        session.scalars(
            select(AgentTask).where(AgentTask.run_id == run.id).order_by(AgentTask.created_at)
        )
    )
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
    mission = session.get(Mission, run.mission_id)
    if (
        run.status is MissionRunStatus.RUNNING
        and mission is not None
        and not any(status in OPEN_TASK_STATUSES for status in statuses)
        and _continue_discovery(session, mission, run, tasks)
    ):
        statuses = [*statuses, AgentTaskStatus.PENDING]
        run.tasks_total += 1
    if any(status in OPEN_TASK_STATUSES for status in statuses):
        run.status = MissionRunStatus.RUNNING
        run.finished_at = None
    else:
        if run.status is not MissionRunStatus.CANCELLED:
            if run.status is not MissionRunStatus.DONE:
                # The run just finished: its agents' sessions end with it (telemetry §3.4).
                mission_telemetry.end_run_sessions(
                    session, [run.id], MissionAgentDisconnectReason.RUN_FINISHED
                )
            run.status = MissionRunStatus.DONE
            if run.finished_at is None:
                run.finished_at = max(
                    (task.updated_at for task in tasks), default=run.started_at or run.scheduled_at
                )
            _settle_objective(session, run, tasks, run.finished_at)
    return run


def refresh_open_runs(session: Session, *, limit: int = 200) -> int:
    """Settle the runs still `running`: a run whose last task was reviewed, failed or cancelled
    becomes `done` and ends its agents' sessions (`run_finished`) without waiting for someone
    to open the mission card. Called by the scheduler pass; `refresh_run` stays the one rule.
    Returns how many runs changed status."""
    runs = session.scalars(
        select(MissionRun)
        .where(MissionRun.status == MissionRunStatus.RUNNING)
        .order_by(MissionRun.scheduled_at)
        .limit(limit)
        .with_for_update(skip_locked=True)
    ).all()
    settled = 0
    for run in runs:
        refresh_run(session, run)
        if run.status is not MissionRunStatus.RUNNING:
            settled += 1
    return settled


def idle_summary(session: Session, *, limit: int = 10) -> list[dict[str, Any]]:
    """Why an agent finds nothing to claim: the open missions, their state and next run.

    A task only exists once a run starts (« Lancer maintenant » or the next due moment); an agent
    told « no task » without this would not know whether to wait or to ask for a launch.
    """
    open_missions = session.scalars(
        select(Mission)
        .where(Mission.status.in_((MissionStatus.ACTIVE, MissionStatus.PAUSED)))
        .order_by(Mission.next_run_at.asc().nulls_last())
        .limit(limit)
    ).all()
    summary: list[dict[str, Any]] = []
    for mission in open_missions:
        last = session.scalars(
            select(MissionRun)
            .where(MissionRun.mission_id == mission.id)
            .order_by(MissionRun.scheduled_at.desc())
            .limit(1)
        ).first()
        summary.append(
            {
                "mission_id": str(mission.id),
                "name": mission.name,
                "status": mission.status.value,
                "next_run_at": mission.next_run_at.isoformat() if mission.next_run_at else None,
                "last_run": (
                    {"status": last.status.value, "note": last.note} if last is not None else None
                ),
            }
        )
    return summary


def check_runnable(
    mission_type: MissionType, result_kind: MissionResultKind, target_kinds: list[str]
) -> None:
    """Refuse a rule that could never produce a task. Checked when the mission is saved (the
    dialog shows the reason next to the field) and again when a run starts."""
    if mission_type not in EXECUTABLE_TYPES:
        raise InvalidFieldError(
            "type",
            "Ce type de mission n’est pas encore exécutable : la découverte et les signaux "
            "arrivent avec leurs schémas de résultat.",
            "unsupported",
        )
    if result_kind not in EXECUTABLE_RESULT_KINDS:
        raise InvalidFieldError(
            "result_kind",
            "Ce résultat attendu n’est pas encore pris en charge (signaux : phase 2).",
            "unsupported",
        )
    # No linked record is needed: without targets the mission works from its consigne and context.
    if not target_kinds:
        if mission_type is MissionType.SIGNALS and result_kind is not MissionResultKind.SIGNALS:
            raise InvalidFieldError(
                "result_kind",
                "Une mission de signaux attend le résultat « Signaux ».",
                "unsupported",
            )
    elif mission_type is MissionType.SIGNALS:
        if result_kind is not MissionResultKind.SIGNALS:
            raise InvalidFieldError(
                "result_kind",
                "Une mission de signaux attend le résultat « Signaux ».",
                "unsupported",
            )
        if "company" not in target_kinds:
            raise InvalidFieldError(
                "targets",
                "Une mission « Signaux » surveille des sociétés : liez-en au moins une.",
                "empty",
            )
    elif mission_type is MissionType.PROSPECTION:
        if result_kind is not MissionResultKind.PROSPECTS:
            raise InvalidFieldError(
                "result_kind",
                "Avec des sociétés liées, la prospection cherche des contacts : "
                "choisissez « Prospects ».",
                "unsupported",
            )
        if "company" not in target_kinds:
            raise InvalidFieldError(
                "targets",
                "Ajoutez au moins une société à explorer.",
                "empty",
            )


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
    targets = _target_rows(session, mission.id)
    discovery = not targets
    check_runnable(mission.type, mission.result_kind, [target.kind for target in targets])
    run = MissionRun(
        mission_id=mission.id,
        status=MissionRunStatus.RUNNING,
        trigger=trigger,
        scheduled_at=moment,
        started_at=moment,
        # The rule this run's tasks work under: a later « Modifier » changes only the next runs.
        config=agent_payloads.mission_rule(mission),
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


def run_due(session: Session, *, now: datetime | None = None, limit: int = 20) -> list[MissionRun]:
    """Start the runs whose `next_run_at` is due. Called by the scheduler worker and by tests.

    Each mission is locked `SKIP LOCKED`: two scheduler passes never start the same run. A mission
    whose recurrence is exhausted (end date or max runs) closes; a rule that cannot run
    records a failed run (its reason on the page) and keeps its recurrence: never a silent pause.
    """
    moment = _now(now)
    due = session.scalars(
        select(Mission)
        .where(
            Mission.status == MissionStatus.ACTIVE,
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
        except DomainError as error:
            # A rule that cannot run (saved before the checks existed, or data deleted since):
            # the failure is recorded as a run the page shows, and the recurrence carries on.
            # The mission is never paused behind the person's back.
            failed = MissionRun(
                mission_id=mission.id,
                status=MissionRunStatus.FAILED,
                trigger=MissionRunTrigger.SCHEDULE,
                scheduled_at=moment,
                started_at=moment,
                finished_at=moment,
                note=str(error)[:500],
            )
            session.add(failed)
            mission.last_run_at = moment
            mission.next_run_at = next_occurrence(mission, moment, runs_count=(runs_count or 0) + 1)
            session.flush()
            audit.record_event(
                session,
                SCHEDULER_ACTOR,
                audit.AuditAction.MISSION_RUN_STARTED,
                entity_type="mission_run",
                entity_id=failed.id,
                subject=("mission", mission.id),
                changes={"tasks": {"after": 0}},
                reason=f"not runnable: {str(error)[:200]}",
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
    first_run = False
    if status is MissionStatus.ACTIVE:
        moment = _now(now)
        runs_count = session.scalar(
            select(func.count()).select_from(MissionRun).where(MissionRun.mission_id == mission.id)
        )
        if runs_count:
            mission.next_run_at = next_occurrence(mission, moment, runs_count=runs_count)
        elif mission.starts_at is not None and mission.starts_at > moment:
            mission.next_run_at = mission.starts_at
        else:
            # Activated before its first run: its tasks are open to the agents right away.
            first_run = True
    else:
        # Paused: its pending tasks stay but are no longer offered (`agent_missions.offered`); a
        # task already claimed may still be finished. Cancelled: see below.
        mission.next_run_at = None
    reason = None
    if status is MissionStatus.CANCELLED:
        moment = _now(now)
        cancelled = _cancel_open_tasks(session, actor, mission, "mission_cancelled", moment)
        runs = session.scalars(
            select(MissionRun)
            .where(
                MissionRun.mission_id == mission.id,
                MissionRun.status.in_((MissionRunStatus.SCHEDULED, MissionRunStatus.RUNNING)),
            )
            .with_for_update()
        ).all()
        for run in runs:
            run.status = MissionRunStatus.CANCELLED
            run.finished_at = moment
        # Every run, not only the open ones: a session never outlives a cancelled mission.
        mission_run_ids = session.scalars(
            select(MissionRun.id).where(MissionRun.mission_id == mission.id)
        ).all()
        mission_telemetry.end_run_sessions(
            session, mission_run_ids, MissionAgentDisconnectReason.MISSION_CANCELLED, moment
        )
        reason = f"cancelled_tasks={cancelled} cancelled_runs={len(runs)}"
    session.flush()
    if first_run:
        run_mission(session, actor, mission.id, trigger=MissionRunTrigger.SCHEDULE, now=now)
    audit.record_event(
        session,
        actor,
        audit.AuditAction.MISSION_STATUS_CHANGED,
        entity_type="mission",
        entity_id=mission.id,
        changes={"status": {"before": previous.value, "after": status.value}},
        reason=reason,
    )
    return mission


def _cancel_open_tasks(
    session: Session, actor: ActorContext, mission: Mission, reason: str, moment: datetime
) -> int:
    """Close every open task of the mission's runs (`cancelled`), in the caller's transaction.

    Pending and claimed tasks stop being offered; a worker still holding one is refused with
    `task_cancelled` on its next call. A submitted result still waiting for review is rejected
    with the same reason: nobody may apply work for a mission that was stopped. Returns the count.
    """
    runs = select(MissionRun.id).where(MissionRun.mission_id == mission.id).scalar_subquery()
    open_ids = (
        select(AgentTask.id)
        .where(AgentTask.run_id.in_(runs), AgentTask.status.in_(OPEN_TASK_STATUSES))
        .scalar_subquery()
    )
    # Results first, then tasks: the order `agent_review._locked` takes, so a review racing the
    # cancellation waits instead of deadlocking.
    waiting = session.scalars(
        select(AgentTaskResult)
        .where(
            AgentTaskResult.task_id.in_(open_ids),
            AgentTaskResult.status == AgentResultStatus.PENDING_REVIEW,
        )
        .order_by(AgentTaskResult.id)
        .with_for_update()
    ).all()
    open_tasks = session.scalars(
        select(AgentTask)
        .where(AgentTask.run_id.in_(runs), AgentTask.status.in_(OPEN_TASK_STATUSES))
        .order_by(AgentTask.id)
        .with_for_update()
    ).all()
    # A review that won the race decided its result first: only results still pending are closed.
    # A submission that committed between the two locks added a result: it is closed too.
    known = {result.id for result in waiting}
    waiting = [result for result in waiting if result.status is AgentResultStatus.PENDING_REVIEW]
    waiting += session.scalars(
        select(AgentTaskResult)
        .where(
            AgentTaskResult.task_id.in_([task.id for task in open_tasks]),
            AgentTaskResult.status == AgentResultStatus.PENDING_REVIEW,
            AgentTaskResult.id.not_in(known),
        )
        .with_for_update()
    ).all()
    for task in open_tasks:
        previous = task.status
        task.status = AgentTaskStatus.CANCELLED
        task.staged_actions = []
        agent_missions.clear_claim(task)
        audit.record_event(
            session,
            actor,
            audit.AuditAction.AGENT_TASK_CANCELLED,
            entity_type="agent_task",
            entity_id=task.id,
            changes={
                "status": {"before": previous.value, "after": AgentTaskStatus.CANCELLED.value}
            },
            reason=reason,
        )
    for result in waiting:
        result.status = AgentResultStatus.REJECTED
        result.decided_at = moment
        result.decided_by_id = actor.id
        result.decided_by_display = actor.display
        result.decision_note = reason
        audit.record_event(
            session,
            actor,
            audit.AuditAction.AGENT_TASK_RESULT_REJECTED,
            entity_type="agent_task_result",
            entity_id=result.id,
            changes={"status": {"before": "pending_review", "after": "rejected"}},
            reason=reason,
        )
    session.flush()
    return len(open_tasks)


def delete(session: Session, actor: ActorContext, mission_id: uuid.UUID) -> None:
    """« Supprimer la mission »: the rule, its targets and its runs go (FK cascade). Its open tasks
    are cancelled first, so no agent keeps working for a mission that no longer exists and no
    result waits for a review nobody can open; the tasks themselves stay, with their audit trail
    (`run_id` set to NULL by the FK). Accepted results already applied are not undone."""
    mission = session.scalar(select(Mission).where(Mission.id == mission_id).with_for_update())
    if mission is None:
        raise NotFoundError("Unknown mission.")
    cancelled = _cancel_open_tasks(session, actor, mission, "mission_deleted", _now(None))
    audit.record_event(
        session,
        actor,
        audit.AuditAction.MISSION_DELETED,
        entity_type="mission",
        entity_id=mission.id,
        changes={"name": {"before": mission.name, "after": None}},
        reason=f"cancelled_tasks={cancelled}",
    )
    session.delete(mission)
    session.flush()


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
        prospect.id: " ".join(part for part in (prospect.first_name, prospect.last_name) if part)
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
    return [{"id": str(token.id), "label": token.label, "scopes": token.scopes} for token in tokens]


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
                    part for part in (company.city, company.commercial_segment_label) if part
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
    if kind == "warehouse":
        # Warehouses are read-only context only (never a target).
        query = select(Warehouse).order_by(Warehouse.name).limit(limit)
        if search and search.strip():
            pattern = f"%{search.strip()}%"
            query = query.where(
                or_(
                    Warehouse.name.ilike(pattern),
                    Warehouse.city.ilike(pattern),
                    Warehouse.postal_code.ilike(pattern),
                )
            )
        return [
            {
                "kind": "warehouse",
                "id": str(warehouse.id),
                "label": warehouse.name,
                "hint": mission_context.warehouse_hint(warehouse),
            }
            for warehouse in session.scalars(query)
        ]
    raise InvalidFieldError("kind", "Unknown target kind.", "unknown")


def options() -> dict[str, Any]:
    return {
        "types": [
            {"value": type_.value, "executable": type_ in EXECUTABLE_TYPES} for type_ in MissionType
        ],
        "result_kinds": [
            {"value": kind.value, "executable": kind in EXECUTABLE_RESULT_KINDS}
            for kind in MissionResultKind
        ],
        "units": [unit.value for unit in RecurrenceUnit],
        "end_kinds": [kind.value for kind in MissionEndKind],
        "result_limit_max": RESULT_LIMIT_MAX,
    }
