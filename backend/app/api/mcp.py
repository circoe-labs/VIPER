"""VIPER's MCP endpoint: the tools an agent uses to work, and the reads an assistant answers with.

Streamable HTTP, JSON-RPC 2.0, one `POST /mcp` (`initialize` → `notifications/initialized` →
`tools/list` / `tools/call`, and `resources/list` / `resources/read` for the UI templates of
`app.api.mcp_ui`). It lives **outside** `/api` on purpose: the session cookie and the
CSRF header do not apply to a machine, so the route carries its own `Authorization: Bearer` check
(`app.services.mcp_tokens`) and its own actor (`ActorType.AGENT`).

No tool writes a record directly. `viper_submit_task_result` stores a proposal; a person accepts
it in the interface. The conversational reads (search, dashboard, missions, reviews, contact) live
in `app.api.mcp_conversational`; the mission actions (create, modify, launch, pause, cancel,
delete) in `app.api.mcp_missions`; the contact draft tools (a step's mail, always a draft) in
`app.api.mcp_contact`. Contract: `doc/architecture/mcp-server.md` §3.7, §3.9 to §3.11 and
`doc/architecture/agent-missions.md`.

Every tool but `viper_whoami` starts with `require(record, <capability>)`: the call is refused
unless the agent's effective capabilities (its own ∩ its delegated person's role, computed once
per request by `agent_capabilities.grant_for`) include it.
Contract: `doc/architecture/mcp-server.md` §4.7.
"""

