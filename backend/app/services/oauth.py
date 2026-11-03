"""OAuth 2.1 authorization server for the MCP endpoint (ChatGPT, claude.ai and other connectors).

The flow, end to end:

1. `register_client` — the connector registers itself (RFC 7591) with its redirect URIs.
2. `start_authorization` — `/oauth/authorize` checks the request (registered client and redirect,
   `response_type=code`, PKCE S256) and stores it pending; the browser goes to the SPA page
   « Autoriser … ? », which requires the person's VIPER session.
3. `approve` / `deny` — the person decides; an approval mints an ordinary `mcp_tokens` row (the
   connector becomes one more agent) and a one-time code bound to the request.
4. `exchange_code` — `/oauth/token` checks the code, the client, the redirect and the PKCE
   verifier, and answers an access token (1 h) and a refresh token (rotated at each use).
5. `resolve_access_token` — `/mcp` turns an access token back into its `mcp_tokens` row.

Revoking the `mcp_tokens` row (Paramètres > MCP) ends every token derived from it. Only SHA-256
hashes of secrets are stored. Contract: `doc/architecture/mcp-server.md` §4.5.
"""

import base64
import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import urlencode, urlsplit

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models.mcp import McpToken
from app.models.oauth import (
    CLIENT_NAME_MAX_LENGTH,
    STATE_MAX_LENGTH,
    URI_MAX_LENGTH,
    OAuthAuthorization,
    OAuthClient,
    OAuthToken,
)
from app.models.users import User
from app.services import mcp_tokens

REQUEST_TTL = timedelta(minutes=10)
CODE_TTL = timedelta(minutes=5)
ACCESS_TTL = timedelta(hours=1)
REFRESH_TTL = timedelta(days=60)
MAX_REDIRECT_URIS = 10
MAX_CLIENTS = 1000
AUTH_METHODS = ("none", "client_secret_post", "client_secret_basic")
SCOPE = "viper"
ACCESS_PREFIX = "viper_at_"
REFRESH_PREFIX = "viper_rt_"


class OAuthError(Exception):
    """An RFC 6749 error: `error` is the protocol code, `description` a human sentence."""

    def __init__(self, error: str, description: str, status: int = 400) -> None:
        super().__init__(description)
        self.error = error
        self.description = description
        self.status = status


class ReplayError(OAuthError):
    """A code or refresh token used twice: the grant's tokens were revoked, and that revocation
    must be committed even though the request fails."""

    def __init__(self, description: str) -> None:
        super().__init__("invalid_grant", description)


