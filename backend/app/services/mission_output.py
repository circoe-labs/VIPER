"""Mission objective and output contract: what « done » means, and what an agent may return.

Two small, deterministic pieces owned by the mission, with no write path of their own:

- the **objective** (`MissionObjective`): a typed, machine-evaluable goal. VIPER decides whether a
  run (and, for a one-off, the mission) is complete from server-side task / result / review
  state (`progress`), never from an agent claiming it is finished;
- the **output contract** (`output_contract`): the versioned envelope a claimed task must answer
  with, derived from the task type and the mission rule (`allow_multiple`, `result_limit`).
  `check_submission` enforces it before the existing normalisation / review
  (`agent_payloads.build_proposal`, `agent_review`) turns the answer into a proposal.

`result_limit` stays a per-run **cap** on items; the objective is the goal. They are never the
same field. Contract: `doc/architecture/agent-missions.md` §6b, `doc/architecture/missions.md` §4b.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.agent_missions import AgentTask, AgentTaskResult
from app.models.enums import AgentResultStatus, AgentTaskStatus, AgentTaskType
from app.services.errors import InvalidFieldError

# Bumped when the envelope, the omission rules or the outcome vocabulary change.
OUTPUT_CONTRACT_VERSION = 1

OBJECTIVE_TASKS_ACCEPTED: Literal["tasks_accepted"] = "tasks_accepted"
OBJECTIVE_ACCEPTED_ITEMS = "accepted_items"
OBJECTIVE_MAX_COUNT = 500

OUTCOME_COMPLETED: Literal["completed"] = "completed"
OUTCOME_NOT_FOUND = "not_found"
OUTCOME_BLOCKED = "blocked"

# The result field that carries the items of a discovery-style task.
LIST_FIELDS: dict[AgentTaskType, str] = {
    AgentTaskType.FIND_PROSPECTS: "companies",
    AgentTaskType.FIND_EMPLOYEES: "people",
    AgentTaskType.SURVEIL_SIGNALS: "signals",
}
# Result keys that are never proposed changes: the bookkeeping around them.
_BOOKKEEPING = frozenset({"outcome", "confidence", "notes", "evidence", "summary"})

OMISSION_RULE = (
    "Omit every field whose value would not change: an absent field means no proposed change. "
    "Never send null, an empty list or a copy of the current value to say « unchanged ». "
    "Clearing an existing value is not possible through a result."
)


class OutcomeFields(BaseModel):
    """Shared head of every task result: how the work ended."""

    outcome: Literal["completed", "not_found", "blocked"] = Field(
        OUTCOME_COMPLETED,
        description=(
            "completed: you propose data. not_found: you looked properly and there is nothing to "
            "propose. blocked: you could not reach the sources. For not_found / blocked propose "
            "no data at all and say what you searched in `notes`; never invent a value."
        ),
    )


class MissionObjective(BaseModel):
    """The goal of a mission run, evaluated by VIPER from accepted work."""

    model_config = ConfigDict(extra="forbid")

    kind: Literal["tasks_accepted", "accepted_items"] = OBJECTIVE_TASKS_ACCEPTED
    # `accepted_items` only: how many reviewed-and-accepted items fulfil one run.
    count: int | None = Field(None, ge=1, le=OBJECTIVE_MAX_COUNT)


DEFAULT_OBJECTIVE: dict[str, Any] = {"kind": OBJECTIVE_TASKS_ACCEPTED, "count": None}


def parse_objective(raw: Mapping[str, Any] | None) -> dict[str, Any]:
    """The effective objective (`None` = the default: every task of the run accepted).
    Raises `InvalidFieldError` on a malformed one."""
    if raw is None:
        return dict(DEFAULT_OBJECTIVE)
    try:
        objective = MissionObjective.model_validate(dict(raw))
    except ValidationError as error:
        first = error.errors()[0]
        field = ".".join(["objective", *(str(part) for part in first["loc"])])
        raise InvalidFieldError(field, first["msg"], "invalid") from error
    if objective.kind == OBJECTIVE_ACCEPTED_ITEMS and objective.count is None:
        raise InvalidFieldError("objective.count", "A count is required.", "missing")
    if objective.kind == OBJECTIVE_TASKS_ACCEPTED and objective.count is not None:
        raise InvalidFieldError("objective.count", "Not used by this kind.", "invalid")
    return objective.model_dump()


# --- output contract ----------------------------------------------------------------------------


def _list_cap(schema: dict[str, Any], field: str, allow_multiple: bool, limit: int | None) -> int:
    declared = schema["properties"][field].get("maxItems") or OBJECTIVE_MAX_COUNT
    if not allow_multiple:
        return 1
    return min(declared, limit) if limit is not None else int(declared)


def output_contract(
    task_type: AgentTaskType,
    model_schema: dict[str, Any],
    *,
    allow_multiple: bool,
    result_limit: int | None,
) -> dict[str, Any]:
    """The contract published with a claimed task. Deterministic: same inputs, same output.

    `schema` is the task's result JSON Schema, its item list capped by the envelope; the rest says
    how to read it. Targeted tasks (one company / person) carry a single record whatever
    `allow_multiple` says: one target per task.
    """
    schema: dict[str, Any] = {**model_schema, "properties": dict(model_schema["properties"])}
    field = LIST_FIELDS.get(task_type)
    max_items = 1
    if field is not None:
        max_items = _list_cap(schema, field, allow_multiple, result_limit)
        schema["properties"][field] = {**schema["properties"][field], "maxItems": max_items}
    return {
        "version": OUTPUT_CONTRACT_VERSION,
        "envelope": "list" if field is not None and allow_multiple else "single",
        "allow_multiple": allow_multiple,
        "items_field": field,
        "max_items": max_items,
        "one_target_per_task": field is None,
        "omit_unchanged": True,
        "outcomes": {
            OUTCOME_COMPLETED: "you propose data (the default)",
            OUTCOME_NOT_FOUND: "nothing to propose after a real search; no data, explain in notes",
            OUTCOME_BLOCKED: "sources unreachable; no data, explain in notes",
        },
        "rules": [
            OMISSION_RULE,
            "Return a proposal only: VIPER normalises it and a person reviews it before anything "
            "is written. You have no write access to the base.",
            "Every proposed value cites a public source in `evidence`; notes stay short and "
            "factual (no reasoning).",
            (
                f"At most {max_items} item(s) in `{field}`."
                if field
                else "One record: the task's subject."
            ),
        ],
        "schema": schema,
    }


def check_submission(
    task: AgentTask, validated: Mapping[str, Any], rule: Mapping[str, Any] | None
) -> str:
    """Enforce the contract on a result already valid against its model. Returns the outcome.
    Raises `InvalidFieldError` (the agent may fix it: the task stays claimed)."""
    outcome = str(validated.get("outcome") or OUTCOME_COMPLETED)
    field = LIST_FIELDS.get(task.type)
    items = validated.get(field) if field else None
    count = len(items) if isinstance(items, list) else 0
    if outcome != OUTCOME_COMPLETED:
        proposed = [
            key
            for key, value in validated.items()
            if key not in _BOOKKEEPING and value not in (None, [], {}, "")
        ]
        if proposed:
            raise InvalidFieldError(
                proposed[0], f"A {outcome} result proposes no data.", "outcome_with_data"
            )
        if not str(validated.get("notes") or "").strip():
            raise InvalidFieldError("notes", f"Say what you searched ({outcome}).", "missing")
        return outcome
    # A legacy rule (a run made before migration 0049) kept the list form.
    allow_multiple = bool(rule.get("allow_multiple", True)) if rule is not None else True
    if field is not None and not allow_multiple and count > 1:
        raise InvalidFieldError(
            field, "This mission returns one item at a time (allow_multiple=false).", "too_many"
        )
    return outcome


def no_result_proposal(outcome: str, validated: Mapping[str, Any]) -> dict[str, Any]:
    """The reviewable reading of a not_found / blocked answer: nothing to apply."""
    return {
        "kind": "no_result",
        "outcome": outcome,
        "items": [],
        "refused": [],
        "stale": False,
        "confidence": validated.get("confidence"),
        "notes": validated.get("notes"),
    }


# --- progress -----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Progress:
    """Where a run stands against its objective, from server-side state only."""

    kind: str
    target: int | None
    current: int
    met: bool
    tasks_total: int
    tasks_accepted: int
    items_accepted: int
    last_accepted_items: int

    def as_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "target": self.target,
            "current": self.current,
            "met": self.met,
        }


def progress(
    session: Session, tasks: Sequence[AgentTask], objective: Mapping[str, Any] | None
) -> Progress:
    """Evaluate `objective` over a run's `tasks` (cancelled ones do not count)."""
    spec = parse_objective(objective)
    live = [task for task in tasks if task.status is not AgentTaskStatus.CANCELLED]
    accepted = [task for task in live if task.status is AgentTaskStatus.ACCEPTED]
    counts: dict[Any, int] = {}
    last_items = 0
    if live:
        rows = session.execute(
            select(
                AgentTaskResult.task_id, AgentTaskResult.accepted_items, AgentTaskResult.decided_at
            )
            .where(
                AgentTaskResult.task_id.in_([task.id for task in live]),
                AgentTaskResult.status == AgentResultStatus.ACCEPTED,
            )
            .order_by(AgentTaskResult.decided_at)
        ).all()
        for task_id, accepted_items, _ in rows:
            keys = (accepted_items or {}).get("keys", [])
            counts[task_id] = counts.get(task_id, 0) + len(keys)
            last_items = len(keys)
    items = sum(counts.values())
    if spec["kind"] == OBJECTIVE_ACCEPTED_ITEMS:
        target: int | None = int(spec["count"])
        current, met = items, items >= int(spec["count"])
    else:
        target = len(live) or None
        current, met = len(accepted), bool(live) and len(accepted) == len(live)
    return Progress(
        kind=spec["kind"],
        target=target,
        current=current,
        met=met,
        tasks_total=len(live),
        tasks_accepted=len(accepted),
        items_accepted=items,
        last_accepted_items=last_items,
    )
