"""The conversational read tools of `/mcp`: what an assistant (ChatGPT, claude.ai) reads to answer
a person — global search, dashboard, prospection metrics, missions, pending reviews, contact.

Every tool wraps the service and the REST output model of the page that shows the same thing
(`GET /api/search`, `/api/home`, `/api/prospection/*`, `/api/missions*`, `/api/contact/*`,
`/api/prospects/{id}/messages`), so an assistant and a person read the same figures in the same
shape. No SQL here, no generic query tool; nothing writes. Each tool names the capability it needs
(`records.read`, `dashboard.read`, `missions.read`, `reviews.read`, `contact.read`); the MCP
endpoint checks it before calling the handler. Contract: `doc/architecture/mcp-server.md` §3.9.
"""

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any

from sqlalchemy.orm import Session

from app.api.routes import contact as contact_routes
from app.api.routes import contact_messages as message_routes
from app.api.routes import home as home_routes
from app.api.routes import missions as mission_routes
from app.api.routes import prospection as prospection_routes
from app.api.routes import search as search_routes
from app.models.enums import MissionStatus, MissionType
from app.services import agent_review, contact_scheduling, missions
from app.services import search as search_service
from app.services.contact_dashboard import ContactFilters
from app.services.errors import InvalidFieldError
from app.services.prospection import query as prospection_query
from app.services.prospection.query import ProspectFilters
from app.services.prospection.segments import Segment

# Advisory hints for the host (MCP 2025-06-18 `ToolAnnotations`); authorization stays server-side.
READ_ONLY_ANNOTATIONS: dict[str, bool] = {
    "readOnlyHint": True,
    "destructiveHint": False,
    "openWorldHint": False,
}
MAX_ADDED_WITHIN_DAYS = 366

_NO_ARGUMENTS: dict[str, Any] = {"type": "object", "properties": {}, "additionalProperties": False}


@dataclass(frozen=True, slots=True)
class ReadContext:
    session: Session
    # The app's `State` (settings, Toolbox, dispatcher): what the REST routes read from `request`.
    state: Any


type Handler = Callable[[ReadContext, dict[str, Any]], dict[str, Any]]


@dataclass(frozen=True, slots=True)
class ReadTool:
    name: str
    capability: str
    description: str
    input_schema: dict[str, Any]
    handler: Handler

    def definition(self) -> dict[str, Any]:
        """The `tools/list` entry."""
        return {
            "name": self.name,
            "description": self.description,
            "inputSchema": self.input_schema,
            "annotations": READ_ONLY_ANNOTATIONS,
        }


# --- argument parsing (the JSON Schema is advisory: a client may send anything) ----------------


def _uuid_arg(args: dict[str, Any], name: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(args.get(name)))
    except (TypeError, ValueError) as error:
        raise InvalidFieldError(name, "Expected a UUID.", "format") from error


def _enum_arg[E: StrEnum](args: dict[str, Any], name: str, enum: type[E]) -> E | None:
    value = args.get(name)
    if value is None:
        return None
    try:
        return enum(value)
    except ValueError as error:
        allowed = ", ".join(member.value for member in enum)
        raise InvalidFieldError(name, f"Expected one of: {allowed}.", "format") from error


def _text_arg(args: dict[str, Any], name: str) -> str | None:
    value = args.get(name)
    if value is None:
        return None
    if not isinstance(value, str):
        raise InvalidFieldError(name, "Expected a string.", "format")
    return value


def _days_arg(args: dict[str, Any], name: str) -> int | None:
    value = args.get(name)
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise InvalidFieldError(name, "Expected a whole number of days.", "format")
    if not 1 <= value <= MAX_ADDED_WITHIN_DAYS:
        raise InvalidFieldError(name, f"Expected 1 to {MAX_ADDED_WITHIN_DAYS} days.", "range")
    return value


