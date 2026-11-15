"""Missions API (`/api/missions`): the persistent rule, its runs, and the linked records.

The page writes the rule; agents execute its runs over MCP; a person reviews the results in the
same card as before. Nothing here applies a result.
"""

import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from app.api.dependencies import AuthDep, CurrentActor, SessionDep
from app.api.errors import business_errors
from app.api.routes.mission_categories import require_admin
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
from app.models.missions import Mission
from app.services import mission_context, mission_sources, missions
from app.services import mission_creator_prompt as creator_prompt
from app.services.errors import InvalidFieldError, NotFoundError
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


class ContextRefIn(StrictModel):
    """A VIPER record supplied as read-only context (never a target)."""

    kind: Literal["company", "prospect", "warehouse"]
    id: uuid.UUID
    note: str | None = Field(default=None, max_length=500)


class MissionIn(StrictModel):
    """The rule. `category_id` picks the product category (its icon, colour, general prompt and
    default skills); `type` is the technical discriminator, deduced from the category and optional
    (a bare `type` resolves to its built-in category). `prompt` and `skill_ids` follow the
    category unless sent: `null` = inherit, a value = override; `source_ids` follows the same
    rule (the category's default external sources, else the mission's own list). `context_refs` are
    read-only internal records, distinct from `targets` (omitted on « Modifier » = kept). On
    « Modifier », a field left out keeps its value and its inherited/overridden state."""

    name: str = Field(min_length=1, max_length=200)
    type: MissionType | None = None
    category_id: uuid.UUID | None = None
    prompt: str | None = Field(default=None, min_length=1, max_length=5000)
    skill_ids: list[uuid.UUID] | None = Field(default=None, max_length=100)
    targets: list[TargetIn] = Field(default_factory=list, max_length=500)
    source_ids: list[uuid.UUID] | None = Field(default=None, max_length=100)
    context_refs: list[ContextRefIn] | None = Field(default=None, max_length=50)
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


class MissionPatchIn(StrictModel):
    """Partial edit: `status` and/or `source_ids` (null = follow the category's default sources, a
    list = the mission's own, [] = no source at all). Only what is sent changes."""

    status: MissionStatus | None = None
    source_ids: list[uuid.UUID] | None = Field(default=None, max_length=100)


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


class SourceRefOut(BaseModel):
    id: uuid.UUID
    url: str
    label: str | None


class InheritanceOut(BaseModel):
    """Which category-derived fields the mission still follows (`prompt`, `skills`, `sources`)."""

    category_id: uuid.UUID | None
    overridden_fields: list[str]
    prompt_inherited: bool
    skills_inherited: bool
    category_prompt: str | None
    category_skills: list[SkillRefOut]
    sources_inherited: bool = True
    category_sources: list[SourceRefOut] = Field(default_factory=list)


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
    """An external source of the library: a root (`parent_id` null) or one sub-source level.
    `successful_uses` counts accepted items this source supported; `rolled_up_uses` adds its
    sub-sources'. A visit never counts."""

    id: uuid.UUID
    url: str
    label: str | None
    description: str | None = None
    domain: str = ""
    path_prefix: str = ""
    parent_id: uuid.UUID | None = None
    children_count: int = 0
    successful_uses: int = 0
    rolled_up_uses: int = 0
    missions_count: int
    categories_count: int = 0
    created_at: datetime | None = None


class SourceIn(StrictModel):
    url: str = Field(min_length=1, max_length=2000)
    label: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    # Omitted: a URL under an existing root of its site is filed there automatically.
    parent_id: uuid.UUID | None = None


class SourceUpdateIn(StrictModel):
    """Only what is sent changes. `parent_id: null` makes the source a root."""

    label: str | None = Field(default=None, max_length=200)
    description: str | None = Field(default=None, max_length=1000)
    parent_id: uuid.UUID | None = None


