"""CIRCOE Toolbox connection API (`/api/settings/toolbox`, Contact port S6; handoff Task 15).

Session-protected like every feature route (CSRF on POST). No route returns or accepts a token.

- `GET  /settings/toolbox`           the connection state for Settings > Connexions;
- `POST /settings/toolbox/connect`   « Se connecter à CIRCOE Toolbox »: turns the integration
                                     on and records the page's return address `{redirect_uri}`
                                     when needed (S8), then starts the OAuth flow:
                                     `{authorization_url}` the browser goes to (the Toolbox,
                                     then Infomaniak);
- `POST /settings/toolbox/callback`  the SPA page the Toolbox redirected to (`/settings/
                                     connections?code=…&state=…&iss=…`) posts those parameters
                                     here: same signed-in person, single-use state, code exchange;
- `POST /settings/toolbox/forget`    « Se déconnecter »: forgets the token and turns the
                                     integration off (VIPER side only: the Toolbox offers no
                                     revocation, the token expires by itself).

The browser's return lands on the SPA, not on the API: the session cookie is `SameSite=Strict`
and scoped to `/api`, so a redirect from the Toolbox's site would reach the API without it. The
SPA's own call carries the session and the CSRF token, and the `state` is bound to the person.

Refusals: 503 `toolbox_not_configured`; the OAuth codes of `app.services.toolbox.errors`
(400 `toolbox_state_invalid`, 403 `toolbox_access_denied`, 400 `toolbox_issuer_mismatch`,
502 `toolbox_token_exchange_failed`, 422 `toolbox_scope_missing`, 502 `toolbox_unavailable`,
504 `toolbox_timeout`…). Connecting and forgetting are audited (`toolbox.connected`,
`toolbox.forgotten`), without any token.
"""

from datetime import datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, ConfigDict, StringConstraints

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.api.routes.integrations import save_and_apply
from app.core.config import Settings
from app.services import audit
from app.services.audit import AuditAction
from app.services.contact_dispatch import dispatch_counts
from app.services.contact_dispatch_worker import ContactDispatcher
from app.services.contact_remote_drafts import queue_counts
from app.services.integration_runtime import IntegrationRuntime
from app.services.runtime_settings import RuntimeSettings
from app.services.toolbox.integration import ToolboxIntegration

router = APIRouter(prefix="/settings/toolbox", tags=["settings"])

TOOLBOX_ENTITY = "toolbox_connection"
Param = Annotated[str, StringConstraints(max_length=4096)]


def get_toolbox(request: Request) -> ToolboxIntegration:
    integration: ToolboxIntegration = request.app.state.toolbox
    return integration


ToolboxDep = Annotated[ToolboxIntegration, Depends(get_toolbox)]


def get_dispatcher(request: Request) -> ContactDispatcher | None:
    dispatcher: ContactDispatcher | None = request.app.state.contact_dispatcher
    return dispatcher


DispatcherDep = Annotated[ContactDispatcher | None, Depends(get_dispatcher)]


def get_claim_ttl(request: Request) -> timedelta:
    settings: Settings = request.app.state.settings
    return settings.contact_dispatch_claim_ttl


ClaimTtlDep = Annotated[timedelta, Depends(get_claim_ttl)]


class LastErrorOut(BaseModel):
    code: str
    at: datetime


class CleanupsOut(BaseModel):
    # Obsolete Infomaniak drafts still to delete, and how many of them failed at least once.
    pending: int
    failing: int


class DispatchOut(BaseModel):
    """The scheduled sending (S7). `running`: the worker runs in this API process
    (`VIPER_CONTACT_DISPATCH_INTERVAL_MS` > 0 and the Toolbox configured); `active`: and the
    Toolbox is connected, so a scheduled message really leaves."""

    running: bool
    active: bool
    interval_seconds: float
    last_pass_at: datetime | None
    # `ok` | `error` (see the server log) | None before the first pass.
    last_outcome: str | None
    # Messages scheduled, and those whose send is unconfirmed (a person may settle them).
    scheduled: int
    unconfirmed: int


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
    dispatch: DispatchOut


class ConnectOut(BaseModel):
    authorization_url: str


class CallbackIn(BaseModel):
    model_config = ConfigDict(extra="ignore")

    state: Param = ""
    code: Param = ""
    iss: Param = ""
    error: Param = ""


