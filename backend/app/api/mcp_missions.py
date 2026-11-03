"""The mission actions of `/mcp`: what an assistant (ChatGPT, claude.ai) does with a mission for
the person it acts for — read the form's options, create (and launch), modify, launch, pause,
resume, cancel, delete.

An assistant manages **missions**, never raw tasks: VIPER derives the tasks of each run (there is
no `create_task` tool, HANDOFF §4). Every tool parses its arguments with the REST input model
(`routes/missions.MissionIn`) and calls the same service as the page (`app.services.missions`),
then answers with the page's output model (`MissionDetailOut`). The acting agent is the actor the
endpoint already bound, with its delegated person as `on_behalf_of`.

Each tool names the capabilities it needs for the given arguments (`required`); the MCP endpoint
checks every one with `require` before the handler runs. Contract:
`doc/architecture/mcp-server.md` §3.10.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api.mcp_conversational import READ_ONLY_ANNOTATIONS
from app.api.routes import missions as mission_routes
from app.core.actor import ActorContext
from app.models.enums import MissionStatus
from app.models.missions import Mission, MissionTarget
from app.services import agent_capabilities as caps
from app.services import missions
from app.services.errors import InvalidFieldError, NotFoundError

# Advisory hints for the host (MCP `ToolAnnotations`); authorization stays server-side.
WRITE_ANNOTATIONS: dict[str, bool] = {
    "readOnlyHint": False,
    "destructiveHint": False,
    "openWorldHint": False,
}
DESTRUCTIVE_ANNOTATIONS: dict[str, bool] = {
    "readOnlyHint": False,
    "destructiveHint": True,
    "openWorldHint": False,
}

# The statuses an assistant may set. `done` is reached by the rule itself (end date, run count).
SETTABLE_STATUSES = (MissionStatus.PAUSED, MissionStatus.ACTIVE, MissionStatus.CANCELLED)
TARGET_OPTIONS_MAX = 50


@dataclass(frozen=True, slots=True)
class MissionContext:
    session: Session
    # The agent, bound as the audit actor for this request (its person rides as `on_behalf_of`).
    actor: ActorContext


type Handler = Callable[[MissionContext, dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True, slots=True)
class MissionTool:
    name: str
    description: str
    input_schema: dict[str, Any]
    annotations: dict[str, bool]
    # The capabilities this call needs, read from the raw arguments before anything is parsed.
    required: Callable[[dict[str, Any]], tuple[str, ...]]
    handler: Handler

    def definition(self) -> dict[str, Any]:
        """The `tools/list` entry."""
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
            "annotations": self.annotations,
        }


# --- the input schema: `MissionIn`, with its `$ref`s inlined ----------------------------------


def _inline(node: Any, defs: dict[str, Any]) -> Any:
    """Resolve the local `#/$defs/…` references pydantic emits, so a host that does not follow
    `$ref` still sees every enum."""
    if isinstance(node, dict):
        ref = node.get("$ref")
        if isinstance(ref, str) and ref.startswith("#/$defs/"):
            rest = {key: value for key, value in node.items() if key != "$ref"}
            return {**_inline(defs[ref.removeprefix("#/$defs/")], defs), **_inline(rest, defs)}
        return {key: _inline(value, defs) for key, value in node.items() if key != "$defs"}
    if isinstance(node, list):
        return [_inline(item, defs) for item in node]
    return node


def _mission_schema() -> dict[str, Any]:
    schema = mission_routes.MissionIn.model_json_schema()
    inlined: dict[str, Any] = _inline(schema, schema.get("$defs", {}))
    return inlined


_MISSION_SCHEMA = _mission_schema()
_MISSION_ID = {"type": "string", "format": "uuid"}


def _update_schema() -> dict[str, Any]:
    properties = {
        key: value for key, value in _MISSION_SCHEMA["properties"].items() if key != "run_now"
    }
    return {
        "type": "object",
        "properties": {"mission_id": _MISSION_ID, **properties},
        "required": ["mission_id"],
        "additionalProperties": False,
    }


# --- argument parsing (the JSON Schema is advisory: a client may send anything) ----------------


def _mission_in(values: dict[str, Any]) -> mission_routes.MissionIn:
    """`MissionIn` from tool arguments; its first complaint becomes the refusal."""
    try:
        return mission_routes.MissionIn.model_validate(values)
    except ValidationError as error:
        first = error.errors()[0]
        field = ".".join(str(part) for part in first["loc"]) or "arguments"
        reason = "missing" if first["type"] == "missing" else "invalid"
        raise InvalidFieldError(field, first["msg"], reason) from error


def _mission_id(args: dict[str, Any]) -> uuid.UUID:
    try:
        return uuid.UUID(str(args.get("mission_id")))
    except (TypeError, ValueError) as error:
        raise InvalidFieldError("mission_id", "Expected a UUID.", "format") from error


def _status(args: dict[str, Any]) -> MissionStatus:
    value = args.get("status")
    allowed = [status.value for status in SETTABLE_STATUSES]
    if not isinstance(value, str) or value not in allowed:
        raise InvalidFieldError("status", f"Expected one of: {', '.join(allowed)}.", "format")
    return MissionStatus(value)


def _detail(ctx: MissionContext, mission_id: uuid.UUID) -> dict[str, Any]:
    detail = mission_routes.detail_out(missions.detail(ctx.session, mission_id))
    dumped: dict[str, Any] = detail.model_dump(mode="json")
    return dumped


def _current_rule(session: Session, mission_id: uuid.UUID) -> dict[str, Any]:
    """The mission's rule as `MissionIn` values, so a modification may send only what changes."""
    mission = session.get(Mission, mission_id)
    if mission is None:
        raise NotFoundError("Unknown mission.")
    rule = {name: getattr(mission, name) for name in missions.EDITED_FIELDS}
    targets = session.scalars(
        select(MissionTarget)
        .where(MissionTarget.mission_id == mission_id)
        .order_by(MissionTarget.created_at)
    ).all()
    rule["targets"] = [
        {"kind": "company", "id": target.company_id}
        if target.company_id is not None
        else {"kind": "prospect", "id": target.prospect_id}
        for target in targets
    ]
    return rule


