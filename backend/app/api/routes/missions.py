"""Missions API (`/api/missions`): the persistent rule, its runs, and the linked records.

The page writes the rule; agents execute its runs over MCP; a person reviews the results in the
same card as before. Nothing here applies a result.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, status
from pydantic import BaseModel, ConfigDict, Field

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.models.enums import (
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
from app.services import missions

router = APIRouter(prefix="/missions", tags=["missions"])


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TargetIn(StrictModel):
    kind: Literal["company", "prospect"]
    id: uuid.UUID


class MissionIn(StrictModel):
    name: str = Field(min_length=1, max_length=200)
    type: MissionType
    prompt: str = Field(min_length=1, max_length=5000)
    targets: list[TargetIn] = Field(default_factory=list, max_length=500)
    agent_id: uuid.UUID | None = None
    is_recurring: bool = False
    interval_count: int = Field(default=1, ge=1, le=1000)
    interval_unit: RecurrenceUnit = RecurrenceUnit.DAYS
    starts_at: datetime | None = None
    end_kind: MissionEndKind = MissionEndKind.NEVER
    ends_at: datetime | None = None
    max_runs: int | None = Field(default=None, ge=1, le=1000)
    result_kind: MissionResultKind = MissionResultKind.ENRICHMENT
    result_limit: int = Field(default=20, ge=1, le=500)
    geography: str | None = Field(default=None, max_length=200)
    period_days: int | None = Field(default=None, ge=1, le=3650)
    exclusions: dict[str, Any] = Field(default_factory=dict)
    run_now: bool = False


class MissionStatusIn(StrictModel):
    status: MissionStatus


class MissionCardOut(BaseModel):
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


class MissionListOut(BaseModel):
    items: list[MissionCardOut]
    total: int


class TargetOut(BaseModel):
    kind: str
    id: uuid.UUID
    label: str
    hint: str | None


class RunOut(BaseModel):
    id: uuid.UUID
    status: MissionRunStatus
    trigger: MissionRunTrigger
    scheduled_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    tasks_total: int
    results_count: int
    note: str | None


class MissionTaskOut(BaseModel):
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


class MissionRuleOut(BaseModel):
    agent_id: uuid.UUID | None
    starts_at: datetime | None
    end_kind: MissionEndKind
    ends_at: datetime | None
    max_runs: int | None
    geography: str | None
    period_days: int | None
    exclusions: dict[str, Any]


class MissionDetailOut(BaseModel):
    card: MissionCardOut
    targets: list[TargetOut]
    runs: list[RunOut]
    tasks: list[MissionTaskOut]
    prompt: str
    result_kind: MissionResultKind
    result_limit: int
    rule: MissionRuleOut


class OptionOut(BaseModel):
    value: str
    executable: bool


class MissionOptionsOut(BaseModel):
    types: list[OptionOut]
    result_kinds: list[OptionOut]
    units: list[str]
    end_kinds: list[str]
    result_limit_max: int


class ProposalOut(BaseModel):
    result_id: uuid.UUID
    task_type: AgentTaskType
    submitted_by_label: str
    submitted_at: datetime
    subject_label: str | None


class AgentOut(BaseModel):
    id: str
    label: str
    scopes: list[str]


def detail_out(detail: missions.MissionDetail) -> MissionDetailOut:
    return MissionDetailOut(
        card=MissionCardOut.model_validate(detail.card, from_attributes=True),
        targets=[TargetOut.model_validate(row, from_attributes=True) for row in detail.targets],
        runs=[RunOut.model_validate(row, from_attributes=True) for row in detail.runs],
        tasks=[MissionTaskOut.model_validate(row, from_attributes=True) for row in detail.tasks],
        prompt=detail.prompt,
        result_kind=detail.result_kind,
        result_limit=detail.result_limit,
        rule=MissionRuleOut.model_validate(detail.rule, from_attributes=True),
    )


def mission_input(body: MissionIn) -> missions.MissionInput:
    targets = tuple(
        missions.TargetInput(
            company_id=target.id if target.kind == "company" else None,
            prospect_id=target.id if target.kind == "prospect" else None,
        )
        for target in body.targets
    )
    starts_at = body.starts_at
    if starts_at is not None and starts_at.tzinfo is None:
        starts_at = starts_at.replace(tzinfo=UTC)
    ends_at = body.ends_at
    if ends_at is not None and ends_at.tzinfo is None:
        ends_at = ends_at.replace(tzinfo=UTC)
    return missions.MissionInput(
        name=body.name,
        type=body.type,
        prompt=body.prompt,
        targets=targets,
        agent_id=body.agent_id,
        is_recurring=body.is_recurring,
        interval_count=body.interval_count,
        interval_unit=body.interval_unit,
        starts_at=starts_at,
        end_kind=body.end_kind,
        ends_at=ends_at,
        max_runs=body.max_runs,
        result_kind=body.result_kind,
        result_limit=body.result_limit,
        geography=body.geography,
        period_days=body.period_days,
        exclusions=body.exclusions,
    )


@router.get("")
def list_missions(
    session: SessionDep,
    status_filter: Annotated[MissionStatus | None, Query(alias="status")] = None,
) -> MissionListOut:
    cards = missions.list_cards(session, status=status_filter)
    items = [MissionCardOut.model_validate(card, from_attributes=True) for card in cards]
    return MissionListOut(items=items, total=len(items))


@router.get("/options")
def mission_options() -> MissionOptionsOut:
    return MissionOptionsOut.model_validate(missions.options())


@router.get("/proposals")
def mission_proposals(session: SessionDep) -> list[ProposalOut]:
    """The tool-mode submissions waiting for a review (no mission run to attach them to)."""
    return [
        ProposalOut.model_validate(row, from_attributes=True)
        for row in missions.pending_proposals(session)
    ]


@router.get("/agents")
def mission_agents(session: SessionDep) -> list[AgentOut]:
    return [AgentOut.model_validate(row) for row in missions.agents(session)]


@router.get("/targets")
def mission_targets(
    session: SessionDep,
    kind: Annotated[Literal["company", "prospect"], Query()] = "company",
    q: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> list[TargetOut]:
    return [
        TargetOut.model_validate(row) for row in missions.target_options(session, kind, q, limit)
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
def create_mission(body: MissionIn, session: SessionDep, actor: CurrentActor) -> MissionDetailOut:
    with business_errors():
        mission = missions.create(session, actor, mission_input(body), run_now=body.run_now)
        detail = missions.detail(session, mission.id)
    return detail_out(detail)


@router.get("/{mission_id}")
def get_mission(mission_id: uuid.UUID, session: SessionDep) -> MissionDetailOut:
    with business_errors():
        detail = missions.detail(session, mission_id)
    return detail_out(detail)


@router.patch("/{mission_id}")
def update_mission(
    mission_id: uuid.UUID,
    body: MissionStatusIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MissionDetailOut:
    with business_errors():
        missions.set_status(session, actor, mission_id, body.status)
        detail = missions.detail(session, mission_id)
    return detail_out(detail)


@router.put("/{mission_id}")
def edit_mission(
    mission_id: uuid.UUID,
    body: MissionIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MissionDetailOut:
    """« Modifier la mission »: the whole rule, linked data included (`run_now` is ignored)."""
    with business_errors():
        missions.update(session, actor, mission_id, mission_input(body))
        detail = missions.detail(session, mission_id)
    return detail_out(detail)


@router.delete("/{mission_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_mission(mission_id: uuid.UUID, session: SessionDep, actor: CurrentActor) -> None:
    """« Supprimer la mission »: its open tasks are cancelled, then the mission goes."""
    with business_errors():
        missions.delete(session, actor, mission_id)


@router.post("/{mission_id}/run")
def run_mission(
    mission_id: uuid.UUID,
    session: SessionDep,
    actor: CurrentActor,
) -> MissionDetailOut:
    """« Lancer maintenant »: one manual execution, whatever the recurrence says."""
    with business_errors():
        missions.run_mission(session, actor, mission_id)
        detail = missions.detail(session, mission_id)
    return detail_out(detail)
