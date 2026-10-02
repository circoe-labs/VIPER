"""The CIRCOE Toolbox integration of one API process (S6): configuration, connection, mail client.

Port of the reference `src/server/toolboxIntegration.ts`. One instance per application
(`app.state.toolbox`): the pending OAuth authorizations live in it. Off by default
(`VIPER_TOOLBOX_MAIL_ENABLED`): disabled, or enabled without both URLs, there is no OAuth client
and no MCP client — `mail_toolbox()` is None and every message stays local, exactly as before S6.

States shown on Settings > Connexions (`ToolboxIntegration.state`):

- `disabled`        the feature flag is off;
- `not_configured`  enabled, a required setting is missing (`missing` names it, never a value);
- `disconnected`    configured, nobody connected (or the connection was forgotten);
- `connected`       a usable token until `expires_at`;
- `expired`         to reconnect (30-day token past its end, or refused by the Toolbox).
"""

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from urllib.parse import urlsplit

import httpx2

from app.core.actor import ActorContext
from app.core.config import Settings
from app.services.errors import ToolboxError
from app.services.toolbox.errors import toolbox_error
from app.services.toolbox.mcp_client import MailToolbox, McpMailToolbox, ToolInfo
from app.services.toolbox.oauth import AuthStatus, ToolboxAuth, forget_token
from app.services.toolbox.token_store import FileTokenStore, LastError, TokenStore

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ToolboxStatus:
    enabled: bool
    state: str
    missing: list[str]
    # The Toolbox's public origin (no path, no secret).
    toolbox_origin: str | None
    connected_at: datetime | None
    connected_by: str | None
    expires_at: datetime | None
    last_error: LastError | None


class ToolboxIntegration:
    def __init__(
        self,
        settings: Settings,
        *,
        store: TokenStore | None = None,
        transport: httpx2.BaseTransport | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.enabled = settings.toolbox_mail_enabled
        self.missing = settings.toolbox_missing_settings if self.enabled else []
        self.cleanup_interval_seconds = settings.toolbox_cleanup_interval_ms / 1000
        mcp_url, redirect_uri = settings.toolbox_mcp_url, settings.toolbox_oauth_redirect_uri
        # The token file, also when the integration is off: « Se déconnecter » and a changed
        # server address must be able to delete the token (S8).
        self.store: TokenStore = store or FileTokenStore(settings.toolbox_token_store)
        self.auth: ToolboxAuth | None = None
        self._client: McpMailToolbox | None = None
        self._origin: str | None = None
        if self.enabled and mcp_url and redirect_uri:
            timeout = settings.toolbox_timeout_ms / 1000
            self.auth = ToolboxAuth(
                mcp_url=mcp_url,
                redirect_uri=redirect_uri,
                store=self.store,
                timeout_seconds=timeout,
                transport=transport,
                now=now,
            )
            self._client = McpMailToolbox(
                mcp_url=mcp_url, tokens=self.auth, timeout_seconds=timeout, transport=transport
            )
            url = urlsplit(mcp_url)
            self._origin = f"{url.scheme}://{url.netloc}"
        logger.info(
            "toolbox.integration enabled=%s configured=%s", self.enabled, self.auth is not None
        )

    @property
    def configured(self) -> bool:
        return self.auth is not None

    def _auth_status(self) -> AuthStatus | None:
        return self.auth.status() if self.auth else None

    def status(self) -> ToolboxStatus:
        auth = self._auth_status()
        if not self.enabled:
            state = "disabled"
        elif auth is None:
            state = "not_configured"
        else:
            state = auth.state
        return ToolboxStatus(
            enabled=self.enabled,
            state=state,
            missing=self.missing,
            toolbox_origin=self._origin,
            connected_at=auth.connected_at if auth else None,
            connected_by=auth.connected_by if auth else None,
            expires_at=auth.expires_at if auth else None,
            last_error=auth.last_error if auth else None,
        )

    def connected(self) -> bool:
        auth = self._auth_status()
        return auth is not None and auth.state == "connected"

    def _required_auth(self) -> ToolboxAuth:
        if self.auth is None:
            names = ", ".join(self.missing) or "VIPER_TOOLBOX_MAIL_ENABLED"
            message = (
                f"The Toolbox is not configured on the server (missing: {names})."
                if self.enabled
                else "The Toolbox integration is disabled (VIPER_TOOLBOX_MAIL_ENABLED)."
            )
            raise toolbox_error("toolbox_not_configured", message)
        return self.auth

    def start(self, actor: ActorContext) -> str:
        """The Toolbox authorization URL for the signed-in person."""
        auth = self._required_auth()
        try:
            url = auth.start(actor)
        except ToolboxError as error:
            auth.record_error(error.code)
            logger.warning("toolbox.connect_start_failed code=%s", error.code)
            raise
        logger.info("toolbox.connect_started")
        return url

    def complete(self, params: dict[str, str], actor: ActorContext) -> None:
        auth = self._required_auth()
        try:
            auth.complete(params, actor)
        except ToolboxError as error:
            auth.record_error(error.code)
            logger.warning("toolbox.connect_failed code=%s", error.code)
            raise
        logger.info("toolbox.connected")

    def forget(self) -> bool:
        """Delete the token, configured or not (S8: « Se déconnecter » while disabled, a changed
        server address). True when there was one."""
        had = self.auth.forget() if self.auth else forget_token(self.store)
        logger.info("toolbox.forgotten had_token=%s", had)
        return had

    def adopt(self, previous: ToolboxIntegration) -> None:
        """After a rebuild (S8): keep the connections started on `previous` when they can still
        finish here (same server and return address), else refuse their return as interrupted."""
        if self.auth is not None and previous.auth is not None:
            self.auth.adopt_pending(previous.auth)

    def mail_toolbox(self) -> MailToolbox | None:
        """The MCP mail client while enabled, configured and connected; else None (local only)."""
        return self._client if self._client is not None and self.connected() else None

    def required_mail_toolbox(self) -> MailToolbox:
        """The client, or the refusal saying why there is none."""
        auth = self._required_auth()
        client = self.mail_toolbox()
        if client is None:
            if auth.status().state == "expired":
                raise toolbox_error(
                    "toolbox_auth_expired", "The Toolbox connection expired: reconnect it."
                )
            raise toolbox_error(
                "toolbox_not_connected",
                "The Toolbox is not connected: connect it from Settings > Connexions.",
            )
        return client

    def list_tools(self) -> list[ToolInfo]:
        """The MCP methods the connected Toolbox allows (live `tools/list`)."""
        self.required_mail_toolbox()
        assert self._client is not None
        return self._client.list_tools()
