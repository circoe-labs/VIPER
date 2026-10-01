"""CIRCOE Toolbox connection API (`/api/settings/toolbox`, Contact port S6; handoff Task 15).

Session-protected like every feature route (CSRF on POST). No route returns or accepts a token.

- `GET  /settings/toolbox`           the connection state for Settings > Connexions;
- `POST /settings/toolbox/connect`   starts the OAuth flow: `{authorization_url}` the browser
                                     goes to (the Toolbox, then Infomaniak);
- `POST /settings/toolbox/callback`  the SPA page the Toolbox redirected to (`/settings/
                                     connections?code=…&state=…&iss=…`) posts those parameters
                                     here: same signed-in person, single-use state, code exchange;
- `POST /settings/toolbox/forget`    « Oublier la connexion » (VIPER side only: the Toolbox offers
                                     no revocation, the token expires by itself).

The browser's return lands on the SPA, not on the API: the session cookie is `SameSite=Strict`
and scoped to `/api`, so a redirect from the Toolbox's site would reach the API without it. The
SPA's own call carries the session and the CSRF token, and the `state` is bound to the person.

Refusals: 503 `toolbox_not_configured`; the OAuth codes of `app.services.toolbox.errors`
(400 `toolbox_state_invalid`, 403 `toolbox_access_denied`, 400 `toolbox_issuer_mismatch`,
502 `toolbox_token_exchange_failed`, 422 `toolbox_scope_missing`, 502 `toolbox_unavailable`,
504 `toolbox_timeout`…). Connecting and forgetting are audited (`toolbox.connected`,
`toolbox.forgotten`), without any token.
"""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, StringConstraints

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.services import audit
from app.services.audit import AuditAction
from app.services.contact_remote_drafts import queue_counts
from app.services.toolbox.integration import ToolboxIntegration

router = APIRouter(prefix="/settings/toolbox", tags=["settings"])

TOOLBOX_ENTITY = "toolbox_connection"
Param = Annotated[str, StringConstraints(max_length=4096)]


def get_toolbox(request: Request) -> ToolboxIntegration:
    integration: ToolboxIntegration = request.app.state.toolbox
    return integration


ToolboxDep = Annotated[ToolboxIntegration, Depends(get_toolbox)]


class LastErrorOut(BaseModel):
    code: str
    at: datetime


class CleanupsOut(BaseModel):
    # Obsolete Infomaniak drafts still to delete, and how many of them failed at least once.
    pending: int
    failing: int


class ToolboxStatusOut(BaseModel):
    enabled: bool
    # `disabled` | `not_configured` | `disconnected` | `connected` | `expired`
    state: str
    configured: bool
    connected: bool
    # Names of the missing settings (never a value).
    missing: list[str]
    toolbox_origin: str | None
    connected_at: datetime | None
    connected_by: str | None
    expires_at: datetime | None
    # The Toolbox names no mailbox or account in its token answer: always null for now.
    account_label: str | None
    last_error: LastErrorOut | None
    cleanups: CleanupsOut


class ConnectOut(BaseModel):
    authorization_url: str


class CallbackIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    state: Param = ""
    code: Param = ""
    iss: Param = ""
    error: Param = ""


def status_out(integration: ToolboxIntegration, session: SessionDep) -> ToolboxStatusOut:
    status = integration.status()
    counts = queue_counts(session)
    return ToolboxStatusOut(
        enabled=status.enabled,
        state=status.state,
        configured=integration.configured,
        connected=status.state == "connected",
        missing=status.missing,
        toolbox_origin=status.toolbox_origin,
        connected_at=status.connected_at,
        connected_by=status.connected_by,
        expires_at=status.expires_at,
        account_label=None,
        last_error=LastErrorOut(code=status.last_error.code, at=status.last_error.at)
        if status.last_error
        else None,
        cleanups=CleanupsOut(pending=counts.pending, failing=counts.failing),
    )


@router.get("")
def toolbox_status(integration: ToolboxDep, session: SessionDep) -> ToolboxStatusOut:
    return status_out(integration, session)


@router.post("/connect")
def connect(integration: ToolboxDep, actor: CurrentActor) -> ConnectOut:
    with business_errors():
        return ConnectOut(authorization_url=integration.start(actor))


@router.post("/callback")
def callback(
    body: CallbackIn, integration: ToolboxDep, session: SessionDep, actor: CurrentActor
) -> ToolboxStatusOut:
    with business_errors():
        integration.complete(body.model_dump(), actor)
    status = integration.status()
    audit.record_event(
        session,
        actor,
        AuditAction.TOOLBOX_CONNECTED,
        entity_type=TOOLBOX_ENTITY,
        entity_id=None,
        changes={
            "expires_at": {
                "before": None,
                "after": status.expires_at.isoformat() if status.expires_at else None,
            },
            "toolbox_origin": {"before": None, "after": status.toolbox_origin},
        },
    )
    return status_out(integration, session)


@router.post("/forget")
def forget(integration: ToolboxDep, session: SessionDep, actor: CurrentActor) -> ToolboxStatusOut:
    with business_errors():
        had = integration.forget()
    if had:
        audit.record_event(
            session,
            actor,
            AuditAction.TOOLBOX_FORGOTTEN,
            entity_type=TOOLBOX_ENTITY,
            entity_id=None,
        )
    return status_out(integration, session)
