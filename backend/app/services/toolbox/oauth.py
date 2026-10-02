"""VIPER → CIRCOE Toolbox connection: an OAuth 2.1 Authorization Code + PKCE (S256) client.

Port of the reference `src/server/toolboxAuth.ts` — the mechanism the Toolbox offers every MCP
client (its `apps/server/src/oauth.ts`, discovery checked on 2026-09-29):

1. discovery: RFC 9728 `/.well-known/oauth-protected-resource` (its `resource` must be exactly
   `VIPER_TOOLBOX_MCP_URL`; first `authorization_servers` entry) then RFC 8414
   `/.well-known/oauth-authorization-server` of that issuer; PKCE S256 required;
2. dynamic client registration (RFC 7591 `/register`, public client,
   `token_endpoint_auth_method=none`), kept in the token file and reused while the issuer and the
   redirect URI stay the same;
3. `start`: a single-use `state` (32 random bytes) bound to the VIPER user who clicked, a PKCE
   verifier, and the `/authorize` URL with `resource` (RFC 8707, the exact MCP URL) and
   `scope=mail` (least privilege). The Toolbox signs the person in at Infomaniak and asks for a
   personal Infomaniak API token (Mail), then sends the browser back to the redirect URI with
   `code`, `state` and `iss` (RFC 9207);
4. `complete`: the SPA posts those back through a session-protected API call; the `state` is
   consumed once, must belong to the same VIPER user, `iss` is checked, then the code is
   exchanged at `/token` (`authorization_code` + `code_verifier` + `resource`).

The bearer token lasts 30 days and the Toolbox issues no refresh token
(`grant_types_supported: ["authorization_code"]`): at expiry, or when the Toolbox answers 401
(archived member, Toolbox secret rotated), the connection becomes « à reconnecter ». A standard
`refresh_token` grant is used only when a server provides one (tests), never assumed. « Oublier »
deletes the token on VIPER's side only: the Toolbox offers no revocation, the token expires by
itself.

The pending authorizations live in memory (the API runs as one process): a restart during the
flow answers `toolbox_state_invalid` and the person connects again. Nothing here logs or returns a
token, a code or a verifier.
"""

import base64
import hashlib
import logging
import secrets
import threading
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode, urlsplit

import httpx2
from pydantic import BaseModel, ValidationError

from app.core.actor import ActorContext
from app.core.config import toolbox_url
from app.services.toolbox.errors import toolbox_error
from app.services.toolbox.token_store import (
    ConnectedBy,
    LastError,
    StoredClient,
    StoredToken,
    TokenStore,
)

logger = logging.getLogger(__name__)

SCOPE = "mail"
CLIENT_NAME = "VIPER"
# The person creates and pastes an Infomaniak API token during the flow (same bound as the Toolbox).
PENDING_TTL = timedelta(minutes=30)
# A token this close to its expiry is treated as expired (the call would race it).
EXPIRY_SKEW = timedelta(minutes=1)
MAX_PENDING = 20


# --- metadata ----------------------------------------------------------------------------------


class _ProtectedResource(BaseModel):
    resource: str
    authorization_servers: list[str]


class _AuthorizationServer(BaseModel):
    issuer: str
    authorization_endpoint: str
    token_endpoint: str
    registration_endpoint: str | None = None
    code_challenge_methods_supported: list[str] | None = None
    grant_types_supported: list[str] | None = None
    authorization_response_iss_parameter_supported: bool | None = None


class _Registration(BaseModel):
    client_id: str


class _TokenAnswer(BaseModel):
    access_token: str
    token_type: str | None = None
    expires_in: float | None = None
    refresh_token: str | None = None
    scope: str | None = None


@dataclass(frozen=True, slots=True)
class Discovery:
    resource: str
    server: _AuthorizationServer


def same_url(a: str, b: str) -> bool:
    """Equal absolute URLs, ignoring a trailing slash."""
    left, right = urlsplit(a), urlsplit(b)
    return bool(left.scheme and left.netloc) and (
        (left.scheme, left.netloc.lower(), left.path.rstrip("/"), left.query)
        == (right.scheme, right.netloc.lower(), right.path.rstrip("/"), right.query)
    )