# --- required capabilities ---------------------------------------------------------------------


def _create_requires(args: dict[str, Any]) -> tuple[str, ...]:
    # Any value `MissionIn` reads as true is truthy here, so launching always needs `missions.run`
    # (a falsy-looking string such as "false" over-asks, never under-asks).
    if args.get("run_now"):
        return (caps.MISSIONS_WRITE, caps.MISSIONS_RUN)
    return (caps.MISSIONS_WRITE,)


def _status_requires(args: dict[str, Any]) -> tuple[str, ...]:
    # `_status` accepts exactly these strings, so the capability checked is the one used.
    if args.get("status") == MissionStatus.CANCELLED.value:
        return (caps.MISSIONS_CANCEL,)
    return (caps.MISSIONS_PAUSE,)


def _only(capability: str) -> Callable[[dict[str, Any]], tuple[str, ...]]:
    return lambda args: (capability,)


# --- handlers ----------------------------------------------------------------------------------


def _create(ctx: MissionContext, args: dict[str, Any]) -> dict[str, Any]:
    body = _mission_in(args)
    mission = missions.create(
        ctx.session, ctx.actor, mission_routes.mission_input(body), run_now=body.run_now
    )
    return _detail(ctx, mission.id)


def _update(ctx: MissionContext, args: dict[str, Any]) -> dict[str, Any]:
    mission_id = _mission_id(args)
    changes = {key: value for key, value in args.items() if key != "mission_id"}
    if "run_now" in changes:
        raise InvalidFieldError(
            "run_now", "Modifying never launches: call viper_run_mission.", "invalid"
        )
    body = _mission_in({**_current_rule(ctx.session, mission_id), **changes})
    missions.update(ctx.session, ctx.actor, mission_id, mission_routes.mission_input(body))
    return _detail(ctx, mission_id)


def _run(ctx: MissionContext, args: dict[str, Any]) -> dict[str, Any]:
    mission_id = _mission_id(args)
    run = missions.run_mission(ctx.session, ctx.actor, mission_id)
    return {"run_id": str(run.id), **_detail(ctx, mission_id)}


def _set_status(ctx: MissionContext, args: dict[str, Any]) -> dict[str, Any]:
    mission_id = _mission_id(args)
    missions.set_status(ctx.session, ctx.actor, mission_id, _status(args))
    return _detail(ctx, mission_id)


def _delete(ctx: MissionContext, args: dict[str, Any]) -> dict[str, Any]:
    mission_id = _mission_id(args)
    missions.delete(ctx.session, ctx.actor, mission_id)
    return {"deleted": True, "mission_id": str(mission_id)}


def _target_kind(args: dict[str, Any]) -> Literal["company", "prospect"] | None:
    value = args.get("target_kind")
    if value is None:
        return None
    if value == "company":
        return "company"
    if value == "prospect":
        return "prospect"
    raise InvalidFieldError("target_kind", "Expected one of: company, prospect.", "format")