def _json(model: Any) -> dict[str, Any]:
    dumped: dict[str, Any] = model.model_dump(mode="json")
    return dumped


# --- handlers ----------------------------------------------------------------------------------


def _search(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    results = search_service.search(ctx.session, _text_arg(args, "query") or "")
    return _json(search_routes.search_out(results))


def _dashboard(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    return _json(home_routes.home_dashboard(ctx.session, ctx.state.settings))


def _prospection_metrics(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    segment = _enum_arg(args, "segment", Segment)
    days = _days_arg(args, "added_within_days")
    context = prospection_routes.segment_context(ctx.state.settings)
    overview = prospection_query.base_overview(ctx.session, context)
    counters = prospection_query.count_segments(ctx.session, ProspectFilters(), context)
    answer: dict[str, Any] = {
        "overview": _json(
            prospection_routes.OverviewOut.model_validate(overview, from_attributes=True)
        ),
        "counters": _json(
            prospection_routes.CountersOut.model_validate(counters, from_attributes=True)
        ),
    }
    if segment is not None:
        answer["segment"] = {"key": segment.value, "count": counters.counts[segment]}
    if days is not None:
        since = datetime.now(UTC) - timedelta(days=days)
        added = prospection_query.count_added_since(ctx.session, since, context)
        answer["added"] = {
            "days": days,
            "since": since.isoformat(),
            "total": added[Segment.ALL],
            "counts": {key.value: count for key, count in added.items()},
            **({"segment_count": added[segment]} if segment is not None else {}),
        }
    return answer


def _list_missions(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    status = _enum_arg(args, "status", MissionStatus)
    kind = _enum_arg(args, "type", MissionType)
    cards = [
        card
        for card in missions.list_cards(ctx.session, status=status)
        if kind is None or card.type == kind
    ]
    items = [
        mission_routes.MissionCardOut.model_validate(card, from_attributes=True) for card in cards
    ]
    return _json(mission_routes.MissionListOut(items=items, total=len(items)))


def _get_mission(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    detail = missions.detail(ctx.session, _uuid_arg(args, "mission_id"))
    return _json(mission_routes.detail_out(detail))


def _pending_reviews(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    """Tool-mode proposals one by one (with the review card's digest), and the missions whose runs
    hold submitted results (their cards: `results_pending`)."""
    proposals = []
    for row in missions.pending_proposals(ctx.session):
        review = agent_review.get_review(ctx.session, row.result_id)
        proposal = _json(mission_routes.ProposalOut.model_validate(row, from_attributes=True))
        proposals.append({**proposal, "digest": review.result.digest})
    cards = [card for card in missions.list_cards(ctx.session) if card.results_pending > 0]
    mission_cards = [
        _json(mission_routes.MissionCardOut.model_validate(card, from_attributes=True))
        for card in cards
    ]
    return {
        "total": len(proposals) + sum(card.results_pending for card in cards),
        "proposals": proposals,
        "missions": mission_cards,
    }


def _contact_overview(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    week = contact_routes.parse_week(_text_arg(args, "week"))
    dashboard = contact_routes.dashboard_out(ctx.state, ctx.session, ContactFilters(week=week))
    scheduling = contact_scheduling.overview(ctx.session, contact_routes.contact_clock(), week)
    return {
        "dashboard": _json(dashboard),
        "scheduling": _json(
            contact_routes.SchedulingOut.model_validate(scheduling, from_attributes=True)
        ),
    }


def _prospect_messages(ctx: ReadContext, args: dict[str, Any]) -> dict[str, Any]:
    prospect_id = _uuid_arg(args, "prospect_id")
    return _json(message_routes.messages_out(ctx.state, ctx.session, prospect_id))


# --- catalogue ---------------------------------------------------------------------------------

TOOLS: tuple[ReadTool, ...] = (
    ReadTool(
        name="viper_search",
        capability="records.read",
        description=(
            "Find prospects, companies and establishments by name, e-mail, phone, SIREN/SIRET, "
            "domain or city. Use it first to resolve a name into ids before reading a record."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "minLength": search_service.MIN_QUERY_LENGTH,
                    "maxLength": search_service.MAX_QUERY_LENGTH,
                }
            },
            "required": ["query"],
            "additionalProperties": False,
        },
        handler=_search,
    ),
    ReadTool(
        name="viper_get_dashboard",
        capability="dashboard.read",
        description=(
            "The home dashboard: prospect segment counts, companies, data-quality figures, "
            "monthly contact and appointment progress, this week's sends, next actions and recent "
            "activity. Use it for a general 'where do we stand' question."
        ),
        input_schema=_NO_ARGUMENTS,
        handler=_dashboard,
    ),
    ReadTool(
        name="viper_get_prospection_metrics",
        capability="dashboard.read",
        description=(
            "Prospection figures for the whole base: total, contacted and deleted people, every "
            "segment count and the verified / to-verify / ignored reviews. Pass "
            "`added_within_days` for people added in the last N days, `segment` to single one out."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "segment": {"type": "string", "enum": [segment.value for segment in Segment]},
                "added_within_days": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": MAX_ADDED_WITHIN_DAYS,
                },
            },
            "additionalProperties": False,
        },
        handler=_prospection_metrics,
    ),
    ReadTool(
        name="viper_list_missions",
        capability="missions.read",
        description=(
            "List agent missions as cards (status, agent, recurrence, last and next run, pending "
            "results), optionally filtered by `status` or `type`."
        ),
        input_schema={
            "type": "object",
            "properties": {
                "status": {"type": "string", "enum": [status.value for status in MissionStatus]},
                "type": {"type": "string", "enum": [kind.value for kind in MissionType]},
            },
            "additionalProperties": False,
        },
        handler=_list_missions,
    ),
    ReadTool(
        name="viper_get_mission",
        capability="missions.read",
        description=(
            "Read one mission: its configuration, targets, runs, tasks and their results. Use it "
            "after viper_list_missions to explain what a mission did or will do."
        ),
        input_schema={
            "type": "object",
            "properties": {"mission_id": {"type": "string", "format": "uuid"}},
            "required": ["mission_id"],
            "additionalProperties": False,
        },
        handler=_get_mission,
    ),
    ReadTool(
        name="viper_list_pending_reviews",
        capability="reviews.read",
        description=(
            "What agents submitted that still waits for a person's review: each tool-mode "
            "proposal with its subject, author, date and digest, and the missions holding "
            "submitted results. Read-only: accepting or rejecting happens in VIPER."
        ),
        input_schema=_NO_ARGUMENTS,
        handler=_pending_reviews,
    ),
    ReadTool(
        name="viper_get_contact_overview",
        capability="contact.read",
        description=(
            "The contact workload of a week (default: the current one): mails to send by step, "
            "overdue ones, drafts to validate, validated and scheduled mails, forgotten prospects "
            "and whether scheduled sending works. `week` is an ISO week such as 2026-W45."
        ),
        input_schema={
            "type": "object",
            "properties": {"week": {"type": "string", "pattern": r"^\d{4}-W\d{2}$"}},
            "additionalProperties": False,
        },
        handler=_contact_overview,
    ),
    ReadTool(
        name="viper_get_prospect_messages",
        capability="contact.read",
        description=(
            "One prospect's mail sequence: every step (Contact, R1…) with status, recipients, "
            "subject, body, validation, schedule, send and last error. Use it to explain why a "
            "mail did or did not leave."
        ),
        input_schema={
            "type": "object",
            "properties": {"prospect_id": {"type": "string", "format": "uuid"}},
            "required": ["prospect_id"],
            "additionalProperties": False,
        },
        handler=_prospect_messages,
    ),
)

BY_NAME: dict[str, ReadTool] = {tool.name: tool for tool in TOOLS}
