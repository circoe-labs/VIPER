"""Integration settings set from the browser (`/api/settings/integrations`, Contact port S8).

Session-protected like every feature route (CSRF on PUT/POST); a person only.

- `GET  /settings/integrations`              the effective value of each editable setting, where
                                             it comes from (`ui` | `env` | `default`), what a reset
                                             would give, the OpenAI key's metadata (never the key),
                                             `generation_available`, the Toolbox and dispatcher
                                             summaries, and the `version` to send back;
- `PUT  /settings/integrations`              a partial update: `{version, …fields}`; a field set
                                             to `null` goes back to the variable / the default;
                                             the key is `openai_api_key` (write-only). Applied at
                                             once (no restart): the routes read the new settings,
                                             the Toolbox and the workers are reconfigured;
- `POST /settings/integrations/openai/check` « Tester la clé »: one `GET /models/{model}` with the
                                             saved key (no token generated); answers the outcome.

Refusals: 422 `invalid` with the `field` (the startup rules of `Settings`), 409 `conflict` (the
settings changed since `version` was read), 403 `human_actor_required`. A save is audited
(`settings.integrations_changed`, the changed values except the key: `replaced` / `removed`).
"""

import logging
import time
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.core.actor import ActorContext, ActorType
from app.core.config import Settings
from app.services import audit
from app.services.audit import AuditAction
from app.services.contact_dispatch_worker import ContactDispatcher
from app.services.errors import ActorNotAllowedError, MailGenerationError
from app.services.integration_runtime import IntegrationRuntime
from app.services.mail_generation.openai_client import check_model, config_from_settings
from app.services.runtime_settings import (
    EDITABLE_FIELDS,
    SECRET_FIELDS,
    SECRET_REMOVED,
    SECRET_REPLACED,
    RuntimeSettings,
)
from app.services.toolbox.integration import ToolboxIntegration

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/settings/integrations", tags=["settings"])

INTEGRATIONS_ENTITY = "integration_settings"
Text = Annotated[str, Field(max_length=4000)]


class FieldOut(BaseModel):
    value: str | int | bool | None
    # `ui`: set on this page; `env`: the `VIPER_*` variable; `default`: the built-in default.
    source: Literal["ui", "env", "default"]
    # What « Rétablir la valeur par défaut » would give (the variable, else the default).
    fallback: str | int | bool | None
    updated_at: datetime | None
    updated_by: str | None


class SecretOut(BaseModel):
    """A write-only secret: whether one applies, its last four characters, where it comes from."""

    set: bool
    last4: str | None
    source: Literal["ui", "env", "default"] | None
    updated_at: datetime | None
    updated_by: str | None


class ToolboxSummaryOut(BaseModel):
    enabled: bool
    state: str
    configured: bool


class DispatchSummaryOut(BaseModel):
    running: bool
    active: bool


class IntegrationsOut(BaseModel):
    # The concurrency token to send back with a PUT.
    version: int
    updated_at: datetime | None
    updated_by: str | None
    # `unreadable` | `invalid`: the stored file was ignored at startup (the next save rewrites it).
    load_error: str | None
    # The stored settings dropped at startup because they broke a rule (names only).
    load_dropped: list[str]
    storage_path: str
    fields: dict[str, FieldOut]
    openai_api_key: SecretOut
    generation_available: bool
    toolbox: ToolboxSummaryOut
    dispatch: DispatchSummaryOut


class IntegrationsIn(BaseModel):
    """Only the fields present change; `null` = back to the variable / the default. Strings are
    trimmed; an empty optional text (`""`) means « none » even when a variable sets one."""

    model_config = ConfigDict(extra="forbid")

    version: int
    openai_api_key: Annotated[str, Field(max_length=500)] | None = None
    openai_model: Text | None = None
    openai_base_url: Text | None = None
    openai_timeout_ms: int | None = None
    openai_max_retries: int | None = None
    contact_booking_url: Text | None = None
    default_outbound_email: Text | None = None
    toolbox_mail_enabled: bool | None = None
    toolbox_mcp_url: Text | None = None
    toolbox_oauth_redirect_uri: Text | None = None
    contact_dispatch_interval_ms: int | None = None
    infomaniak_send_allowlist: Text | None = None


class CheckOut(BaseModel):
    ok: bool
    # The `ai_*` code of a failed check (`ai_not_configured`, `ai_auth_failed`,
    # `ai_model_not_found`, `ai_rate_limited`, `ai_timeout`, `ai_upstream_error`…).
    code: str | None
    model: str | None
    elapsed_ms: int


def _runtime(request: Request) -> RuntimeSettings:
    runtime: RuntimeSettings = request.app.state.runtime_settings
    return runtime