import json
import logging
import time
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api import (
    mcp_contact,
    mcp_conversational,
    mcp_missions,
    mcp_queries,
    mcp_telemetry,
    mcp_ui,
)
from app.api.oauth import resource_metadata_url
from app.core.actor import ActorContext, ActorType
from app.db.session import unit_of_work
from app.models.agent_missions import AgentTask
from app.models.enums import AgentTaskStatus, AgentTaskType
from app.models.mcp import McpToken
from app.services import (
    agent_actions,
    agent_capabilities,
    agent_identity,
    agent_lifecycle,
    agent_missions,
    agent_writes,
    audit,
    mcp_calls,
    mcp_reads,
    mcp_tokens,
    missions,
    oauth,
)
from app.services.agent_capabilities import AgentGrant
from app.services.errors import (
    ActorNotAllowedError,
    BusinessRuleError,
    CapabilityDeniedError,
    ConflictError,
    ContactMessageError,
    DomainError,
    InvalidFieldError,
    MailGenerationError,
    NotFoundError,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/mcp", tags=["mcp"])

PROTOCOL_VERSION = "2025-06-18"
SERVER_INFO = {"name": "VIPER", "version": "1.0.0"}
TASK_TYPE_VALUES = [task.value for task in AgentTaskType]
MIN_LEASE_SECONDS = 60
MAX_LEASE_SECONDS = 3600

# The grant of the request being answered (who calls, what it may do). Set by `handle_mcp` for
# the duration of the dispatch; `None` outside it, where `require` refuses everything.
_current_grant: ContextVar[AgentGrant | None] = ContextVar("viper_mcp_grant", default=None)


def require(record: McpToken, capability: str) -> None:
    """The single MCP guard: refuse the tool unless the calling agent `record` holds
    `capability` in this request's grant (its own capabilities ∩ its delegated person's role).

    Raises `CapabilityDeniedError`, which the dispatcher answers as an MCP error with the code
    `capability_denied` and which `mcp_calls` keeps as a refused call.
    """
    if capability not in agent_capabilities.CAPABILITIES:
        # A typo in a tool would otherwise deny it forever without saying why.
        raise ValueError(f"Unknown capability {capability!r}.")
    grant = _current_grant.get()
    # Fails closed: no grant (outside a request) or the grant of another agent allows nothing.
    if grant is None or grant.token.id != record.id or not grant.allows(capability):
        raise CapabilityDeniedError(capability)


@contextmanager
def granted(grant: AgentGrant) -> Iterator[None]:
    """Make `grant` the one `require` checks, for the block."""
    reset = _current_grant.set(grant)
    try:
        yield
    finally:
        _current_grant.reset(reset)


_CLAIM_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "task_types": {
            "type": "array",
            "items": {"type": "string", "enum": TASK_TYPE_VALUES},
            "description": "Restrict to these types; the token's scopes still apply.",
        },
        "thread_id": {"type": "string", "format": "uuid"},
        "mission_id": {
            "type": "string",
            "format": "uuid",
            "description": (
                "Only claim a task of this mission (get it from viper_list_missions): « register "
                "to this mission ». Omit to take the next task of any mission."
            ),
        },
        "lease_seconds": {
            "type": "integer",
            "minimum": MIN_LEASE_SECONDS,
            "maximum": MAX_LEASE_SECONDS,
        },
    },
    "additionalProperties": False,
}
_CLAIMED_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "task_id": {"type": "string", "format": "uuid"},
        "claim_id": {"type": "string", "format": "uuid"},
    },
    "required": ["task_id", "claim_id"],
    "additionalProperties": False,
}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "viper_whoami",
        "description": (
            "Who you are for VIPER: this agent's id, label and numbered identity (« Claude lucie "
            "#2 »), its provider and mode, the person "
            "it acts for (e-mail and role) and their organisation, and the capabilities this "
            "agent may use now. Call it first; a tool outside these capabilities is refused."
        ),
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "viper_claim_task",
        "description": (
            "Claim the next task matching this token's scopes. Returns the mission payload: the "
            "subject, its current values, the missing fields, the sources, and the JSON Schema "
            "the result must follow. A claimed task is leased: send `claim_id` with every later "
            "call, and heartbeat before the lease runs out. To stage individual writes, call "
            "viper_add_company or viper_update_company / viper_update_prospect with task_id, "
            "claim_id and a unique action_id; then submit result {} once for the whole task. "
            "A mission task also opens your work session automatically (nothing to register) and "
            "its payload carries the mission rule (`mission`: instructions, category, skills, "
            "external sources), `internal_context` (read-only VIPER records, not the target), "
            "`output_contract`, `agent` (your numbered identity), `lifecycle` "
            "(submit / release / viper_leave_work) and `telemetry` guidance: log facts (searches, "
            "sources opened, observations, verifications, progress, warnings) with "
            "viper_log_mission_activity, and put a short factual research report in the result "
            "`notes` when you submit."
        ),
        "inputSchema": _CLAIM_SCHEMA,
    },
    {
        "name": "viper_open_deposit",
        "description": (
            "Drop work nobody asked for as a mission: a person tells you directly « ajoute ce "
            "contact », « complète cette société ». It opens a task in the permanent « Dépôt » "
            "mission and claims it for you in one call, and returns the same payload as "
            "viper_claim_task (subject, output schema, `claim_id`). Then work, log, and hand the "
            "job back through the usual process: viper_submit_task_result (a person reviews it), "
            "viper_fail_task or viper_release_task. task_type: find_prospects (a new company, no "
            "subject), find_employees (new people of a company: company_id), update_company "
            "(company_id), update_employee (prospect_id), surveil_signals (company_id). To add a "
            "person whose company is not in VIPER yet, drop find_prospects for the company first."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task_type": {"type": "string", "enum": TASK_TYPE_VALUES},
                "company_id": {"type": "string", "format": "uuid"},
                "prospect_id": {"type": "string", "format": "uuid"},
                "lease_seconds": {
                    "type": "integer",
                    "minimum": MIN_LEASE_SECONDS,
                    "maximum": MAX_LEASE_SECONDS,
                },
            },
            "required": ["task_type"],
            "additionalProperties": False,
        },
    },
    {
        "name": "viper_heartbeat_task",
        "description": (
            "Renew the lease of a claimed task. It also keeps your work session alive; a log "
            "(viper_log_mission_activity) does the same for the session, not for the lease."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                **_CLAIMED_SCHEMA["properties"],
                "lease_seconds": {
                    "type": "integer",
                    "minimum": MIN_LEASE_SECONDS,
                    "maximum": MAX_LEASE_SECONDS,
                },
            },
            "required": ["task_id", "claim_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "viper_submit_task_result",
        "description": (
            "Submit the finished work. The result is validated against the task's output schema "
            "and output_contract (one item unless the contract says list; omit unchanged fields; "
            "outcome not_found or blocked, with notes and no data, when there is nothing to "
            "propose) and stored as a proposal awaiting a person's review — it never writes to "
            "the base. "
            "Put a short factual research report in `notes`: what you searched, which sources you "
            "opened, what you verified or could not find."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                **_CLAIMED_SCHEMA["properties"],
                "result": {"type": "object"},
            },
            "required": ["task_id", "claim_id", "result"],
            "additionalProperties": False,
        },
    },
    {
        "name": "viper_fail_task",
        "description": "Report that the task could not be done, with a stable code.",
        "inputSchema": {
            "type": "object",
            "properties": {
                **_CLAIMED_SCHEMA["properties"],
                "code": {"type": "string", "maxLength": 64},
                "message": {"type": "string"},
            },
            "required": ["task_id", "claim_id", "code"],
            "additionalProperties": False,
        },
    },
    {
        "name": "viper_release_task",
        "description": "Give a claimed task back without failing it (another agent may take it).",
        "inputSchema": _CLAIMED_SCHEMA,
    },
    {
        "name": "viper_leave_work",
        "description": (
            "Hand back all the tasks you hold and end your mission work session(s), in one call, "
            "when you are done or stopping (no claim_id needed). Pass `task_id` to leave only the "
            "mission run of that task. Released tasks go back to the queue unfailed; safe to "
            "repeat (answers zeros). Optional courtesy: unreleased leases expire after 15 minutes "
            "and an idle session closes by itself after 3 hours."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"task_id": {"type": "string", "format": "uuid"}},
            "additionalProperties": False,
        },
    },
    {
        "name": "viper_task_queue",
        "description": "How many tasks of each allowed type are waiting. Cheap polling.",
        "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "viper_list_companies",
        "description": (
            "Read a page of companies, ordered by name. `search` matches the names, the website, "
            "the e-mail domain, or the digits of a SIREN/SIRET. Returns the page and its `total`."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "search": {"type": "string", "maxLength": 200},
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": mcp_reads.LIST_MAX,
                },
                "offset": {"type": "integer", "minimum": 0},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "viper_get_company",
        "description": (
            "Read one company: identity, segment, activity categories, establishments, and the "
            "people already in the base."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"company_id": {"type": "string", "format": "uuid"}},
            "required": ["company_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "viper_list_prospects",
        "description": (
            "Read a page of people, filtered by employer (`company_ids`) and/or by name "
            "(`search`). Returns the page and its `total`."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "company_ids": {
                    "type": "array",
                    "items": {"type": "string", "format": "uuid"},
                    "maxItems": mcp_reads.MAX_COMPANY_IDS,
                },
                "search": {"type": "string", "maxLength": 200},
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": mcp_reads.LIST_MAX,
                },
                "offset": {"type": "integer", "minimum": 0},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "viper_get_prospect",
        "description": (
            "Read one person's full record: identity, company, role, e-mail addresses and "
            "phones, verification state, contactability, contact level and score."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {"prospect_id": {"type": "string", "format": "uuid"}},
            "required": ["prospect_id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "viper_add_company",
        "description": (
            "Stage a discovered company for the claimed find_prospects task. No company is "
            "written. Give each action a stable UUID; retrying the same action is safe. "
            "company_data follows the companies item in the task's output_schema, including "
            "confidence and public evidence. List each warehouse under establishments with kind "
            "« entrepôt »: once accepted it becomes a warehouse record of the company. A "
            "company already in VIPER may be staged for its new warehouses. Finish with "
            "viper_submit_task_result and result {}."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                **_CLAIMED_SCHEMA["properties"],
                "action_id": {"type": "string", "format": "uuid"},
                "company_data": {"type": "object"},
            },
            "required": ["task_id", "claim_id", "action_id", "company_data"],
            "additionalProperties": False,
        },
    },
    {
        "name": "viper_update_company",
        "description": (
            "Propose updated information for a company. The JSON is the same shape as an "
            "`update_company` mission result. VIPER stores it as a proposal awaiting a person's "
            "review — it never writes to the base by itself. For a claimed task provide task_id, "
            "claim_id and action_id to stage it in that task's single result."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "company_id": {"type": "string", "format": "uuid"},
                "result": {"type": "object"},
                **_CLAIMED_SCHEMA["properties"],
                "action_id": {"type": "string", "format": "uuid"},
            },
            "required": ["company_id", "result"],
            "additionalProperties": False,
        },
    },
    {
        "name": "viper_update_prospect",
        "description": (
            "Propose updated information for one person (identity, role, job title, e-mail "
            "addresses, phones, activity). The JSON is the same shape as an `update_employee` "
            "mission result, and is stored for review — never applied directly."
            " For a claimed task provide task_id, claim_id and action_id to stage it in that "
            "task's single result."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prospect_id": {"type": "string", "format": "uuid"},
                "result": {"type": "object"},
                **_CLAIMED_SCHEMA["properties"],
                "action_id": {"type": "string", "format": "uuid"},
            },
            "required": ["prospect_id", "result"],
            "additionalProperties": False,
        },
    },
]
# The identity and record reads change nothing: the same advisory hints as the conversational reads.
_READ_ONLY_TOOLS = {
    "viper_whoami",
    "viper_list_companies",
    "viper_get_company",
    "viper_list_prospects",
    "viper_get_prospect",
}
for _tool in TOOLS:
    if _tool["name"] in _READ_ONLY_TOOLS:
        _tool["annotations"] = mcp_conversational.READ_ONLY_ANNOTATIONS