def _hash(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def _now(now: datetime | None) -> datetime:
    return now or datetime.now(UTC)


# --- 1. registration ---------------------------------------------------------------------------


def _redirect_uri_allowed(uri: str) -> bool:
    """HTTPS anywhere; plain HTTP only back to this machine (local MCP clients and inspectors)."""
    if len(uri) > URI_MAX_LENGTH:
        return False
    parts = urlsplit(uri)
    if parts.fragment or not parts.netloc:
        return False
    if parts.scheme == "https":
        return True
    return parts.scheme == "http" and (parts.hostname or "") in ("localhost", "127.0.0.1", "::1")


@dataclass(frozen=True, slots=True)
class RegisteredClient:
    client: OAuthClient
    # Shown once, in the registration answer; None for a public client (PKCE only).
    secret: str | None


def register_client(session: Session, metadata: dict[str, Any]) -> RegisteredClient:
    redirect_uris = metadata.get("redirect_uris")
    if (
        not isinstance(redirect_uris, list)
        or not redirect_uris
        or len(redirect_uris) > MAX_REDIRECT_URIS
        or not all(isinstance(uri, str) and _redirect_uri_allowed(uri) for uri in redirect_uris)
    ):
        raise OAuthError(
            "invalid_redirect_uri", "redirect_uris: 1 to 10 HTTPS addresses (HTTP on localhost)."
        )
    auth_method = metadata.get("token_endpoint_auth_method") or "none"
    if auth_method not in AUTH_METHODS:
        raise OAuthError(
            "invalid_client_metadata", f"token_endpoint_auth_method must be one of {AUTH_METHODS}."
        )
    grant_types = metadata.get("grant_types") or ["authorization_code", "refresh_token"]
    if not isinstance(grant_types, list) or "authorization_code" not in grant_types:
        raise OAuthError("invalid_client_metadata", "grant_types must include authorization_code.")
    raw_name = metadata.get("client_name")
    name = raw_name.strip()[:CLIENT_NAME_MAX_LENGTH] if isinstance(raw_name, str) else ""
    if not name:
        name = urlsplit(redirect_uris[0]).hostname or "Connecteur MCP"
    count = session.scalar(select(OAuthClient.id).offset(MAX_CLIENTS - 1).limit(1))
    if count is not None:
        raise OAuthError("invalid_client_metadata", "Too many registered clients.", 429)
    secret = None if auth_method == "none" else secrets.token_urlsafe(32)
    client = OAuthClient(
        client_id=f"viper-{secrets.token_urlsafe(24)}",
        client_name=name,
        redirect_uris=list(dict.fromkeys(redirect_uris)),
        auth_method=auth_method,
        secret_hash=None if secret is None else _hash(secret),
    )
    session.add(client)
    session.flush()
    return RegisteredClient(client=client, secret=secret)


def _client(session: Session, client_id: str | None) -> OAuthClient:
    client = (
        session.scalar(select(OAuthClient).where(OAuthClient.client_id == client_id))
        if client_id
        else None
    )
    if client is None:
        raise OAuthError("invalid_client", "Unknown client.", 401)
    return client


# --- 2. the request ----------------------------------------------------------------------------


def start_authorization(
    session: Session, params: dict[str, str], now: datetime | None = None
) -> OAuthAuthorization:
    """Check an `/oauth/authorize` query and store it pending.

    Raises `OAuthError` for an unknown client or redirect (shown to the person, never redirected:
    the redirect itself is not trusted yet). Other faults are the client's: `redirect_error` sends
    them back to its redirect URI."""
    client = _client(session, params.get("client_id"))
    redirect_uri = params.get("redirect_uri") or (
        client.redirect_uris[0] if len(client.redirect_uris) == 1 else ""
    )
    if redirect_uri not in client.redirect_uris:
        raise OAuthError("invalid_request", "This redirect_uri is not registered for the client.")
    state = params.get("state")
    if params.get("response_type") != "code":
        raise RedirectError(redirect_uri, state, "unsupported_response_type", "Only code.")
    challenge = params.get("code_challenge") or ""
    if params.get("code_challenge_method") != "S256" or not 43 <= len(challenge) <= 128:
        raise RedirectError(
            redirect_uri,
            state,
            "invalid_request",
            "PKCE with code_challenge_method=S256 is required.",
        )
    if state is not None and len(state) > STATE_MAX_LENGTH:
        raise RedirectError(redirect_uri, None, "invalid_request", "state is too long.")
    request = OAuthAuthorization(
        client_pk=client.id,
        redirect_uri=redirect_uri,
        state=state,
        code_challenge=challenge,
        scope=params.get("scope"),
        resource=(params.get("resource") or None),
        status="pending",
        expires_at=_now(now) + REQUEST_TTL,
    )
    session.add(request)
    session.flush()
    return request


class RedirectError(OAuthError):
    """An error the client must receive on its (verified) redirect URI."""

    def __init__(self, redirect_uri: str, state: str | None, error: str, description: str) -> None:
        super().__init__(error, description)
        self.redirect_uri = redirect_uri
        self.state = state

    @property
    def location(self) -> str:
        return with_query(
            self.redirect_uri,
            {"error": self.error, "error_description": self.description, "state": self.state},
        )


def with_query(uri: str, values: dict[str, str | None]) -> str:
    query = urlencode({key: value for key, value in values.items() if value is not None})
    return f"{uri}{'&' if urlsplit(uri).query else '?'}{query}"


@dataclass(frozen=True, slots=True)
class PendingRequest:
    id: uuid.UUID
    client_name: str
    redirect_host: str
    expires_at: datetime


def _pending(
    session: Session, request_id: uuid.UUID, now: datetime | None, *, lock: bool = False
) -> OAuthAuthorization:
    query = select(OAuthAuthorization).where(OAuthAuthorization.id == request_id)
    request = session.scalar(query.with_for_update() if lock else query)
    if request is None or request.status != "pending" or request.expires_at <= _now(now):
        raise OAuthError(
            "invalid_request",
            "This authorization request is unknown, expired or already used.",
            404,
        )
    return request


def describe(
    session: Session, request_id: uuid.UUID, now: datetime | None = None
) -> PendingRequest:
    """What the page « Autoriser … ? » shows: who asks, and where the answer goes."""
    request = _pending(session, request_id, now)
    client = session.get_one(OAuthClient, request.client_pk)
    return PendingRequest(
        id=request.id,
        client_name=client.client_name,
        redirect_host=urlsplit(request.redirect_uri).hostname or request.redirect_uri,
        expires_at=request.expires_at,
    )


# --- 3. the decision ---------------------------------------------------------------------------


def approve(
    session: Session, request_id: uuid.UUID, user: User, now: datetime | None = None
) -> str:
    """Mint the connector's agent token and a one-time code; answer the redirect URL."""
    moment = _now(now)
    request = _pending(session, request_id, moment, lock=True)
    client = session.get_one(OAuthClient, request.client_pk)
    _, record = mcp_tokens.mint(
        session,
        label=f"{client.client_name} (OAuth)"[:100],
        scopes=[mcp_tokens.ANY_SCOPE],
        owner_email=user.email,
    )
    code = secrets.token_urlsafe(32)
    request.status = "approved"
    request.code_hash = _hash(code)
    request.user_id = user.id
    request.mcp_token_id = record.id
    request.expires_at = moment + CODE_TTL
    session.flush()
    return with_query(request.redirect_uri, {"code": code, "state": request.state})


def deny(session: Session, request_id: uuid.UUID, now: datetime | None = None) -> str:
    request = _pending(session, request_id, now, lock=True)
    request.status = "denied"
    session.flush()
    return with_query(
        request.redirect_uri,
        {
            "error": "access_denied",
            "error_description": "The person refused.",
            "state": request.state,
        },
    )


# --- 4. tokens ---------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class TokenPair:
    access_token: str
    refresh_token: str
    expires_in: int


def authenticate_client(session: Session, client_id: str | None, secret: str | None) -> OAuthClient:
    """The token endpoint's client check: a public client sends no secret, a confidential one
    must send the right one (body or Basic, as it registered)."""
    client = _client(session, client_id)
    if client.secret_hash is None:
        return client
    if secret is None or not hmac.compare_digest(client.secret_hash, _hash(secret)):
        raise OAuthError("invalid_client", "Client authentication failed.", 401)
    return client


def _issue(session: Session, client: OAuthClient, record_id: uuid.UUID, now: datetime) -> TokenPair:
    access = ACCESS_PREFIX + secrets.token_urlsafe(32)
    refresh = REFRESH_PREFIX + secrets.token_urlsafe(32)
    for value, kind, ttl in ((access, "access", ACCESS_TTL), (refresh, "refresh", REFRESH_TTL)):
        session.add(
            OAuthToken(
                token_hash=_hash(value),
                kind=kind,
                client_pk=client.id,
                mcp_token_id=record_id,
                expires_at=now + ttl,
            )
        )
    session.flush()
    return TokenPair(access, refresh, int(ACCESS_TTL.total_seconds()))


def _pkce_matches(verifier: str, challenge: str) -> bool:
    digest = hashlib.sha256(verifier.encode()).digest()
    expected = base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    return hmac.compare_digest(expected, challenge)


def exchange_code(
    session: Session,
    client: OAuthClient,
    code: str | None,
    redirect_uri: str | None,
    verifier: str | None,
    now: datetime | None = None,
) -> TokenPair:
    moment = _now(now)
    request = (
        session.scalar(
            select(OAuthAuthorization)
            .where(OAuthAuthorization.code_hash == _hash(code))
            .with_for_update()
        )
        if code
        else None
    )
    if request is None or request.client_pk != client.id:
        raise OAuthError("invalid_grant", "Unknown code.")
    if request.status == "used":
        # A replayed code: the RFC asks to revoke what it gave.
        _revoke_tokens_of(session, request.mcp_token_id, moment)
        raise ReplayError("This code was already used.")
    if request.status != "approved" or request.expires_at <= moment:
        raise OAuthError("invalid_grant", "This code has expired.")
    if redirect_uri is not None and redirect_uri != request.redirect_uri:
        raise OAuthError("invalid_grant", "redirect_uri does not match the authorization.")
    if not verifier or not _pkce_matches(verifier, request.code_challenge):
        raise OAuthError("invalid_grant", "PKCE verification failed.")
    assert request.mcp_token_id is not None
    record = session.get(McpToken, request.mcp_token_id)
    if record is None or record.revoked_at is not None:
        raise OAuthError("invalid_grant", "This authorization was revoked.")
    request.status = "used"
    return _issue(session, client, record.id, moment)


def refresh(
    session: Session, client: OAuthClient, refresh_token: str | None, now: datetime | None = None
) -> TokenPair:
    moment = _now(now)
    row = (
        session.scalar(
            select(OAuthToken)
            .where(OAuthToken.token_hash == _hash(refresh_token), OAuthToken.kind == "refresh")
            .with_for_update()
        )
        if refresh_token
        else None
    )
    if row is None or row.client_pk != client.id:
        raise OAuthError("invalid_grant", "Unknown refresh token.")
    if row.revoked_at is not None:
        # A rotated refresh token used again: someone kept a copy. End the whole grant.
        _revoke_tokens_of(session, row.mcp_token_id, moment)
        raise ReplayError("This refresh token was already used.")
    record = session.get(McpToken, row.mcp_token_id)
    if row.expires_at <= moment or record is None or record.revoked_at is not None:
        raise OAuthError("invalid_grant", "This authorization has expired or was revoked.")
    row.revoked_at = moment
    return _issue(session, client, record.id, moment)


def _revoke_tokens_of(session: Session, record_id: uuid.UUID | None, now: datetime) -> None:
    if record_id is None:
        return
    session.execute(
        update(OAuthToken)
        .where(OAuthToken.mcp_token_id == record_id, OAuthToken.revoked_at.is_(None))
        .values(revoked_at=now)
    )


# --- 5. the MCP endpoint -----------------------------------------------------------------------


def resolve_access_token(
    session: Session, token: str, now: datetime | None = None
) -> McpToken | None:
    """The agent behind a live OAuth access token, or None."""
    if not token.startswith(ACCESS_PREFIX):
        return None
    moment = _now(now)
    row = session.scalar(
        select(OAuthToken).where(OAuthToken.token_hash == _hash(token), OAuthToken.kind == "access")
    )
    if row is None or row.revoked_at is not None or row.expires_at <= moment:
        return None
    record = session.get(McpToken, row.mcp_token_id)
    if record is None or record.revoked_at is not None:
        return None
    record.last_used_at = moment
    return record


# --- Paramètres > MCP: who may connect ---------------------------------------------------------


def revoke_agent(session: Session, record_id: uuid.UUID, now: datetime | None = None) -> McpToken:
    """« Révoquer »: the agent token and every OAuth token derived from it stop at once."""
    moment = _now(now)
    record = session.get(McpToken, record_id)
    if record is None:
        raise OAuthError("not_found", "Unknown agent.", 404)
    if record.revoked_at is None:
        record.revoked_at = moment
    _revoke_tokens_of(session, record.id, moment)
    session.flush()
    return record


def is_oauth_agent(session: Session, record_id: uuid.UUID) -> bool:
    return (
        session.scalar(
            select(OAuthAuthorization.id)
            .where(OAuthAuthorization.mcp_token_id == record_id)
            .limit(1)
        )
        is not None
    )