def well_known(base: str, name: str) -> str:
    """RFC 8414 §3: the issuer's path goes after the well-known segment."""
    url = urlsplit(base)
    suffix = url.path.rstrip("/")
    return f"{url.scheme}://{url.netloc}/.well-known/{name}{suffix}"


def _endpoint(value: str, name: str) -> str:
    """A metadata URL VIPER will call or send the browser to: the same rule as the settings
    (https, or http on the loopback only), so a tampered or misconfigured metadata document cannot
    redirect the code, the verifier or the person elsewhere."""
    try:
        return toolbox_url(value)
    except ValueError:
        raise toolbox_error(
            "toolbox_rejected", f"The Toolbox announces an unsafe {name} (https required)."
        ) from None


def pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _parse[T: BaseModel](model: type[T], payload: object) -> T | None:
    try:
        return model.model_validate(payload)
    except ValidationError:
        return None


# --- status ------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AuthStatus:
    # `disconnected` (no token), `connected`, `expired` (to reconnect).
    state: str
    connected_at: datetime | None
    connected_by: str | None
    expires_at: datetime | None
    refreshable: bool
    scope: str | None
    last_error: LastError | None


@dataclass(frozen=True, slots=True)
class _Pending:
    verifier: str
    client_id: str
    issuer: str
    token_endpoint: str
    resource: str
    refresh_supported: bool
    iss_required: bool
    actor: ConnectedBy
    expires_at: datetime


def forget_token(store: TokenStore) -> bool:
    """Delete the stored token, who connected and the last error (the client registration is
    kept). True when there was a token. Works without a configured integration (S8: « Se
    déconnecter » while disabled, a changed server address)."""
    file = store.read()
    had = file.token is not None
    file.token = None
    file.connected_by = None
    file.connected_at = None
    file.last_error = None
    store.write(file)
    return had


# --- the client --------------------------------------------------------------------------------