TOOLS.extend(tool.definition() for tool in mcp_conversational.TOOLS)
TOOLS.extend(tool.definition() for tool in mcp_queries.TOOLS)
TOOLS.extend(tool.definition() for tool in mcp_missions.TOOLS)
TOOLS.extend(tool.definition() for tool in mcp_contact.TOOLS)
TOOLS.extend(mcp_telemetry.TOOLS)
# The card the host renders with a tool's result, and the tools that card calls (`mcp_ui`).
for _tool in TOOLS:
    _meta = mcp_ui.tool_meta(_tool["name"])
    if _meta is not None:
        _tool["_meta"] = _meta


def _rpc(id_: Any, result: Any) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id_, "result": result}


def _error(id_: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}}


def _unauthorized(request: Request, message: str) -> JSONResponse:
    # RFC 9728: where a connector finds how to get a token (OAuth discovery starts here).
    metadata = resource_metadata_url(request)
    return JSONResponse(
        _error(None, -32001, message),
        status_code=401,
        headers={"WWW-Authenticate": f'Bearer resource_metadata="{metadata}"'},
    )


def _payload(result: Any, is_error: bool = False) -> dict[str, Any]:
    return {
        "content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
        "structuredContent": result,
        "isError": is_error,
    }


def _refusal(error: DomainError) -> dict[str, Any]:
    body: dict[str, Any]
    if isinstance(error, InvalidFieldError):
        body = {"code": error.reason or "invalid", "message": str(error), "field": error.field}
    elif isinstance(error, (ContactMessageError, BusinessRuleError, MailGenerationError)):
        # Their stable code (`agent_draft_only`, `revision_conflict`, `task_cancelled`,
        # `ai_timeout`…) and their details (`status`, `fields`); never the AI provider's data.
        details = (
            error.details if isinstance(error, (ContactMessageError, BusinessRuleError)) else {}
        )
        body = {"code": error.code, "message": str(error), **details}
    elif isinstance(error, ConflictError):
        body = {"code": "conflict", "message": str(error)}
    elif isinstance(error, NotFoundError):
        body = {"code": "not_found", "message": str(error)}
    elif isinstance(error, ActorNotAllowedError):
        body = {"code": "not_allowed", "message": str(error)}
    elif isinstance(error, CapabilityDeniedError):
        body = {
            "code": "capability_denied",
            "message": f"{error} Call viper_whoami to see what this agent may do.",
            "capability": error.capability,
        }
    else:
        body = {"code": "refused", "message": str(error)}
    return _payload(body, is_error=True)


