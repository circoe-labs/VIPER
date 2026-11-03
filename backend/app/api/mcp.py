"""VIPER's MCP endpoint: the six tools an agent uses to work, and nothing more.

Streamable HTTP, JSON-RPC 2.0, one `POST /mcp` (`initialize` → `notifications/initialized` →
`tools/list` / `tools/call`). It lives **outside** `/api` on purpose: the session cookie and the
CSRF header do not apply to a machine, so the route carries its own `Authorization: Bearer` check
(`app.services.mcp_tokens`) and its own actor (`ActorType.AGENT`).

No tool writes to the base. `viper_submit_task_result` stores a proposal; a person accepts it
in the interface. Contract: `doc/architecture/mcp-server.md` §3.7 and
`doc/architecture/agent-missions.md`.
"""

import json
import uuid
from datetime import timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse, Response
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api.oauth import resource_metadata_url
from app.core.actor import ActorContext
from app.core.config import Settings
from app.db.session import unit_of_work
from app.models.agent_missions import AgentTask
from app.models.enums import AgentTaskStatus, AgentTaskType
from app.models.mcp import McpToken
from app.services import agent_missions, agent_writes, mcp_reads, mcp_tokens, missions, oauth
from app.services.errors import (
    ActorNotAllowedError,
    ConflictError,
    DomainError,
    InvalidFieldError,
    NotFoundError,
)

router = APIRouter(prefix="/mcp", tags=["mcp"])

PROTOCOL_VERSION = "2025-06-18"
SERVER_INFO = {"name": "VIPER", "version": "1.0.0"}
TASK_TYPE_VALUES = [task.value for task in AgentTaskType]
MIN_LEASE_SECONDS = 60
MAX_LEASE_SECONDS = 3600

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
    if isinstance(error, InvalidFieldError):
        body = {"code": error.reason or "invalid", "message": str(error), "field": error.field}
    elif isinstance(error, ConflictError):
        body = {"code": "conflict", "message": str(error)}
    elif isinstance(error, NotFoundError):
        body = {"code": "not_found", "message": str(error)}
    elif isinstance(error, ActorNotAllowedError):
        body = {"code": "not_allowed", "message": str(error)}
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


def _call_tool(
    name: str,
    args: dict[str, Any],
    session: Session,
    actor: ActorContext,
    record: McpToken,
    settings: Settings,
) -> dict[str, Any]:
    match name:
        case "viper_claim_task":
            return _payload(_claim(session, actor, record, args))
        case "viper_task_queue":
            counts = agent_missions.queue_counts(session, mcp_tokens.task_types(record))
            return _payload({"tasks": counts})
        case "viper_heartbeat_task":
            expires = agent_missions.heartbeat(
                session,
                actor,
                _uuid(args, "task_id"),
                _uuid(args, "claim_id"),
                lease=_lease(args),
            )
            return _payload({"lease_expires_at": expires.isoformat()})
        case "viper_submit_task_result":
            return _payload(_submit(session, actor, args))
        case "viper_fail_task":
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
            task = agent_missions.release(
                session, actor, _uuid(args, "task_id"), _uuid(args, "claim_id")
            )
            return _payload({"status": task.status.value})
        case "viper_list_companies":
            limit, offset = _page(args)
            return _payload(
                mcp_reads.list_companies(session, search=_search(args), limit=limit, offset=offset)
            )
        case "viper_get_company":
            return _payload(mcp_reads.get_company(session, _uuid(args, "company_id")))
        case "viper_list_prospects":
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
            return _payload(mcp_reads.get_prospect(session, _uuid(args, "prospect_id"), settings))
        case "viper_update_company":
            _require_scope(record, AgentTaskType.UPDATE_COMPANY)
            stored = agent_writes.propose_company_update(
                session, actor, _uuid(args, "company_id"), _result(args)
            )
            return _payload(_stored(stored))
        case "viper_update_prospect":
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
    settings: Settings,
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
                    "capabilities": {"tools": {"listChanged": False}},
                    "serverInfo": SERVER_INFO,
                },
            )
        case "ping":
            return _rpc(id_, {})
        case "tools/list":
            return _rpc(id_, {"tools": TOOLS})
        case "tools/call":
            params = message.get("params") or {}
            name = params.get("name")
            args = params.get("arguments") or {}
            if not isinstance(args, dict):
                return _rpc(id_, _payload({"code": "invalid", "message": "arguments"}, True))
            # One savepoint per call: a refused tool writes nothing, even when it had already
            # touched the task before failing (the claim's payload, for instance).
            try:
                with session.begin_nested():
                    payload = _call_tool(str(name), args, session, actor, record, settings)
                return _rpc(id_, payload)
            except DomainError as error:
                return _rpc(id_, _refusal(error))
        case _:
            return _error(id_, -32601, f"Unknown method {method!r}.")


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    scheme, _, value = header.partition(" ")
    if scheme.lower() != "bearer" or not value.strip():
        return None
    return value.strip()


def _dispatch(
    body: Any, session: Session, actor: ActorContext, record: McpToken, settings: Settings
) -> Any:
    if isinstance(body, list):
        if not body:
            return _error(None, -32600, "Empty batch.")
        answers = [
            answer
            for message in body
            if isinstance(message, dict)
            for answer in [_handle(message, session, actor, record, settings)]
            if answer is not None
        ]
        return answers or None
    if not isinstance(body, dict):
        return _error(None, -32600, "Invalid request.")
    return _handle(body, session, actor, record, settings)


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
        answer = _dispatch(body, session, actor, record, request.app.state.settings)
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