def status_out(
    integration: ToolboxIntegration,
    session: SessionDep,
    dispatcher: ContactDispatcher | None,
    claim_ttl: timedelta,
) -> ToolboxStatusOut:
    status = integration.status()
    counts = queue_counts(session)
    worker = dispatcher.status() if dispatcher else None
    pending = dispatch_counts(session, claim_ttl=claim_ttl)
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
        dispatch=DispatchOut(
            running=worker.running if worker else False,
            active=worker.active if worker else False,
            interval_seconds=dispatcher.interval_seconds if dispatcher else 0,
            last_pass_at=worker.last_pass_at if worker else None,
            last_outcome=worker.last_outcome if worker else None,
            scheduled=pending.scheduled,
            unconfirmed=pending.unconfirmed,
        ),
    )


@router.get("")
def toolbox_status(
    integration: ToolboxDep, session: SessionDep, dispatcher: DispatcherDep, claim_ttl: ClaimTtlDep
) -> ToolboxStatusOut:
    return status_out(integration, session, dispatcher, claim_ttl)


class ConnectIn(BaseModel):
    # The page's own `/settings/connections` address (`window.location.origin` + path): where the
    # Toolbox sends the browser back. Used unless a value was typed in « Paramètres avancés » or
    # the environment sets one. Same rule as the setting: https, or http on the loopback.
    redirect_uri: Annotated[str, StringConstraints(max_length=2000)] | None = None


@router.post("/connect")
def connect(
    request: Request, session: SessionDep, actor: CurrentActor, body: ConnectIn | None = None
) -> ConnectOut:
    """« Se connecter à CIRCOE Toolbox » (S8): turns the integration on and records the page's
    return address when needed (saved like any setting, audited), then starts the OAuth flow."""
    runtime: RuntimeSettings = request.app.state.runtime_settings
    settings: Settings = request.app.state.settings
    changes: dict[str, object] = {}
    if not settings.toolbox_mail_enabled:
        changes["toolbox_mail_enabled"] = True
    redirect = body.redirect_uri.strip() if body and body.redirect_uri else None
    name = "toolbox_oauth_redirect_uri"
    if (
        redirect
        and redirect != settings.toolbox_oauth_redirect_uri
        and runtime.source(name) != "env"
        and not runtime.is_typed(name)
    ):
        changes[name] = redirect
    if changes:
        save_and_apply(request, session, actor, changes, auto=frozenset({name}))
    integration: ToolboxIntegration = request.app.state.toolbox
    with business_errors():
        return ConnectOut(authorization_url=integration.start(actor))


@router.post("/callback")
def callback(
    request: Request,
    body: CallbackIn,
    integration: ToolboxDep,
    session: SessionDep,
    actor: CurrentActor,
    claim_ttl: ClaimTtlDep,
) -> ToolboxStatusOut:
    with business_errors():
        integration.complete(body.model_dump(), actor)
    # Connected: the cleanup and scheduled-sending workers start now (S8).
    integrations: IntegrationRuntime = request.app.state.integrations
    integrations.sync()
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
    return status_out(integration, session, request.app.state.contact_dispatcher, claim_ttl)


@router.post("/forget")
def forget(
    request: Request,
    integration: ToolboxDep,
    session: SessionDep,
    actor: CurrentActor,
    claim_ttl: ClaimTtlDep,
) -> ToolboxStatusOut:
    """« Se déconnecter » (S8): forgets the token and turns the integration off (its workers
    stop); « Se connecter à CIRCOE Toolbox » turns it on again."""
    with business_errors():
        # Also while disabled (S8 QA): the token file is emptied in every case.
        had = integration.forget()
    if had:
        audit.record_event(
            session,
            actor,
            AuditAction.TOOLBOX_FORGOTTEN,
            entity_type=TOOLBOX_ENTITY,
            entity_id=None,
        )
    current: Settings = request.app.state.settings
    if current.toolbox_mail_enabled:
        save_and_apply(request, session, actor, {"toolbox_mail_enabled": False})
    integrations: IntegrationRuntime = request.app.state.integrations
    integrations.sync()
    return status_out(
        request.app.state.toolbox, session, request.app.state.contact_dispatcher, claim_ttl
    )