def _lease(args: dict[str, Any]) -> timedelta:
    seconds = args.get("lease_seconds")
    if not isinstance(seconds, int):
        return agent_missions.DEFAULT_LEASE
    return timedelta(seconds=max(MIN_LEASE_SECONDS, min(MAX_LEASE_SECONDS, seconds)))


def _parse_uuid(value: Any, name: str) -> uuid.UUID:
    try:
        return uuid.UUID(str(value))
    except (TypeError, ValueError) as error:
        raise InvalidFieldError(name, "Expected a UUID.", "format") from error


def _uuid(args: dict[str, Any], name: str) -> uuid.UUID:
    return _parse_uuid(args.get(name), name)


def _uuid_list(args: dict[str, Any], name: str, max_items: int) -> list[uuid.UUID] | None:
    value = args.get(name)
    if value is None:
        return None
    if not isinstance(value, list):
        raise InvalidFieldError(name, "Expected a list of UUIDs.", "format")
    if len(value) > max_items:
        raise InvalidFieldError(name, f"At most {max_items} ids.", "too_many")
    seen: dict[uuid.UUID, None] = {}
    for item in value:
        seen[_parse_uuid(item, name)] = None
    return list(seen)


def _page(args: dict[str, Any]) -> tuple[int, int]:
    limit = args.get("limit")
    offset = args.get("offset")
    limit = limit if isinstance(limit, int) and not isinstance(limit, bool) else 50
    offset = offset if isinstance(offset, int) and not isinstance(offset, bool) else 0
    return max(1, min(limit, mcp_reads.LIST_MAX)), max(0, offset)


def _search(args: dict[str, Any]) -> str | None:
    value = args.get("search")
    if value is None:
        return None
    if not isinstance(value, str):
        raise InvalidFieldError("search", "Expected a string.", "format")
    if len(value) > 200:
        raise InvalidFieldError("search", "At most 200 characters.", "too_long")
    return value.strip() or None


