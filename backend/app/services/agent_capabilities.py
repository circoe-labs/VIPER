"""What an MCP agent may do: the capability vocabulary, the defaults of each mode, and the
effective set of one call.

A capability is a functional right (`missions.write`), not a task type: `mcp_tokens.scopes` keeps
filtering which tasks a worker may claim. Every MCP tool requires exactly one capability
(`app.api.mcp.require`).

Effective capabilities = the agent's own ∩ the role of its delegated person (decision 3 of the
ChatGPT handoff). The delegated person is:

- for an OAuth connector, the account that approved it (`oauth_authorizations.user_id`);
- for an `interactive` command-line or Paramètres token, the account of its `owner_email`;
- nobody for a `worker` or `scheduled` bearer token: only its own capabilities count.

Fails closed: an OAuth connector whose approving account is gone, and any agent whose delegated
account is deactivated, may do nothing. Contract: `doc/architecture/mcp-server.md` §4.7.
"""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.enums import AgentMode, AgentProvider
from app.models.mcp import McpToken
from app.models.oauth import OAuthAuthorization
from app.models.organizations import Organization, OrganizationRole
from app.models.users import User

TASKS_WORK = "tasks.work"
RECORDS_READ = "records.read"
RECORDS_PROPOSE = "records.propose"
DASHBOARD_READ = "dashboard.read"
MISSIONS_READ = "missions.read"
MISSIONS_WRITE = "missions.write"
MISSIONS_RUN = "missions.run"
MISSIONS_PAUSE = "missions.pause"
MISSIONS_CANCEL = "missions.cancel"
REVIEWS_READ = "reviews.read"
CONTACT_READ = "contact.read"
CONTACT_DRAFT = "contact.draft"

# The whole vocabulary, in display order.
CAPABILITIES: tuple[str, ...] = (
    TASKS_WORK,
    RECORDS_READ,
    RECORDS_PROPOSE,
    DASHBOARD_READ,
    MISSIONS_READ,
    MISSIONS_WRITE,
    MISSIONS_RUN,
    MISSIONS_PAUSE,
    MISSIONS_CANCEL,
    REVIEWS_READ,
    CONTACT_READ,
    CONTACT_DRAFT,
)

# How Paramètres > MCP names each capability (product copy, French).
CAPABILITY_LABELS: dict[str, str] = {
    TASKS_WORK: "Traiter les tâches de mission (prendre, rendre, soumettre)",
    RECORDS_READ: "Lire les entreprises et les personnes",
    RECORDS_PROPOSE: "Proposer des mises à jour de fiches",
    DASHBOARD_READ: "Lire le tableau de bord",
    MISSIONS_READ: "Lire les missions",
    MISSIONS_WRITE: "Créer et modifier des missions",
    MISSIONS_RUN: "Lancer une mission",
    MISSIONS_PAUSE: "Mettre en pause et reprendre une mission",
    MISSIONS_CANCEL: "Annuler et supprimer une mission",
    REVIEWS_READ: "Lire les propositions à valider",
    CONTACT_READ: "Lire l’état du Contact",
    CONTACT_DRAFT: "Rédiger des brouillons de messages",
}

# What a token of each mode receives when nobody chooses otherwise. A worker keeps exactly what
# the six task tools and the record lookups/proposals needed before capabilities existed. An
# interactive assistant keeps `tasks.work` so an OAuth connector already used as a worker
# (claude.ai, Claude Code) goes on claiming tasks.
DEFAULT_CAPABILITIES: dict[AgentMode, tuple[str, ...]] = {
    AgentMode.WORKER: (TASKS_WORK, RECORDS_READ, RECORDS_PROPOSE),
    AgentMode.INTERACTIVE: CAPABILITIES,
    AgentMode.SCHEDULED: (
        TASKS_WORK,
        RECORDS_READ,
        RECORDS_PROPOSE,
        DASHBOARD_READ,
        MISSIONS_READ,
        REVIEWS_READ,
        CONTACT_READ,
    ),
}

