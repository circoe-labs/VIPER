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
from datetime import timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api import mcp_contact, mcp_conversational, mcp_missions, mcp_ui
from app.api.oauth import resource_metadata_url
from app.core.actor import ActorContext, ActorType
from app.db.session import unit_of_work
from app.models.agent_missions import AgentTask
from app.models.enums import AgentTaskStatus, AgentTaskType
from app.models.mcp import McpToken
from app.services import (
    agent_capabilities,
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
            "Who you are for VIPER: this agent's id and label, its provider and mode, the person "
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
            "call, and heartbeat before the lease runs out."
        ),
        "inputSchema": _CLAIM_SCHEMA,
    },
    {
        "name": "viper_heartbeat_task",
        "description": "Renew the lease of a claimed task.",
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
            "and stored as a proposal awaiting a person's review — it never writes to the base."
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
        "name": "viper_update_company",
        "description": (
            "Propose updated information for a company. The JSON is the same shape as an "
            "`update_company` mission result. VIPER stores it as a proposal awaiting a person's "
            "review — it never writes to the base by itself."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "company_id": {"type": "string", "format": "uuid"},
                "result": {"type": "object"},
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
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "prospect_id": {"type": "string", "format": "uuid"},
                "result": {"type": "object"},
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
TOOLS.extend(tool.definition() for tool in mcp_missions.TOOLS)
TOOLS.extend(tool.definition() for tool in mcp_contact.TOOLS)
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
    live = session.scalar(
        select(func.count(AgentTask.id)).where(
            AgentTask.claimed_by_id == actor.id,
            AgentTask.status == AgentTaskStatus.CLAIMED,
        )
    )
    if live is not None and live >= record.max_concurrent:
        raise ConflictError(
            f"This token already holds {live} tasks (max {record.max_concurrent}): "
            "submit or release one first."
        )
    thread_id = args.get("thread_id")
    claimed = agent_missions.claim(
        session,
        actor,
        types=allowed,
        thread_id=_uuid(args, "thread_id") if thread_id else None,
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
        case "viper_update_company":
            require(record, "records.propose")
            _require_scope(record, AgentTaskType.UPDATE_COMPANY)
            stored = agent_writes.propose_company_update(
                session, actor, _uuid(args, "company_id"), _result(args)
            )
            return _payload(_stored(stored))
        case "viper_update_prospect":
            require(record, "records.propose")
            _require_scope(record, AgentTaskType.UPDATE_EMPLOYEE)
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