def _result(args: dict[str, Any]) -> dict[str, Any]:
    value = args.get("result")
    if not isinstance(value, dict):
        raise InvalidFieldError("result", "Expected an object.", "format")
    return value


def _require_scope(record: McpToken, task_type: AgentTaskType) -> None:
    if mcp_tokens.ANY_SCOPE in record.scopes or task_type.value in record.scopes:
        return
    raise InvalidFieldError(
        "scope",
        f"This token may not propose a {task_type.value} result.",
        "not_allowed",
    )


def _stored(stored: Any) -> dict[str, Any]:
    """The short answer of a stored proposal: what was kept, what was refused, and its id."""
    proposal = stored.proposal
    return {
        "result_id": str(stored.id),
        "status": stored.status.value,
        "summary": {
            "items": len(proposal.get("items", [])),
            "refused": len(proposal.get("refused", [])),
            "stale": bool(proposal.get("stale")),
        },
    }


def _check_capacity(session: Session, actor: ActorContext, record: McpToken) -> None:
    """Refuse a claim beyond the agent's concurrent-claims limit."""
    # Expired leases must not count against the agent's concurrent-claims limit.
    agent_missions.sweep_expired(session)
    live = session.scalar(
        select(func.count(AgentTask.id)).where(
            AgentTask.claimed_by_id == actor.id,
            AgentTask.status == AgentTaskStatus.CLAIMED,
        )
    )
    if live is not None and live >= record.max_concurrent:
        raise ConflictError(
            f"This agent already holds {live} claimed tasks (task concurrency limit: "
            f"{record.max_concurrent} at once): submit, release or leave_work first."
        )


def _open_deposit(
    session: Session, actor: ActorContext, record: McpToken, args: dict[str, Any]
) -> dict[str, Any]:
    """`viper_open_deposit`: spontaneous work (« ajoute ce contact »), dropped in the permanent
    « Dépôt » mission. The task is opened and claimed in one call; the agent then submits, fails or
    releases it exactly like a mission task, and a person reviews the result."""
    try:
        task_type = AgentTaskType(str(args.get("task_type")))
    except ValueError as error:
        raise InvalidFieldError("task_type", "Unknown task type.", "enum") from error
    _require_scope(record, task_type)
    _check_capacity(session, actor, record)
    lease = _lease(args)
    task = missions.open_deposit(
        session,
        actor,
        task_type,
        company_id=_uuid(args, "company_id") if args.get("company_id") else None,
        prospect_id=_uuid(args, "prospect_id") if args.get("prospect_id") else None,
    )
    moment = datetime.now(UTC)
    agent_missions.claim_specific(session, actor, task.id, lease=lease, now=moment)
    claimed = agent_missions.claimed_task(session, actor, task, lease, moment)
    return {**claimed.payload, "claim_id": str(claimed.claim_id)}


def _claim(
    session: Session, actor: ActorContext, record: McpToken, args: dict[str, Any]
) -> dict[str, Any]:
    allowed = mcp_tokens.task_types(record)
    requested = args.get("task_types")
    if isinstance(requested, list):
        wanted = {str(value) for value in requested}
        allowed = [task for task in allowed if task.value in wanted]
    if not allowed:
        raise InvalidFieldError("task_types", "No allowed task type.", "empty")
    _check_capacity(session, actor, record)
    thread_id = args.get("thread_id")
    claimed = agent_missions.claim(
        session,
        actor,
        types=allowed,
        thread_id=_uuid(args, "thread_id") if thread_id else None,
        mission_id=_uuid(args, "mission_id") if args.get("mission_id") else None,
        lease=_lease(args),
    )
    if claimed is None:
        return {
            "task": None,
            "hint": (
                "No task is waiting. A task is created when a mission runs: at its next_run_at, "
                "or when a person clicks « Lancer maintenant » in VIPER > Missions. A paused "
                "mission creates none; a failed last run gives its reason."
            ),
            "missions": missions.idle_summary(session),
        }
    return {**claimed.payload, "claim_id": str(claimed.claim_id)}


def _submit(session: Session, actor: ActorContext, args: dict[str, Any]) -> dict[str, Any]:
    result = args.get("result")
    if not isinstance(result, dict):
        raise InvalidFieldError("result", "Expected an object.", "format")
    stored = agent_missions.submit(
        session,
        actor,
        _uuid(args, "task_id"),
        _uuid(args, "claim_id"),
        result,
    )
    return _stored(stored)