def integrations_out(request: Request) -> IntegrationsOut:
    runtime = _runtime(request)
    file = runtime.file
    # The same source as every other route (S8 QA m6).
    effective: Settings = request.app.state.settings
    fields: dict[str, FieldOut] = {}
    for name in EDITABLE_FIELDS:
        if name in SECRET_FIELDS:
            continue
        stored = runtime.stored(name)
        fields[name] = FieldOut(
            value=getattr(effective, name),
            source=runtime.source(name),
            fallback=runtime.fallback(name),
            updated_at=stored.updated_at if stored else None,
            updated_by=stored.updated_by if stored else None,
        )
    key = runtime.secret_meta("openai_api_key")
    integration: ToolboxIntegration = request.app.state.toolbox
    status = integration.status()
    dispatcher: ContactDispatcher | None = request.app.state.contact_dispatcher
    worker = dispatcher.status() if dispatcher else None
    return IntegrationsOut(
        version=file.revision,
        updated_at=file.updated_at,
        updated_by=file.updated_by,
        load_error=runtime.load_error,
        load_dropped=runtime.dropped,
        storage_path=str(runtime.store.path),
        fields=fields,
        openai_api_key=SecretOut(
            set=key.set,
            last4=key.last4,
            source=key.source,
            updated_at=key.updated_at,
            updated_by=key.updated_by,
        ),
        generation_available=effective.generation_available,
        toolbox=ToolboxSummaryOut(
            enabled=status.enabled, state=status.state, configured=integration.configured
        ),
        dispatch=DispatchSummaryOut(
            running=worker.running if worker else False,
            active=worker.active if worker else False,
        ),
    )


@router.get("")
def read_integrations(request: Request) -> IntegrationsOut:
    return integrations_out(request)


@router.put("")
def update_integrations(
    body: IntegrationsIn, request: Request, session: SessionDep, actor: CurrentActor
) -> IntegrationsOut:
    changes: dict[str, Any] = {
        name: getattr(body, name) for name in body.model_fields_set if name != "version"
    }
    save_and_apply(request, session, actor, changes, expected_revision=body.version)
    return integrations_out(request)


def save_and_apply(
    request: Request,
    session: Session,
    actor: ActorContext,
    changes: dict[str, Any],
    *,
    expected_revision: int | None = None,
    auto: frozenset[str] = frozenset(),
) -> None:
    """Validate and save `changes`, switch the process to them (no restart), audit them.
    `expected_revision` None: a server-side change on the current revision (the Toolbox
    connection enabling the integration and recording the page's address)."""
    runtime = _runtime(request)
    integrations: IntegrationRuntime = request.app.state.integrations
    with business_errors(), integrations.lock:
        if actor.type != ActorType.HUMAN:
            raise ActorNotAllowedError("The integration settings are changed by a person.")
        revision = runtime.file.revision if expected_revision is None else expected_revision
        change = runtime.update(changes, expected_revision=revision, actor=actor, auto=auto)
        forgot = integrations.apply(change.before, change.after)
    if forgot:
        # A changed server address: the token of the previous one is deleted (S8 QA B1).
        audit.record_event(
            session,
            actor,
            AuditAction.TOOLBOX_FORGOTTEN,
            entity_type="toolbox_connection",
            entity_id=None,
            reason="toolbox_mcp_url changed",
        )
    if not change.changed:
        return
    secrets = [
        f"{name}: {SECRET_REPLACED if changes.get(name) is not None else SECRET_REMOVED}"
        for name in change.changed
        if name in SECRET_FIELDS
    ]
    audit.record_event(
        session,
        actor,
        AuditAction.SETTINGS_INTEGRATIONS_CHANGED,
        entity_type=INTEGRATIONS_ENTITY,
        entity_id=None,
        changes={
            name: {
                "before": _audited(getattr(change.before, name)),
                "after": _audited(getattr(change.after, name)),
            }
            for name in change.changed
            if name not in SECRET_FIELDS
        },
        reason="; ".join(secrets) or None,
    )


def _audited(value: object) -> object:
    return value if value is None or isinstance(value, str | int | bool) else str(value)


@router.post("/openai/check")
def check_openai(request: Request, actor: CurrentActor) -> CheckOut:
    """« Tester la clé »: the saved configuration, not what the form holds."""
    settings: Settings = request.app.state.settings
    config = config_from_settings(settings)
    if config is None:
        return CheckOut(ok=False, code="ai_not_configured", model=None, elapsed_ms=0)
    started = time.monotonic()
    try:
        model = check_model(config, transport=request.app.state.openai_transport)
    except MailGenerationError as error:
        elapsed = round((time.monotonic() - started) * 1000)
        logger.warning(
            "integrations.openai_check_failed code=%s upstream_status=%s upstream_code=%s",
            error.code,
            error.upstream_status,
            error.upstream_code,
        )
        return CheckOut(ok=False, code=error.code, model=None, elapsed_ms=elapsed)
    elapsed = round((time.monotonic() - started) * 1000)
    logger.info("integrations.openai_check_ok elapsed_ms=%s by=%s", elapsed, actor.id)
    return CheckOut(ok=True, code=None, model=model, elapsed_ms=elapsed)
