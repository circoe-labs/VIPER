"""Agent identity: a numbered, human-legible label per owner and provider.

An agent is an `McpToken` (no separate principal). Its identity label reads « ChatGPT lucie #2 »:
provider, owner (the local part of `owner_email`) and an instance number `#N`.

- **Allocation** (`allocate`): the smallest positive number not held by a *live* token of the same
  (owner, provider). Deterministic; a revoked token frees its number, a live one keeps it for as
  long as it exists — so a scheduled agent, which stays live while idle, keeps a stable identity,
  and three concurrent ChatGPT conversations of one person get #1, #2, #3.
- **Concurrency**: one transaction-scoped advisory lock per owner serialises allocation; the
  partial unique index `uq_mcp_tokens_live_instance` is the backstop.
- **Cap** (`ensure_below_cap`): at most `Settings.mcp_max_agents_per_owner` (default 100) live
  tokens per owner. It is about identities, not about `McpToken.max_concurrent` (tasks a token
  may hold at once).

Contract: `doc/architecture/mcp-server.md` §4.9.
"""

import hashlib

from sqlalchemy import ColumnElement, func, select, text
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.models.enums import AgentProvider
from app.models.mcp import McpToken
from app.services.errors import BusinessRuleError

AGENT_CAP_REACHED = "agent_cap_reached"

PROVIDER_NAMES: dict[AgentProvider, str] = {
    AgentProvider.CHATGPT: "ChatGPT",
    AgentProvider.CLAUDE: "Claude",
    AgentProvider.CHATX: "ChatX",
    AgentProvider.OTHER: "Agent",
}


def _owner_key(owner_email: str | None) -> str:
    return (owner_email or "").strip().lower()


def _lock(session: Session, owner_email: str | None) -> None:
    """Serialise the allocations of one owner for the rest of the transaction."""
    digest = hashlib.sha256(_owner_key(owner_email).encode()).digest()
    session.execute(
        text("SELECT pg_advisory_xact_lock(:key)"),
        {"key": int.from_bytes(digest[:8], "big", signed=True)},
    )


def _live(owner_email: str | None) -> tuple[ColumnElement[bool], ...]:
    return (
        McpToken.revoked_at.is_(None),
        func.coalesce(McpToken.owner_email, "") == _owner_key(owner_email),
    )


def live_count(session: Session, owner_email: str | None) -> int:
    return session.scalar(select(func.count(McpToken.id)).where(*_live(owner_email))) or 0


def ensure_below_cap(session: Session, owner_email: str | None, cap: int | None = None) -> None:
    """Refuse (409 `agent_cap_reached`) a new identity once the owner holds `cap` live ones."""
    limit = cap if cap is not None else get_settings().mcp_max_agents_per_owner
    held = live_count(session, owner_email)
    if held >= limit:
        raise BusinessRuleError(
            AGENT_CAP_REACHED,
            409,
            f"This person already holds {held} agent identities (safety cap {limit}): "
            "revoke an unused one in Paramètres > MCP first. "
            "This is unrelated to the number of tasks an agent may hold at once.",
            limit=limit,
            held=held,
        )


def allocate(
    session: Session, owner_email: str | None, provider: AgentProvider, cap: int | None = None
) -> int:
    """The instance number for a new live token of (`owner_email`, `provider`), after the cap
    check. Call it in the transaction that inserts the token."""
    _lock(session, owner_email)
    ensure_below_cap(session, owner_email, cap)
    taken = set(
        session.scalars(
            select(McpToken.instance_number).where(
                *_live(owner_email),
                McpToken.provider == provider,
                McpToken.instance_number.is_not(None),
            )
        )
    )
    number = 1
    while number in taken:
        number += 1
    return number


def identity_label(record: McpToken) -> str:
    """« ChatGPT lucie #2 ». A token without a number (legacy/revoked) reads as its own label."""
    if record.instance_number is None:
        return record.label
    parts = [PROVIDER_NAMES[record.provider]]
    if record.owner_email:
        parts.append(record.owner_email.split("@", 1)[0])
    parts.append(f"#{record.instance_number}")
    return " ".join(parts)
