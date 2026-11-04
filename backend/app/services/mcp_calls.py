"""« Historique des appels » (Paramètres > MCP): every `tools/call` on `/mcp`, kept under the
e-mail of the person the agent acts for (`mcp_tokens.owner_email`).

The arguments are what the agent asked for; long texts (a submitted result, a note) are shortened
so the history stays a log, not a second copy of the data. Rows are write-once.
"""

import uuid
from collections.abc import Collection
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.mcp import McpCall, McpToken

TEXT_LIMIT = 300
LIST_LIMIT = 50
DEPTH_LIMIT = 4
DEFAULT_PAGE = 50
MAX_PAGE = 200


def shorten(value: Any, depth: int = 0) -> Any:
    """The arguments as stored: texts cut at `TEXT_LIMIT`, lists at `LIST_LIMIT`, nesting at
    `DEPTH_LIMIT` (beyond it, « … »)."""
    if depth >= DEPTH_LIMIT:
        return "…"
    if isinstance(value, str):
        return value if len(value) <= TEXT_LIMIT else value[:TEXT_LIMIT] + "…"
    if isinstance(value, dict):
        return {str(key)[:100]: shorten(item, depth + 1) for key, item in value.items()}
    if isinstance(value, list):
        items = [shorten(item, depth + 1) for item in value[:LIST_LIMIT]]
        if len(value) > LIST_LIMIT:
            items.append(f"… {len(value) - LIST_LIMIT} de plus")
        return items
    if value is None or isinstance(value, bool | int | float):
        return value
    return str(value)[:TEXT_LIMIT]


def record(
    session: Session,
    token: McpToken,
    *,
    tool: str,
    arguments: dict[str, Any],
    outcome: str,
    duration_ms: int,
    error_code: str | None = None,
    error_message: str | None = None,
) -> McpCall:
    call = McpCall(
        token_id=token.id,
        token_label=token.label,
        user_email=token.owner_email,
        tool=tool[:100],
        arguments=shorten(arguments),
        outcome=outcome,
        error_code=error_code[:64] if error_code else None,
        error_message=error_message[:500] if error_message else None,
        duration_ms=max(0, duration_ms),
    )
    session.add(call)
    session.flush()
    return call


@dataclass(frozen=True, slots=True)
class CallPage:
    calls: list[McpCall]
    # The people and tools present in the whole history, for the filters.
    emails: list[str]
    tools: list[str]
    has_more: bool


def history(
    session: Session,
    *,
    email: str | None = None,
    tool: str | None = None,
    token_id: uuid.UUID | None = None,
    before: datetime | None = None,
    limit: int = DEFAULT_PAGE,
    visible: Collection[uuid.UUID] | None = None,
) -> CallPage:
    """Newest first; `before` continues a page (the `created_at` of its last row).

    `visible`: only the calls of these agents, the filters included (`mcp_access`); `None`: all.
    """
    size = max(1, min(limit, MAX_PAGE))
    scope = [] if visible is None else [McpCall.token_id.in_(list(visible))]
    statement = select(McpCall).where(*scope).order_by(McpCall.created_at.desc(), McpCall.id.desc())
    if email:
        statement = statement.where(McpCall.user_email == email.strip().lower())
    if tool:
        statement = statement.where(McpCall.tool == tool)
    if token_id:
        statement = statement.where(McpCall.token_id == token_id)
    if before:
        statement = statement.where(McpCall.created_at < before)
    rows = list(session.scalars(statement.limit(size + 1)))
    emails = session.scalars(
        select(McpCall.user_email)
        .where(McpCall.user_email.is_not(None), *scope)
        .distinct()
        .order_by(McpCall.user_email)
    )
    tools = session.scalars(select(McpCall.tool).where(*scope).distinct().order_by(McpCall.tool))
    return CallPage(
        calls=rows[:size],
        emails=[value for value in emails if value],
        tools=list(tools),
        has_more=len(rows) > size,
    )