# What a person's role lets an agent do on their behalf: a member may not cancel or delete a
# mission (`missions.cancel`); a manager and above may.
ROLE_CAPABILITIES: dict[OrganizationRole, frozenset[str]] = {
    OrganizationRole.ADMIN: frozenset(CAPABILITIES),
    OrganizationRole.MANAGER: frozenset(CAPABILITIES),
    OrganizationRole.MEMBER: frozenset(CAPABILITIES) - {MISSIONS_CANCEL},
}


def normalize(values: Iterable[str]) -> list[str]:
    """A capability list as stored: known names only, deduplicated, in vocabulary order."""
    wanted = {str(value).strip() for value in values}
    unknown = sorted(wanted - set(CAPABILITIES))
    if unknown:
        raise ValueError(f"Unknown capability: {', '.join(unknown)}")
    return [name for name in CAPABILITIES if name in wanted]


def defaults(mode: AgentMode) -> list[str]:
    return list(DEFAULT_CAPABILITIES[mode])


def provider_for_client(client_name: str) -> AgentProvider:
    """The platform an OAuth client says it is (its registered `client_name`), or `other`."""
    name = client_name.casefold()
    if "chatgpt" in name or "openai" in name:
        return AgentProvider.CHATGPT
    if "chatx" in name:
        return AgentProvider.CHATX
    if "claude" in name or "anthropic" in name:
        return AgentProvider.CLAUDE
    return AgentProvider.OTHER


def role_capabilities(user: User) -> frozenset[str]:
    """What an agent may do for `user`: nothing for a deactivated account; the platform admin
    has every capability."""
    if not user.is_active:
        return frozenset()
    if user.is_superadmin:
        return frozenset(CAPABILITIES)
    return ROLE_CAPABILITIES[user.role]


def intersect(agent: Iterable[str], delegate: User | None) -> frozenset[str]:
    """Effective capabilities: the agent's own, bounded by its delegated person's role."""
    own = frozenset(agent) & frozenset(CAPABILITIES)
    return own if delegate is None else own & role_capabilities(delegate)


@dataclass(frozen=True, slots=True)
class AgentGrant:
    """Who calls `/mcp` and what this call may do. Built once per request, server-side."""

    token: McpToken
    delegate: User | None
    organization: Organization | None
    capabilities: frozenset[str]
    # An OAuth connector whose approving account no longer exists: it may do nothing.
    orphaned: bool = False

    def allows(self, capability: str) -> bool:
        return capability in self.capabilities

    def ordered(self) -> list[str]:
        return [name for name in CAPABILITIES if name in self.capabilities]


def _oauth_user_id(session: Session, token_id: uuid.UUID) -> tuple[bool, uuid.UUID | None]:
    """`(is_oauth, user_id)` of the approval that minted this token (the latest one)."""
    row = session.execute(
        select(OAuthAuthorization.user_id)
        .where(OAuthAuthorization.mcp_token_id == token_id)
        .order_by(OAuthAuthorization.created_at.desc())
        .limit(1)
    ).first()
    return (row is not None, row[0] if row is not None else None)


def delegate_of(session: Session, record: McpToken) -> tuple[User | None, bool]:
    """`(delegated person, orphaned)` of an agent token (see the module docstring)."""
    is_oauth, user_id = _oauth_user_id(session, record.id)
    if is_oauth:
        user = session.get(User, user_id) if user_id is not None else None
        return user, user is None
    if record.mode is AgentMode.INTERACTIVE and record.owner_email:
        user = session.scalar(
            select(User).where(func.lower(User.email) == record.owner_email.lower())
        )
        return user, False
    return None, False


def grant_for(session: Session, record: McpToken) -> AgentGrant:
    delegate, orphaned = delegate_of(session, record)
    capabilities = frozenset() if orphaned else intersect(record.capabilities, delegate)
    return AgentGrant(
        token=record,
        delegate=delegate,
        organization=session.get(Organization, record.organization_id),
        capabilities=capabilities,
        orphaned=orphaned,
    )
