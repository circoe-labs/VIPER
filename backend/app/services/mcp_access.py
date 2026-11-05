"""Who may see and revoke an agent credential (Paramètres > MCP > « Accès autorisés » and
« Historique des appels »). Contract: `doc/architecture/mcp-server.md` §4.8.

A person manages an agent token when:

- it acts for them — its delegated person (`agent_capabilities.delegate_of`: the OAuth approver,
  or the account of `owner_email`) is the signed-in account;
- they are an active `admin` of the organisation the agent belongs to (its delegated person's
  organisation; for a token acting for nobody, the token's own `organization_id`);
- they are the platform admin (`is_superadmin`).

A token without a delegated person (no `owner_email`, or one naming no account) is therefore
managed by admins and the platform admin only. Everything else is invisible: the list and the
history leave it out, and a revocation answers `NotFoundError` exactly like an unknown id, so a
member cannot probe which agents exist.
"""

import uuid
from collections.abc import Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.mcp import McpToken
from app.models.organizations import OrganizationRole
from app.models.users import User
from app.services import agent_capabilities, oauth
from app.services.errors import NotFoundError


def _is_admin_of(viewer: User, organization_id: uuid.UUID) -> bool:
    return (
        viewer.is_active
        and viewer.role is OrganizationRole.ADMIN
        and viewer.organization_id == organization_id
    )


def can_manage(session: Session, viewer: User, record: McpToken) -> bool:
    """`viewer` may see this agent, its calls, and revoke it (see the module docstring)."""
    if viewer.is_superadmin:
        return True
    delegate, _ = agent_capabilities.delegate_of(session, record)
    if delegate is not None and delegate.id == viewer.id:
        return True
    organization_id = delegate.organization_id if delegate is not None else record.organization_id
    return _is_admin_of(viewer, organization_id)


def visible_agents(session: Session, viewer: User) -> list[McpToken]:
    """The agents `viewer` manages, live ones first, newest first."""
    records = session.scalars(
        select(McpToken).order_by(McpToken.revoked_at.is_not(None), McpToken.created_at.desc())
    )
    return [record for record in records if can_manage(session, viewer, record)]


def visible_agent_ids(session: Session, viewer: User) -> Sequence[uuid.UUID] | None:
    """The agents whose calls `viewer` may read; `None`: every call (the platform admin)."""
    if viewer.is_superadmin:
        return None
    return [record.id for record in visible_agents(session, viewer)]


def revoke(session: Session, viewer: User, agent_id: uuid.UUID) -> McpToken:
    """« Révoquer »: refused as `NotFoundError` (unknown agent) when `viewer` does not manage it."""
    record = session.get(McpToken, agent_id)
    if record is None or not can_manage(session, viewer, record):
        raise NotFoundError("Unknown agent.")
    return oauth.revoke_agent(session, record.id)