class CitationOut(BaseModel):
    """The concrete URL an agent cited for an accepted item (kept even when the library shows
    only the root / sub-source it rolled up to)."""

    id: uuid.UUID
    url: str
    item_key: str
    field: str | None
    quote: str | None
    confidence: int | None
    source_published_at: date | None
    source_checked_at: datetime | None
    source_id: uuid.UUID | None
    result_id: uuid.UUID
    mission_id: uuid.UUID | None
    created_at: datetime


class ContextRefOut(BaseModel):
    """A linked internal record. Read-only context: not a target, not evidence."""

    kind: Literal["company", "prospect", "warehouse"]
    id: uuid.UUID
    label: str
    hint: str | None
    note: str | None


class ContextResolvedOut(BaseModel):
    """What the agent would receive for one context record (allowlisted fields only)."""

    kind: Literal["company", "prospect", "warehouse"]
    id: uuid.UUID
    label: str
    note: str | None
    read_only: Literal[True]
    fields: dict[str, Any]


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
    # External sources the mission works with (its own list, else its category's defaults).
    sources: list[SourceOut]
    # Internal records linked as read-only context (not targets).
    context_refs: list[ContextRefOut] = Field(default_factory=list)
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
        context_refs=[
            ContextRefOut.model_validate(row, from_attributes=True) for row in detail.context_refs
        ],
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
        source_ids=tuple(body.source_ids) if body.source_ids is not None else None,
        context_refs=(
            tuple(
                mission_context.ContextRefInput(ref.kind, ref.id, ref.note)
                for ref in body.context_refs
            )
            if body.context_refs is not None
            else None
        ),
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
            for name, field_name in (
                ("prompt", "prompt"),
                ("skills", "skill_ids"),
                ("sources", "source_ids"),
            )
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


@router.get("/context-candidates")
def mission_context_candidates(
    session: SessionDep,
    kind: Annotated[Literal["company", "prospect", "warehouse"], Query()] = "company",
    q: Annotated[str | None, Query(max_length=200)] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 20,
) -> list[TargetOut]:
    """Search the internal records a mission may link as read-only context (same picker shape as
    `/targets`, but linked through `context_refs`, never as a target)."""
    return [
        TargetOut.model_validate(row) for row in missions.target_options(session, kind, q, limit)
    ]


@router.get("/sources")
def mission_source_library(
    session: SessionDep,
    q: Annotated[str | None, Query(max_length=200)] = None,
    parent_id: Annotated[uuid.UUID | None, Query()] = None,
    roots_only: Annotated[bool, Query()] = False,
    min_successful_uses: Annotated[int | None, Query(ge=0)] = None,
    order: Annotated[Literal["recent", "name", "uses"], Query()] = "recent",
) -> list[SourceOut]:
    """The external source library (flat; nest with `parent_id`). Filters: `q` (label, URL, domain,
    description), `parent_id` (one root's sub-sources), `roots_only`, `min_successful_uses`
    (roll-up); `order`: `recent`, `name`, `uses`."""
    with business_errors():
        rows = mission_sources.list_sources(
            session,
            q=q,
            parent_id=parent_id,
            roots_only=roots_only,
            min_successful_uses=min_successful_uses,
            order=order,
        )
    return [SourceOut.model_validate(row, from_attributes=True) for row in rows]


@router.post("/sources", status_code=status.HTTP_201_CREATED)
def add_mission_source(body: SourceIn, session: SessionDep, actor: CurrentActor) -> SourceOut:
    with business_errors():
        row = mission_sources.add_source(
            session,
            actor,
            body.url,
            body.label,
            description=body.description,
            parent_id=body.parent_id,
        )
    return SourceOut.model_validate(row, from_attributes=True)


@router.get("/sources/{source_id}")
def get_mission_source(source_id: uuid.UUID, session: SessionDep) -> SourceOut:
    with business_errors():
        row = mission_sources.get_source(session, source_id)
    return SourceOut.model_validate(row, from_attributes=True)


