"""Machine credentials: mint a token, resolve it, and say what it may do.

A token is shown once, at mint time; only its SHA-256 is stored. `resolve` is the whole
authentication: an unknown, revoked or expired hash is nobody.
"""

import hashlib
import secrets
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models.enums import AgentMode, AgentProvider, AgentTaskType
from app.models.mcp import LABEL_MAX_LENGTH, McpToken
from app.models.users import User
from app.services import agent_capabilities
from app.services.errors import ForbiddenError, InvalidFieldError

TOKEN_PREFIX = "viper_"
TOKEN_BYTES = 32
ANY_SCOPE = "*"
# Every task type an agent may be scoped to (the wildcard covers them all).
ALL_SCOPES = tuple(task.value for task in AgentTaskType)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _scopes(values: list[str]) -> list[str]:
    if ANY_SCOPE in values:
        return [ANY_SCOPE]
    unknown = sorted(set(values) - set(ALL_SCOPES))
    if unknown:
        raise ValueError(f"Unknown task type: {', '.join(unknown)}")
    return sorted(set(values))


def mint(
    session: Session,
    *,
    label: str,
    scopes: list[str],
    max_concurrent: int = 3,
    owner_email: str | None = None,
    provider: AgentProvider = AgentProvider.OTHER,
    mode: AgentMode = AgentMode.WORKER,
    capabilities: list[str] | None = None,
) -> tuple[str, McpToken]:
    """Create a token and return `(token, record)`; the token itself is never stored.

    `capabilities` defaults to those of `mode` (`agent_capabilities.DEFAULT_CAPABILITIES`).
    """
    token = TOKEN_PREFIX + secrets.token_urlsafe(TOKEN_BYTES)
    record = McpToken(
        label=label,
        token_hash=hash_token(token),
        scopes=_scopes(scopes),
        max_concurrent=max_concurrent,
        owner_email=owner_email.strip().lower() if owner_email else None,
        provider=provider,
        mode=mode,
        capabilities=(
            agent_capabilities.defaults(mode)
            if capabilities is None
            else agent_capabilities.normalize(capabilities)
        ),
    )
    session.add(record)
    session.flush()
    return token, record


def create_for(
    session: Session,
    creator: User,
    *,
    label: str,
    provider: AgentProvider,
    mode: AgentMode,
    capabilities: list[str] | None,
) -> tuple[str, McpToken]:
    """« Créer un jeton » (Paramètres > MCP): a token acting for `creator`, every task type.

    Nobody hands an agent more than their own role allows: a capability outside
    `agent_capabilities.role_capabilities(creator)` is refused (a member cannot mint a worker
    allowed to cancel missions, since a worker's capabilities are not intersected later).
    """
    name = label.strip()
    if not name or len(name) > LABEL_MAX_LENGTH:
        raise InvalidFieldError("label", f"1 to {LABEL_MAX_LENGTH} characters.", "length")
    try:
        chosen = (
            agent_capabilities.defaults(mode)
            if capabilities is None
            else agent_capabilities.normalize(capabilities)
        )
    except ValueError as error:
        raise InvalidFieldError("capabilities", str(error), "unknown") from error
    allowed = agent_capabilities.role_capabilities(creator)
    beyond = [capability for capability in chosen if capability not in allowed]
    if beyond:
        raise ForbiddenError(f"Your role may not grant: {', '.join(beyond)}.")
    return mint(
        session,
        label=name,
        scopes=[ANY_SCOPE],
        owner_email=creator.email,
        provider=provider,
        mode=mode,
        capabilities=chosen,
    )


def resolve(session: Session, token: str, now: datetime | None = None) -> McpToken | None:
    """The record behind a live token, or None. Its `last_used_at` is refreshed."""
    if not token:
        return None
    record = session.scalar(select(McpToken).where(McpToken.token_hash == hash_token(token)))
    if record is None or record.revoked_at is not None:
        return None
    record.last_used_at = now or datetime.now(UTC)
    return record


def actor_for(record: McpToken) -> ActorContext:
    """The identity every claim, submission and audit event of this agent carries."""
    return ActorContext(type=ActorType.AGENT, id=str(record.id), display=record.label)


def task_types(record: McpToken) -> list[AgentTaskType]:
    if ANY_SCOPE in record.scopes:
        return list(AgentTaskType)
    return [AgentTaskType(value) for value in record.scopes if value in ALL_SCOPES]
