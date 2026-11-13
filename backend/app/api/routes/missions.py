"""Missions API (`/api/missions`): the persistent rule, its runs, and the linked records.

The page writes the rule; agents execute its runs over MCP; a person reviews the results in the
same card as before. Nothing here applies a result.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.core.config import Settings
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
from app.services import mission_creator_prompt as creator_prompt
from app.services import missions
from app.services.runtime_settings import RuntimeSettings

router = APIRouter(prefix="/missions", tags=["missions"])


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TargetIn(StrictModel):
    kind: Literal["company", "prospect"]
    id: uuid.UUID


class ObjectiveIn(StrictModel):
    """The machine-evaluable goal of a run: `tasks_accepted` (default: every task of the run is
    accepted) or `accepted_items` with a `count` (at most `result_limit`, the per-run cap)."""

    kind: Literal["tasks_accepted", "accepted_items"] = "tasks_accepted"
    count: int | None = Field(default=None, ge=1, le=500)


class MissionIn(StrictModel):
    """The rule. `category_id` picks the product category (its icon, colour, general prompt and
    default skills); `type` is the technical discriminator, deduced from the category and optional
    (a bare `type` resolves to its built-in category). `prompt` and `skill_ids` follow the
    category unless sent: `null` = inherit, a value = override. On « Modifier », a field left out
    keeps its value and its inherited/overridden state."""

    name: str = Field(min_length=1, max_length=200)
    type: MissionType | None = None
    category_id: uuid.UUID | None = None
    prompt: str | None = Field(default=None, min_length=1, max_length=5000)
    skill_ids: list[uuid.UUID] | None = Field(default=None, max_length=100)
    targets: list[TargetIn] = Field(default_factory=list, max_length=500)
    source_ids: list[uuid.UUID] = Field(default_factory=list, max_length=100)
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
    allow_multiple: bool = False
    objective: ObjectiveIn | None = None
    geography: str | None = Field(default=None, max_length=200)
    period_days: int | None = Field(default=None, ge=1, le=3650)
    exclusions: dict[str, Any] = Field(default_factory=dict)
    run_now: bool = False


class MissionStatusIn(StrictModel):
    status: MissionStatus


class CategoryRefOut(BaseModel):
    """The category's visual identity on a card; the UI never derives colour from the id."""

    id: uuid.UUID
    key: str | None
    name: str
    icon: str
    color: str


class SkillRefOut(BaseModel):
    id: uuid.UUID
    name: str


class InheritanceOut(BaseModel):
    """Which category-derived fields the mission still follows (`prompt`, `skills`)."""

    category_id: uuid.UUID | None
    overridden_fields: list[str]
    prompt_inherited: bool
    skills_inherited: bool
    category_prompt: str | None
    category_skills: list[SkillRefOut]


class MissionCardOut(BaseModel):
    id: uuid.UUID
    name: str
    type: MissionType
    category: CategoryRefOut | None
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


class SourceOut(BaseModel):
    id: uuid.UUID
    url: str
    label: str | None
    missions_count: int


class SourceIn(StrictModel):
    url: str = Field(min_length=1, max_length=2000)
    label: str | None = Field(default=None, max_length=200)


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
    objective_met_at: datetime | None = None


class MissionTaskOut(BaseModel):
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


class MissionRuleOut(BaseModel):
    agent_id: uuid.UUID | None
    starts_at: datetime | None
    end_kind: MissionEndKind
    ends_at: datetime | None
    max_runs: int | None
    geography: str | None
    period_days: int | None
    exclusions: dict[str, Any]
    allow_multiple: bool
    objective: ObjectiveIn


class ObjectiveProgressOut(BaseModel):
    kind: str
    target: int | None
    current: int
    met: bool


class MissionDetailOut(BaseModel):
    card: MissionCardOut
    targets: list[TargetOut]
    sources: list[SourceOut]
    runs: list[RunOut]
    tasks: list[MissionTaskOut]
    prompt: str
    result_kind: MissionResultKind
    result_limit: int
    rule: MissionRuleOut
    inheritance: InheritanceOut
    # The instruction skills the mission works with (own list when overridden, else the category's).
    skills: list[SkillRefOut]
    objective_progress: ObjectiveProgressOut | None = None


class CreatorPromptOut(BaseModel):
    """The mission-creator assistant's behaviour prompt (distinct from category prompts)."""

    prompt: str
    default: str
    is_default: bool
    source: Literal["ui", "env", "default"]


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
        sources=[SourceOut.model_validate(row, from_attributes=True) for row in detail.sources],
        runs=[RunOut.model_validate(row, from_attributes=True) for row in detail.runs],
        tasks=[MissionTaskOut.model_validate(row, from_attributes=True) for row in detail.tasks],
        prompt=detail.prompt,
        result_kind=detail.result_kind,
        result_limit=detail.result_limit,
        rule=MissionRuleOut.model_validate(detail.rule, from_attributes=True),
        inheritance=InheritanceOut.model_validate(detail.inheritance, from_attributes=True),
        skills=[SkillRefOut.model_validate(row, from_attributes=True) for row in detail.skills],
        objective_progress=(
            ObjectiveProgressOut.model_validate(detail.objective_progress)
            if detail.objective_progress is not None
            else None
        ),
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
        source_ids=tuple(body.source_ids),
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
        allow_multiple=body.allow_multiple,
        objective=body.objective.model_dump() if body.objective is not None else None,
        geography=body.geography,
        period_days=body.period_days,
        exclusions=body.exclusions,
        category_id=body.category_id,
        skill_ids=tuple(body.skill_ids) if body.skill_ids is not None else None,
        # Meaningful on « Modifier » only: what the request did not mention keeps its state.
        unchanged_fields=frozenset(
            name
            for name, field_name in (("prompt", "prompt"), ("skills", "skill_ids"))
            if field_name not in body.model_fields_set
        ),
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


@router.get("/creator-prompt")
def mission_creator_prompt(request: Request) -> CreatorPromptOut:
    """The mission-creator assistant's behaviour prompt: the person's override from Paramètres, else
    the built-in default. Edited through `PUT /settings/integrations` (`mission_creator_prompt`)."""
    settings: Settings = request.app.state.settings
    runtime: RuntimeSettings = request.app.state.runtime_settings
    override = settings.mission_creator_prompt
    return CreatorPromptOut(
        prompt=creator_prompt.mission_creator_prompt(settings),
        default=creator_prompt.DEFAULT_MISSION_CREATOR_PROMPT,
        is_default=not override,
        source=runtime.source("mission_creator_prompt"),
    )


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


@router.get("/sources")
def mission_sources(session: SessionDep) -> list[SourceOut]:
    """The saved links, reusable by any mission."""
    return [
        SourceOut.model_validate(row, from_attributes=True)
        for row in missions.list_sources(session)
    ]


@router.post("/sources", status_code=status.HTTP_201_CREATED)
def add_mission_source(body: SourceIn, session: SessionDep, actor: CurrentActor) -> SourceOut:
    with business_errors():
        row = missions.add_source(session, actor, body.url, body.label)
    return SourceOut.model_validate(row, from_attributes=True)


@router.delete("/sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_mission_source(source_id: uuid.UUID, session: SessionDep) -> None:
    with business_errors():
        missions.delete_source(session, source_id)


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