@router.patch("/sources/{source_id}")
def update_mission_source(
    source_id: uuid.UUID, body: SourceUpdateIn, session: SessionDep, auth: AuthDep
) -> SourceOut:
    """Edit a library source (label, description, place in the hierarchy): administrators only."""
    with business_errors():
        require_admin(auth)
        row = mission_sources.update_source(
            session, source_id, fields=body.model_dump(include=body.model_fields_set)
        )
    return SourceOut.model_validate(row, from_attributes=True)


@router.get("/sources/{source_id}/citations")
def mission_source_citations(
    source_id: uuid.UUID,
    session: SessionDep,
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> list[CitationOut]:
    """The concrete cited URLs behind a source (and its sub-sources), newest first."""
    with business_errors():
        rows = mission_sources.list_citations(session, source_id, limit=limit)
    return [CitationOut.model_validate(row, from_attributes=True) for row in rows]


@router.delete("/sources/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_mission_source(source_id: uuid.UUID, session: SessionDep) -> None:
    with business_errors():
        mission_sources.delete_source(session, source_id)


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
    body: MissionPatchIn,
    session: SessionDep,
    actor: CurrentActor,
) -> MissionDetailOut:
    with business_errors():
        sent = body.model_fields_set
        if "status" in sent and body.status is None:
            raise InvalidFieldError("status", "A status is required.", "empty")
        if not sent & {"status", "source_ids"}:
            raise InvalidFieldError("status", "Nothing to change.", "empty")
        if body.status is not None:
            missions.set_status(session, actor, mission_id, body.status)
        if "source_ids" in sent:
            missions.set_sources(
                session,
                actor,
                mission_id,
                tuple(body.source_ids) if body.source_ids is not None else None,
            )
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


def _mission_or_404(session: SessionDep, mission_id: uuid.UUID) -> Mission:
    mission = session.get(Mission, mission_id)
    if mission is None:
        raise NotFoundError("Unknown mission.")
    return mission


@router.get("/{mission_id}/context")
def mission_context_preview(
    mission_id: uuid.UUID, session: SessionDep
) -> list[ContextResolvedOut]:
    """The context the agent would receive now: each linked record through its allowlist
    (read-only; targets are not part of it)."""
    with business_errors():
        _mission_or_404(session, mission_id)
        resolved = mission_context.resolve(session, mission_id)
    return [ContextResolvedOut.model_validate(row) for row in resolved]


@router.post("/{mission_id}/context", status_code=status.HTTP_201_CREATED)
def link_mission_context(
    mission_id: uuid.UUID, body: ContextRefIn, session: SessionDep
) -> list[ContextRefOut]:
    """Link one internal record as read-only context (idempotent)."""
    with business_errors():
        mission = _mission_or_404(session, mission_id)
        mission_context.add_ref(
            session, mission, mission_context.ContextRefInput(body.kind, body.id, body.note)
        )
        rows = mission_context.list_refs(session, mission_id)
    return [ContextRefOut.model_validate(row, from_attributes=True) for row in rows]


@router.delete(
    "/{mission_id}/context/{kind}/{record_id}", status_code=status.HTTP_204_NO_CONTENT
)
def unlink_mission_context(
    mission_id: uuid.UUID,
    kind: Literal["company", "prospect", "warehouse"],
    record_id: uuid.UUID,
    session: SessionDep,
) -> None:
    with business_errors():
        mission = _mission_or_404(session, mission_id)
        if not mission_context.remove_ref(session, mission, kind, record_id):
            raise NotFoundError("This record is not linked as context.")


@router.delete("/{mission_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_mission(mission_id: uuid.UUID, session: SessionDep, actor: CurrentActor) -> None:
    """« Supprimer la mission »: its open tasks are cancelled, then the mission goes."""
    with business_errors():
        missions.delete(session, actor, mission_id)