def _whoami() -> dict[str, Any]:
    """`viper_whoami`: the identity and effective capabilities VIPER sees for this call — never
    what the model says it is."""
    grant = _current_grant.get()
    if grant is None:
        raise CapabilityDeniedError("viper_whoami")
    record, delegate, organization = grant.token, grant.delegate, grant.organization
    return {
        "agent_id": str(record.id),
        "label": record.label,
        "identity": agent_identity.identity_label(record),
        "instance_number": record.instance_number,
        # Tasks this agent may hold at once: unrelated to the cap on a person's agent identities.
        "max_concurrent_tasks": record.max_concurrent,
        "provider": record.provider.value,
        "mode": record.mode.value,
        "delegated_user": (
            {
                "email": delegate.email,
                "display_name": delegate.display_name,
                "role": delegate.role.value,
                "platform_admin": delegate.is_superadmin,
                "active": delegate.is_active,
            }
            if delegate is not None
            else None
        ),
        "organization": (
            {"id": str(organization.id), "name": organization.name}
            if organization is not None
            else None
        ),
        "capabilities": grant.ordered(),
        # Why an agent may do nothing at all: the person it acted for is gone or deactivated.
        "restriction": (
            "delegated_user_missing"
            if grant.orphaned
            else "delegated_user_inactive"
            if delegate is not None and not delegate.is_active
            else None
        ),
        "task_types": [task.value for task in mcp_tokens.task_types(record)],
        "version": SERVER_INFO["version"],
    }


def _call_tool(
    name: str,
    args: dict[str, Any],
    session: Session,
    actor: ActorContext,
    record: McpToken,
    state: Any,
) -> dict[str, Any]:
    # Each tool starts with its `require`: a refused call touches nothing.
    read_tool = mcp_conversational.BY_NAME.get(name)
    if read_tool is not None:
        require(record, read_tool.capability)
        context = mcp_conversational.ReadContext(session=session, state=state)
        return _payload(read_tool.handler(context, args))
    query_tool = mcp_queries.BY_NAME.get(name)
    if query_tool is not None:
        require(record, query_tool.capability)
        query_context = mcp_conversational.ReadContext(session=session, state=state)
        return _payload(query_tool.handler(query_context, args))
    mission_tool = mcp_missions.BY_NAME.get(name)
    if mission_tool is not None:
        for capability in mission_tool.required(args):
            require(record, capability)
        mission_context = mcp_missions.MissionContext(session=session, actor=actor)
        return _payload(mission_tool.handler(mission_context, args))
    draft_tool = mcp_contact.BY_NAME.get(name)
    if draft_tool is not None:
        require(record, draft_tool.capability)
        draft_context = mcp_contact.DraftContext(session=session, actor=actor, state=state)
        return _payload(draft_tool.handler(draft_context, args))
    match name:
        case "viper_whoami":
            # No capability: an agent must always be able to learn what it may do.
            return _payload(_whoami())
        case "viper_claim_task":
            require(record, "tasks.work")
            return _payload(_claim(session, actor, record, args))
        case "viper_open_deposit":
            require(record, "tasks.work")
            return _payload(_open_deposit(session, actor, record, args))
        case "viper_task_queue":
            require(record, "tasks.work")
            counts = agent_missions.queue_counts(session, mcp_tokens.task_types(record))
            return _payload({"tasks": counts})
        case "viper_heartbeat_task":
            require(record, "tasks.work")
            expires = agent_missions.heartbeat(
                session,
                actor,
                _uuid(args, "task_id"),
                _uuid(args, "claim_id"),
                lease=_lease(args),
            )
            return _payload({"lease_expires_at": expires.isoformat()})
        case "viper_log_mission_activity":
            require(record, mcp_telemetry.CAPABILITY)
            return _payload(mcp_telemetry.log_mission_activity(session, actor, args))
        case "viper_end_mission_session":
            require(record, mcp_telemetry.CAPABILITY)
            return _payload(mcp_telemetry.end_mission_session(session, actor, args))
        case "viper_get_mission_session":
            require(record, mcp_telemetry.CAPABILITY)
            return _payload(mcp_telemetry.get_mission_session(session, actor, args))
        case "viper_submit_task_result":
            require(record, "tasks.work")
            return _payload(_submit(session, actor, args))
        case "viper_fail_task":
            require(record, "tasks.work")
            task = agent_missions.fail(
                session,
                actor,
                _uuid(args, "task_id"),
                _uuid(args, "claim_id"),
                str(args.get("code") or "unknown"),
                str(args.get("message") or ""),
            )
            return _payload({"status": task.status.value})
        case "viper_leave_work":
            require(record, "tasks.work")
            raw = args.get("task_id")
            return _payload(
                agent_lifecycle.leave_work(session, actor, _uuid(args, "task_id") if raw else None)
            )
        case "viper_release_task":
            require(record, "tasks.work")
            task = agent_missions.release(
                session, actor, _uuid(args, "task_id"), _uuid(args, "claim_id")
            )
            return _payload({"status": task.status.value})
        case "viper_list_companies":
            require(record, "records.read")
            limit, offset = _page(args)
            return _payload(
                mcp_reads.list_companies(session, search=_search(args), limit=limit, offset=offset)
            )
        case "viper_get_company":
            require(record, "records.read")
            return _payload(mcp_reads.get_company(session, _uuid(args, "company_id")))
        case "viper_list_prospects":
            require(record, "records.read")
            limit, offset = _page(args)
            return _payload(
                mcp_reads.list_prospects(
                    session,
                    company_ids=_uuid_list(args, "company_ids", mcp_reads.MAX_COMPANY_IDS),
                    search=_search(args),
                    limit=limit,
                    offset=offset,
                )
            )
        case "viper_get_prospect":
            require(record, "records.read")
            return _payload(
                mcp_reads.get_prospect(session, _uuid(args, "prospect_id"), state.settings)
            )
        case "viper_add_company":
            require(record, "tasks.work")
            _require_scope(record, AgentTaskType.FIND_PROSPECTS)
            data = args.get("company_data")
            if not isinstance(data, dict):
                raise InvalidFieldError("company_data", "Expected an object.", "format")
            return _payload(
                agent_actions.stage(
                    session,
                    actor,
                    _uuid(args, "task_id"),
                    _uuid(args, "claim_id"),
                    _uuid(args, "action_id"),
                    "add_company",
                    data,
                    None,
                )
            )
        case "viper_update_company":
            require(record, "records.propose")
            _require_scope(record, AgentTaskType.UPDATE_COMPANY)
            if any(key in args for key in ("task_id", "claim_id", "action_id")):
                require(record, "tasks.work")
                return _payload(
                    agent_actions.stage(
                        session,
                        actor,
                        _uuid(args, "task_id"),
                        _uuid(args, "claim_id"),
                        _uuid(args, "action_id"),
                        "update_company",
                        _result(args),
                        _uuid(args, "company_id"),
                    )
                )
            stored = agent_writes.propose_company_update(
                session, actor, _uuid(args, "company_id"), _result(args)
            )
            return _payload(_stored(stored))
        case "viper_update_prospect":
            require(record, "records.propose")
            _require_scope(record, AgentTaskType.UPDATE_EMPLOYEE)
            if any(key in args for key in ("task_id", "claim_id", "action_id")):
                require(record, "tasks.work")
                return _payload(
                    agent_actions.stage(
                        session,
                        actor,
                        _uuid(args, "task_id"),
                        _uuid(args, "claim_id"),
                        _uuid(args, "action_id"),
                        "update_prospect",
                        _result(args),
                        _uuid(args, "prospect_id"),
                    )
                )
            stored = agent_writes.propose_prospect_update(
                session, actor, _uuid(args, "prospect_id"), _result(args)
            )
            return _payload(_stored(stored))
        case _:
            raise InvalidFieldError("name", f"Unknown tool {name!r}.", "unknown_tool")