def _options(ctx: MissionContext, args: dict[str, Any]) -> dict[str, Any]:
    answer: dict[str, Any] = {
        "options": mission_routes.MissionOptionsOut.model_validate(missions.options()).model_dump(
            mode="json"
        ),
        "agents": [
            mission_routes.AgentOut.model_validate(row).model_dump(mode="json")
            for row in missions.agents(ctx.session)
        ],
    }
    kind = _target_kind(args)
    if kind is not None:
        search = args.get("target_search")
        if search is not None and not isinstance(search, str):
            raise InvalidFieldError("target_search", "Expected a string.", "format")
        answer["targets"] = [
            mission_routes.TargetOut.model_validate(row).model_dump(mode="json")
            for row in missions.target_options(ctx.session, kind, search, TARGET_OPTIONS_MAX)
        ]
    return answer


# --- catalogue ---------------------------------------------------------------------------------

_BY_ID: dict[str, Any] = {
    "type": "object",
    "properties": {"mission_id": _MISSION_ID},
    "required": ["mission_id"],
    "additionalProperties": False,
}

TOOLS: tuple[MissionTool, ...] = (
    MissionTool(
        name="viper_mission_options",
        description=(
            "What a mission may be: its types and expected results (and which ones can run "
            "today), recurrence units, end kinds, the result limit, and the agents that may be "
            "assigned. Pass `target_kind` (and `target_search`) to find companies or people to "
            "link as targets. Call it before viper_create_mission when unsure."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "target_kind": {"type": "string", "enum": ["company", "prospect"]},
                "target_search": {"type": "string", "maxLength": 200},
            },
            "additionalProperties": False,
        },
        annotations=READ_ONLY_ANNOTATIONS,
        required=_only(caps.MISSIONS_READ),
        handler=_options,
    ),
    MissionTool(
        name="viper_create_mission",
        description=(
            "Create a mission: VIPER derives the agent tasks of each run from it. Discovery "
            "(prospection → companies) needs no target; enrichment, verification, signals and "
            "prospection → prospects work on linked companies or people (`targets`, ids from "
            "viper_search or viper_mission_options). `run_now: true` also launches a first run. "
            "Returns the mission as viper_get_mission does."
        ),
        input_schema=_MISSION_SCHEMA,
        annotations=WRITE_ANNOTATIONS,
        required=_create_requires,
        handler=_create,
    ),
    MissionTool(
        name="viper_update_mission",
        description=(
            "Modify a mission's rule. Send `mission_id` and only the fields that change; each "
            "field sent replaces its value (`targets` replaces the whole list). Runs already "
            "made and their tasks keep the rule they were created with; the next runs follow "
            "the new one. A done or cancelled mission cannot be modified."
        ),
        input_schema=_update_schema(),
        annotations=WRITE_ANNOTATIONS,
        required=_only(caps.MISSIONS_WRITE),
        handler=_update,
    ),
    MissionTool(
        name="viper_run_mission",
        description=(
            "Launch one run of an active mission now, whatever its recurrence says. Returns "
            "`run_id` and the mission."
        ),
        input_schema=_BY_ID,
        annotations=WRITE_ANNOTATIONS,
        required=_only(caps.MISSIONS_RUN),
        handler=_run,
    ),
    MissionTool(
        name="viper_set_mission_status",
        description=(
            "Pause (`paused`), resume (`active`) or cancel (`cancelled`) a mission. Cancelling "
            "is final: confirm it with the person first. Pausing and resuming need "
            "missions.pause; cancelling needs missions.cancel (a manager's)."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "mission_id": _MISSION_ID,
                "status": {
                    "type": "string",
                    "enum": [status.value for status in SETTABLE_STATUSES],
                },
            },
            "required": ["mission_id", "status"],
            "additionalProperties": False,
        },
        # The tool can cancel, so the host is told it may destroy; pausing stays reversible.
        annotations=DESTRUCTIVE_ANNOTATIONS,
        required=_status_requires,
        handler=_set_status,
    ),
    MissionTool(
        name="viper_delete_mission",
        description=(
            "Delete a mission, its targets and its runs; its open tasks are cancelled. Results "
            "already accepted stay. Irreversible: confirm it with the person first."
        ),
        input_schema=_BY_ID,
        annotations=DESTRUCTIVE_ANNOTATIONS,
        required=_only(caps.MISSIONS_CANCEL),
        handler=_delete,
    ),
)

BY_NAME: dict[str, MissionTool] = {tool.name: tool for tool in TOOLS}