class ToolboxAuth:
    def __init__(
        self,
        *,
        mcp_url: str,
        redirect_uri: str,
        store: TokenStore,
        timeout_seconds: float,
        transport: httpx2.BaseTransport | None = None,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self.mcp_url = mcp_url
        self.redirect_uri = redirect_uri
        self._store = store
        self._timeout = timeout_seconds
        self._transport = transport
        self._now = now
        self._pending: dict[str, _Pending] = {}
        # States of connections started before a change of the Toolbox settings (S8): their
        # return is refused as « interrupted », never as unknown.
        self._interrupted: set[str] = set()
        # One read-modify-write of the store at a time (request threads, cleanup worker).
        self._lock = threading.RLock()

    # --- HTTP ---

    def _request(self, method: str, url: str, **kwargs: Any) -> tuple[int, object]:
        try:
            with httpx2.Client(
                timeout=self._timeout, transport=self._transport, trust_env=False
            ) as client:
                response = client.request(
                    method, url, headers={"Accept": "application/json"}, **kwargs
                )
        except httpx2.TimeoutException:
            raise toolbox_error(
                "toolbox_timeout", "The Toolbox authorization server did not answer in time."
            ) from None
        except httpx2.TransportError:
            raise toolbox_error(
                "toolbox_unavailable", "The Toolbox authorization server cannot be reached."
            ) from None
        try:
            payload: object = response.json()
        except ValueError:
            # intentional: a non-JSON answer is reported by the caller as invalid metadata.
            payload = None
        return response.status_code, payload

    # --- discovery and registration ---

    def discover(self) -> Discovery:
        origin = urlsplit(self.mcp_url)
        candidates = (
            f"{origin.scheme}://{origin.netloc}/.well-known/oauth-protected-resource",
            well_known(self.mcp_url, "oauth-protected-resource"),
        )
        resource: _ProtectedResource | None = None
        for url in candidates:
            status, payload = self._request("GET", url)
            resource = _parse(_ProtectedResource, payload) if status == 200 else None
            if resource and resource.authorization_servers:
                break
        if resource is None or not resource.authorization_servers:
            raise toolbox_error("toolbox_unavailable", "The Toolbox OAuth metadata is missing.")
        if not same_url(resource.resource, self.mcp_url):
            raise toolbox_error(
                "toolbox_not_configured",
                "VIPER_TOOLBOX_MCP_URL is not the resource the Toolbox announces.",
            )
        issuer = _endpoint(resource.authorization_servers[0], "authorization server")
        status, payload = self._request("GET", well_known(issuer, "oauth-authorization-server"))
        server = _parse(_AuthorizationServer, payload) if status == 200 else None
        if server is None or not same_url(server.issuer, issuer):
            raise toolbox_error(
                "toolbox_unavailable", "The Toolbox authorization server metadata is invalid."
            )
        if "S256" not in (server.code_challenge_methods_supported or []):
            raise toolbox_error(
                "toolbox_rejected", "The Toolbox authorization server does not offer PKCE S256."
            )
        server.authorization_endpoint = _endpoint(
            server.authorization_endpoint, "authorization endpoint"
        )
        server.token_endpoint = _endpoint(server.token_endpoint, "token endpoint")
        if server.registration_endpoint is not None:
            server.registration_endpoint = _endpoint(
                server.registration_endpoint, "registration endpoint"
            )
        return Discovery(resource=resource.resource, server=server)

    def _registered_client(self, server: _AuthorizationServer) -> str:
        with self._lock:
            file = self._store.read()
            if (
                file.client
                and file.client.issuer == server.issuer
                and file.client.redirect_uri == self.redirect_uri
            ):
                return file.client.client_id
        if not server.registration_endpoint:
            raise toolbox_error(
                "toolbox_not_configured", "The Toolbox offers no dynamic client registration."
            )
        refresh = "refresh_token" in (server.grant_types_supported or [])
        status, payload = self._request(
            "POST",
            server.registration_endpoint,
            json={
                "client_name": CLIENT_NAME,
                "redirect_uris": [self.redirect_uri],
                "response_types": ["code"],
                "grant_types": ["authorization_code", "refresh_token"]
                if refresh
                else ["authorization_code"],
                "token_endpoint_auth_method": "none",
                "scope": SCOPE,
            },
        )
        registration = _parse(_Registration, payload) if 200 <= status < 300 else None
        if registration is None or not registration.client_id:
            raise toolbox_error(
                "toolbox_rejected",
                "The Toolbox refused to register VIPER (an HTTPS or localhost redirect URI is "
                "required).",
                upstream_status=status,
            )
        with self._lock:
            file = self._store.read()
            file.client = StoredClient(
                issuer=server.issuer,
                client_id=registration.client_id,
                redirect_uri=self.redirect_uri,
                registered_at=self._now(),
            )
            self._store.write(file)
        logger.info("toolbox.client_registered issuer=%s", server.issuer)
        return registration.client_id

    # --- the authorization flow ---

    def adopt_pending(self, previous: ToolboxAuth) -> None:
        """After a rebuild of the integration (S8): connections started on `previous` stay
        valid when the server and the return address did not change; otherwise their return is
        refused as interrupted (the code was issued for another address)."""
        with previous._lock:
            pending = dict(previous._pending)
        with self._lock:
            if (
                same_url(previous.mcp_url, self.mcp_url)
                and previous.redirect_uri == self.redirect_uri
            ):
                self._pending.update(pending)
            else:
                self._interrupted.update(pending)

    def bound(self, token: StoredToken) -> bool:
        """The token was issued for this MCP server (RFC 8707 resource). A token for another
        address is never sent (S8): the connection counts as absent until a new one."""
        return same_url(token.resource, self.mcp_url)

    def _drop_expired_pending(self) -> None:
        now = self._now()
        for state in [key for key, item in self._pending.items() if item.expires_at <= now]:
            del self._pending[state]

    def start(self, actor: ActorContext) -> str:
        """The `/authorize` URL the browser goes to."""
        discovery = self.discover()
        server = discovery.server
        client_id = self._registered_client(server)
        state = secrets.token_urlsafe(32)
        verifier = secrets.token_urlsafe(48)
        with self._lock:
            self._drop_expired_pending()
            while len(self._pending) >= MAX_PENDING:
                # Bounded memory: the oldest unfinished attempt goes first.
                self._pending.pop(next(iter(self._pending)))
            self._pending[state] = _Pending(
                verifier=verifier,
                client_id=client_id,
                issuer=server.issuer,
                token_endpoint=server.token_endpoint,
                resource=discovery.resource,
                refresh_supported="refresh_token" in (server.grant_types_supported or []),
                iss_required=bool(server.authorization_response_iss_parameter_supported),
                actor=ConnectedBy(id=actor.id, display=actor.display),
                expires_at=self._now() + PENDING_TTL,
            )
        query = urlencode(
            {
                "response_type": "code",
                "client_id": client_id,
                "redirect_uri": self.redirect_uri,
                "code_challenge": pkce_challenge(verifier),
                "code_challenge_method": "S256",
                "scope": SCOPE,
                "resource": discovery.resource,
                "state": state,
            }
        )
        separator = "&" if urlsplit(server.authorization_endpoint).query else "?"
        return f"{server.authorization_endpoint}{separator}{query}"

    def complete(self, params: dict[str, str], actor: ActorContext) -> None:
        """The browser's return: consume the `state`, check `iss`, exchange the code. Raises a
        `ToolboxError` (`toolbox_state_invalid`, `toolbox_access_denied`, …) on any failure."""
        state = params.get("state", "")
        with self._lock:
            self._drop_expired_pending()
            item = self._pending.get(state) if state else None
            # Someone else's state is refused without being consumed (it stays usable by its owner).
            if item is not None and item.actor.id == actor.id:
                del self._pending[state]
        if item is None and state in self._interrupted:
            raise toolbox_error(
                "toolbox_connection_interrupted",
                "The connection was interrupted by a change of the Toolbox settings: start again.",
            )
        if item is None or item.actor.id != actor.id:
            raise toolbox_error(
                "toolbox_state_invalid",
                "This connection attempt is unknown, expired or someone else's: start again.",
            )
        error = params.get("error", "")
        if error:
            code = (
                "toolbox_access_denied"
                if error == "access_denied"
                else ("toolbox_authorization_failed")
            )
            raise toolbox_error(code, "The Toolbox did not grant the connection.")
        iss = params.get("iss", "")
        if (iss and not same_url(iss, item.issuer)) or (not iss and item.iss_required):
            raise toolbox_error(
                "toolbox_issuer_mismatch", "The answer does not come from the expected Toolbox."
            )
        code = params.get("code", "")
        if not code:
            raise toolbox_error("toolbox_authorization_failed", "The Toolbox sent no code.")
        status, payload = self._request(
            "POST",
            item.token_endpoint,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "client_id": item.client_id,
                "redirect_uri": self.redirect_uri,
                "code_verifier": item.verifier,
                "resource": item.resource,
            },
        )
        answer = _parse(_TokenAnswer, payload) if status == 200 else None
        if (
            answer is None
            or not answer.access_token
            or (answer.token_type and answer.token_type.lower() != "bearer")
        ):
            raise toolbox_error(
                "toolbox_token_exchange_failed",
                "The Toolbox did not issue a token.",
                upstream_status=status,
            )
        scope = answer.scope or SCOPE
        if SCOPE not in scope.split():
            raise toolbox_error(
                "toolbox_scope_missing", "The Toolbox did not grant the mail scope."
            )
        now = self._now()
        with self._lock:
            file = self._store.read()
            file.token = StoredToken(
                access_token=answer.access_token,
                refresh_token=answer.refresh_token,
                expires_at=now + timedelta(seconds=answer.expires_in)
                if answer.expires_in and answer.expires_in > 0
                else None,
                scope=scope,
                issuer=item.issuer,
                resource=item.resource,
                token_endpoint=item.token_endpoint,
                client_id=item.client_id,
                refresh_supported=item.refresh_supported,
                obtained_at=now,
            )
            file.connected_by = item.actor
            file.connected_at = now
            file.last_error = None
            self._store.write(file)

    def forget(self) -> bool:
        """Delete the token on VIPER's side (the client registration is kept). True when there
        was one."""
        with self._lock:
            return forget_token(self._store)

    def record_error(self, code: str) -> None:
        with self._lock:
            file = self._store.read()
            file.last_error = LastError(code=code, at=self._now())
            self._store.write(file)

    # --- the token ---

    def _expired(self, token: StoredToken) -> bool:
        return token.expires_at is not None and token.expires_at - EXPIRY_SKEW <= self._now()

    @staticmethod
    def _can_refresh(token: StoredToken) -> bool:
        return bool(token.refresh_token and token.refresh_supported)

    def status(self) -> AuthStatus:
        file = self._store.read()
        token = file.token
        if token is not None and not self.bound(token):
            token = None  # issued for another server address: not this connection
        if token is None:
            state = "disconnected"
        elif token.invalidated_at or (self._expired(token) and not self._can_refresh(token)):
            state = "expired"
        else:
            state = "connected"
        by = file.connected_by
        return AuthStatus(
            state=state,
            connected_at=file.connected_at if token else None,
            connected_by=(by.display or by.id) if token and by else None,
            expires_at=token.expires_at if token else None,
            refreshable=bool(token and self._can_refresh(token)),
            scope=token.scope if token else None,
            last_error=file.last_error,
        )

    def _invalidate(self, access_token: str, code: str) -> None:
        with self._lock:
            file = self._store.read()
            if file.token and file.token.access_token == access_token:
                if file.token.invalidated_at is None:
                    file.token.invalidated_at = self._now()
                    logger.info("toolbox.token_invalidated code=%s", code)
                file.last_error = LastError(code=code, at=self._now())
                self._store.write(file)

    def _refresh(self, token: StoredToken) -> str | None:
        if not self._can_refresh(token):
            self._invalidate(token.access_token, "toolbox_auth_expired")
            return None
        status, payload = self._request(
            "POST",
            token.token_endpoint,
            data={
                "grant_type": "refresh_token",
                "refresh_token": token.refresh_token or "",
                "client_id": token.client_id,
                "resource": token.resource,
            },
        )
        if status >= 500:
            raise toolbox_error(
                "toolbox_unavailable", "The Toolbox token refresh failed.", upstream_status=status
            )
        answer = _parse(_TokenAnswer, payload) if status == 200 else None
        if answer is None:
            self._invalidate(token.access_token, "toolbox_auth_expired")
            return None
        now = self._now()
        with self._lock:
            file = self._store.read()
            if file.token is None:
                return None  # forgotten during the refresh
            file.token = file.token.model_copy(
                update={
                    "access_token": answer.access_token,
                    "refresh_token": answer.refresh_token or file.token.refresh_token,
                    "expires_at": now + timedelta(seconds=answer.expires_in)
                    if answer.expires_in
                    else None,
                    "scope": answer.scope or file.token.scope,
                    "obtained_at": now,
                    "invalidated_at": None,
                }
            )
            self._store.write(file)
        logger.info("toolbox.token_refreshed")
        return answer.access_token

    def report_rejected(self, access_token: str, code: str) -> None:
        """A tool call said the connection behind this token is no longer valid (e.g. the
        Toolbox has no Infomaniak connection for the member any more): to reconnect, recorded."""
        self._invalidate(access_token, code)

    def access_token(self) -> str | None:
        """The usable bearer token, refreshed when it can be; None = (re)connection needed."""
        token = self._store.read().token
        if token is None or token.invalidated_at is not None or not self.bound(token):
            return None
        return self._refresh(token) if self._expired(token) else token.access_token

    def refresh_after_unauthorized(self, rejected: str) -> str | None:
        """The Toolbox answered 401 to `rejected`: one refresh attempt, else the token is marked
        to reconnect and None is returned."""
        token = self._store.read().token
        if token is None or not self.bound(token):
            return None
        if token.access_token != rejected and token.invalidated_at is None:
            return token.access_token  # already refreshed by another call
        return self._refresh(token)