def _handle(
    message: dict[str, Any],
    session: Session,
    actor: ActorContext,
    record: McpToken,
    state: Any,
) -> dict[str, Any] | None:
    method = message.get("method")
    id_ = message.get("id")
    if method is None or not isinstance(method, str):
        return _error(id_, -32600, "Invalid request.")
    if method.startswith("notifications/"):
        return None
    match method:
        case "initialize":
            return _rpc(
                id_,
                {
                    "protocolVersion": PROTOCOL_VERSION,
                    "capabilities": {
                        "tools": {"listChanged": False},
                        "resources": {"listChanged": False, "subscribe": False},
                    },
                    "serverInfo": SERVER_INFO,
                },
            )
        case "ping":
            return _rpc(id_, {})
        case "tools/list":
            return _rpc(id_, {"tools": TOOLS})
        case "resources/list":
            # Static templates, no data: any valid token may read them (no capability).
            return _rpc(id_, {"resources": mcp_ui.list_resources()})
        case "resources/templates/list":
            return _rpc(id_, {"resourceTemplates": []})
        case "resources/read":
            params = message.get("params") or {}
            uri = params.get("uri") if isinstance(params, dict) else None
            try:
                return _rpc(id_, mcp_ui.read_resource(uri))
            except NotFoundError as error:
                # MCP's « resource not found » code.
                return _error(id_, -32002, str(error))
        case "tools/call":
            params = message.get("params") or {}
            name = params.get("name")
            args = params.get("arguments") or {}
            if not isinstance(args, dict):
                return _rpc(id_, _payload({"code": "invalid", "message": "arguments"}, True))
            # One savepoint per call: a refused tool writes nothing, even when it had already
            # touched the task before failing (the claim's payload, for instance).
            started = time.monotonic()
            crashed = False
            try:
                with session.begin_nested():
                    payload = _call_tool(str(name), args, session, actor, record, state)
            except DomainError as error:
                payload = _refusal(error)
            except Exception:
                # A crash, not a refusal: the savepoint undid the tool's writes, the trace goes to
                # the server log and the call stays in the history as « error ».
                logger.exception("MCP tool %r crashed (agent %s)", name, record.id)
                payload = _payload(
                    {"code": "internal", "message": "VIPER a rencontré une erreur interne."},
                    is_error=True,
                )
                crashed = True
            result_meta = mcp_ui.result_meta(str(name))
            if result_meta is not None:
                payload["_meta"] = result_meta
            outcome = "error" if crashed else None
            _log_call(session, record, str(name), args, payload, started, outcome=outcome)
            return _rpc(id_, payload)
        case _:
            return _error(id_, -32601, f"Unknown method {method!r}.")


