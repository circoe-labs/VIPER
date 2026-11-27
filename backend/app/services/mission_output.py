"""The output contract of a claimed task, and the numbers that bound a run.

- the **output contract** (`output_contract`): the versioned envelope a claimed task must answer
  with, derived from the task type and the run's rule (`items_per_task`). `check_submission`
  enforces it before the existing normalisation / review (`agent_payloads.build_proposal`,
  `agent_review`) turns the answer into a proposal;
- **one task, one item**: a discovery task (a company / warehouse, or a person at a company) of a
  mission run brings one item, and the run holds as many tasks as the mission asks for
  (`Mission.task_count`). Only the « Dépôt » mission takes a list (`DEPOSIT_ITEMS_PER_TASK`).

Contract: `doc/architecture/agent-missions.md` §6b, `doc/architecture/missions.md` §4b.
"""

from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.models.agent_missions import AgentTask
from app.models.enums import AgentTaskType
from app.services.errors import InvalidFieldError

# Bumped when the envelope, the omission rules or the outcome vocabulary change.
OUTPUT_CONTRACT_VERSION = 2

# A normal mission asks one item of each discovery task; a « Dépôt » drop may bring a list.
ITEMS_PER_TASK = 1
DEPOSIT_ITEMS_PER_TASK = 50
# The task types whose run holds one task per wanted item.
ONE_ITEM_TYPES = frozenset({AgentTaskType.FIND_PROSPECTS, AgentTaskType.FIND_EMPLOYEES})

OUTCOME_COMPLETED: Literal["completed"] = "completed"
OUTCOME_NOT_FOUND = "not_found"
OUTCOME_BLOCKED = "blocked"
# The ways a task ends without proposing anything.
NO_DATA_OUTCOMES = (OUTCOME_NOT_FOUND, OUTCOME_BLOCKED)

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


# --- output contract ----------------------------------------------------------------------------


def items_cap(
    task_type: AgentTaskType,
    rule: Mapping[str, Any] | None,
    model_schema: Mapping[str, Any],
) -> int:
    """The most items one submission of this task may propose. A targeted task carries one record;
    a discovery task of a mission run carries the rule's `items_per_task`; the rest (monitoring
    signals, a tool-mode task) is bounded by the result schema only."""
    field = LIST_FIELDS.get(task_type)
    if field is None:
        return 1
    declared = int(model_schema["properties"][field]["maxItems"])
    if rule is None or task_type not in ONE_ITEM_TYPES:
        return declared
    return min(declared, int(rule.get("items_per_task") or ITEMS_PER_TASK))


def output_contract(
    task_type: AgentTaskType, model_schema: dict[str, Any], rule: Mapping[str, Any] | None
) -> dict[str, Any]:
    """The contract published with a claimed task. Deterministic: same inputs, same output.

    `schema` is the task's result JSON Schema, its item list capped; the rest says how to read it.
    """
    schema: dict[str, Any] = {**model_schema, "properties": dict(model_schema["properties"])}
    field = LIST_FIELDS.get(task_type)
    max_items = items_cap(task_type, rule, model_schema)
    if field is not None:
        schema["properties"][field] = {**schema["properties"][field], "maxItems": max_items}
    return {
        "version": OUTPUT_CONTRACT_VERSION,
        "envelope": "list" if max_items > 1 else "single",
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
    task: AgentTask,
    validated: Mapping[str, Any],
    rule: Mapping[str, Any] | None,
    model_schema: Mapping[str, Any],
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
    if field is not None and count > (cap := items_cap(task.type, rule, model_schema)):
        raise InvalidFieldError(
            field,
            f"This task takes at most {cap} item(s): leave the others to the run's other tasks.",
            "too_many",
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