def _log_call(
    session: Session,
    record: McpToken,
    tool: str,
    args: dict[str, Any],
    payload: dict[str, Any],
    started: float,
    outcome: str | None = None,
) -> None:
    """« Historique des appels »: who asked what. Written outside the tool's savepoint, so a
    refusal or a crash is kept too."""
    code: str | None = None
    message: str | None = None
    if payload.get("isError"):
        body = payload.get("structuredContent") or {}
        outcome = outcome or "refused"
        code = str(body.get("code") or "refused") if isinstance(body, dict) else "refused"
        message = str(body.get("message") or "") if isinstance(body, dict) else None
    else:
        outcome = "ok"
    mcp_calls.record(
        session,
        record,
        tool=tool,
        arguments=args,
        outcome=outcome,
        duration_ms=round((time.monotonic() - started) * 1000),
        error_code=code,
        error_message=message or None,
    )


def _audit_context(grant: AgentGrant) -> audit.AuditContext:
    delegate = grant.delegate
    return audit.AuditContext(
        source=audit.AuditSource.AGENT,
        request_id=str(uuid.uuid7()),
        on_behalf_of=(
            ActorContext(type=ActorType.HUMAN, id=str(delegate.id), display=delegate.display_name)
            if delegate is not None
            else None
        ),
    )


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return None
    return value.strip()


def _dispatch(
    body: Any, session: Session, actor: ActorContext, record: McpToken, state: Any
) -> Any:
    if isinstance(body, list):
        if not body:
            return _error(None, -32600, "Empty batch.")
        answers = [
            answer
            for message in body
            if isinstance(message, dict)
            for answer in [_handle(message, session, actor, record, state)]
            if answer is not None
        ]
        return answers or None
    if not isinstance(body, dict):
        return _error(None, -32600, "Invalid request.")
    return _handle(body, session, actor, record, state)


@router.post("")
def handle_mcp(request: Request, body: Annotated[Any, Body()]) -> Any:
    token = _bearer(request)
    if token is None:
        return _unauthorized(request, "A bearer token is required.")
    factory = request.app.state.session_factory
    with unit_of_work(factory) as session:
        record = mcp_tokens.resolve(session, token) or oauth.resolve_access_token(session, token)
        if record is None:
            return _unauthorized(request, "Unknown, expired or revoked token.")
        actor = mcp_tokens.actor_for(record)
        grant = agent_capabilities.grant_for(session, record)
        # The agent stays the actor; the person it acts for rides along (« ChatGPT pour Lucie »).
        audit.bind(session, actor, _audit_context(grant))
        with granted(grant):
            answer = _dispatch(body, session, actor, record, request.app.state)
    if answer is None:
        return Response(status_code=202)
    return JSONResponse(answer)


@router.get("")
def mcp_events(request: Request) -> JSONResponse:
    """No server-initiated stream: VIPER answers a call, it does not push."""
    return JSONResponse(
        _error(None, -32000, "This server does not open an event stream."),
        status_code=405,
        headers={"Allow": "POST"},
    )


@router.delete("")
def mcp_session(request: Request) -> JSONResponse:
    """Stateless server: there is no session to end."""
    return JSONResponse(
        _error(None, -32000, "This server keeps no session."),
        status_code=405,
        headers={"Allow": "POST"},
    )
