"""OAuth 2.1 endpoints of the MCP connector flow (ChatGPT, claude.ai…): discovery, registration,
authorization and tokens. Public, outside `/api`: a connector has no VIPER cookie. The person's
decision itself goes through the session-protected `/api/oauth/requests/*` (routes/oauth.py).

Discovery: RFC 9728 (protected resource) and RFC 8414 (authorization server); registration:
RFC 7591; PKCE S256 only. Contract: `doc/architecture/mcp-server.md` §4.5.
"""

import base64
import binascii
import logging
from typing import Any
from urllib.parse import quote, unquote

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, RedirectResponse

from app.db.session import unit_of_work
from app.services import oauth
from app.services.oauth import OAuthError, RedirectError, ReplayError

logger = logging.getLogger(__name__)

router = APIRouter(tags=["oauth"])

# The SPA page « Autoriser … ? » (frontend/src/auth/OAuthConsentPage.tsx).
CONSENT_PAGE = "/autoriser"
NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}


def base_url(request: Request) -> str:
    """This server as the connector reaches it (https behind Caddy: uvicorn trusts its headers)."""
    return str(request.base_url).rstrip("/")


def resource_metadata_url(request: Request) -> str:
    return f"{base_url(request)}/.well-known/oauth-protected-resource"


def _error(error: OAuthError) -> JSONResponse:
    headers = dict(NO_STORE)
    if error.status == 401:
        headers["WWW-Authenticate"] = 'Basic realm="viper"'
    return JSONResponse(
        {"error": error.error, "error_description": error.description},
        status_code=error.status,
        headers=headers,
    )


# --- discovery ---------------------------------------------------------------------------------


@router.get("/.well-known/oauth-protected-resource")
@router.get("/.well-known/oauth-protected-resource/mcp")
def protected_resource(request: Request) -> dict[str, Any]:
    base = base_url(request)
    return {
        "resource": f"{base}/mcp",
        "authorization_servers": [base],
        "bearer_methods_supported": ["header"],
        "scopes_supported": [oauth.SCOPE],
        "resource_name": "VIPER",
    }


@router.get("/.well-known/oauth-authorization-server")
@router.get("/.well-known/openid-configuration")
def authorization_server(request: Request) -> dict[str, Any]:
    base = base_url(request)
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/oauth/authorize",
        "token_endpoint": f"{base}/oauth/token",
        "registration_endpoint": f"{base}/oauth/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": list(oauth.AUTH_METHODS),
        "scopes_supported": [oauth.SCOPE],
    }


# --- registration ------------------------------------------------------------------------------


@router.post("/oauth/register")
async def register(request: Request) -> JSONResponse:
    try:
        metadata = await request.json()
    except ValueError:
        metadata = None
    if not isinstance(metadata, dict):
        return _error(OAuthError("invalid_client_metadata", "A JSON object is expected."))
    try:
        with unit_of_work(request.app.state.session_factory) as session:
            registered = oauth.register_client(session, metadata)
            client = registered.client
            answer: dict[str, Any] = {
                "client_id": client.client_id,
                "client_id_issued_at": int(client.created_at.timestamp())
                if client.created_at
                else None,
                "client_name": client.client_name,
                "redirect_uris": client.redirect_uris,
                "token_endpoint_auth_method": client.auth_method,
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "scope": oauth.SCOPE,
            }
            if registered.secret is not None:
                answer["client_secret"] = registered.secret
                answer["client_secret_expires_at"] = 0
    except OAuthError as error:
        logger.warning("oauth.register_refused error=%s", error.error)
        return _error(error)
    logger.info("oauth.client_registered name=%r", client.client_name)
    return JSONResponse(answer, status_code=201, headers=NO_STORE)


# --- authorization -----------------------------------------------------------------------------


@router.get("/oauth/authorize")
def authorize(request: Request) -> RedirectResponse:
    """Check the request, then send the person to « Autoriser … ? » (their VIPER session there)."""
    params = dict(request.query_params)
    try:
        with unit_of_work(request.app.state.session_factory) as session:
            pending = oauth.start_authorization(session, params)
            request_id = pending.id
    except RedirectError as error:
        logger.warning("oauth.authorize_refused error=%s (sent back)", error.error)
        return RedirectResponse(error.location, status_code=302)
    except OAuthError as error:
        # Unknown client or redirect: the redirect is not trusted, the person sees why on VIPER.
        logger.warning("oauth.authorize_refused error=%s", error.error)
        return RedirectResponse(
            f"{CONSENT_PAGE}?erreur={quote(error.description)}", status_code=302
        )
    return RedirectResponse(f"{CONSENT_PAGE}?demande={request_id}", status_code=302)


# --- tokens ------------------------------------------------------------------------------------


def _basic_credentials(request: Request) -> tuple[str | None, str | None]:
    scheme, _, value = (request.headers.get("authorization") or "").partition(" ")
    if scheme.lower() != "basic" or not value:
        return None, None
    try:
        decoded = base64.b64decode(value.strip()).decode()
    except binascii.Error, UnicodeDecodeError:
        return None, None
    client_id, _, secret = decoded.partition(":")
    return unquote(client_id) or None, unquote(secret) or None


@router.post("/oauth/token")
async def token(request: Request) -> JSONResponse:
    form = await request.form()
    fields = {key: value for key, value in form.items() if isinstance(value, str)}
    basic_id, basic_secret = _basic_credentials(request)
    client_id = basic_id or fields.get("client_id")
    secret = basic_secret or fields.get("client_secret")
    grant_type = fields.get("grant_type")
    replay: ReplayError | None = None
    try:
        with unit_of_work(request.app.state.session_factory) as session:
            client = oauth.authenticate_client(session, client_id, secret)
            try:
                if grant_type == "authorization_code":
                    pair = oauth.exchange_code(
                        session,
                        client,
                        fields.get("code"),
                        fields.get("redirect_uri"),
                        fields.get("code_verifier"),
                    )
                elif grant_type == "refresh_token":
                    pair = oauth.refresh(session, client, fields.get("refresh_token"))
                else:
                    raise OAuthError(
                        "unsupported_grant_type", "authorization_code or refresh_token."
                    )
            except ReplayError as error:
                # Leave the block normally: the revocation it made is committed.
                replay = error
    except OAuthError as error:
        logger.warning("oauth.token_refused grant=%s error=%s", grant_type, error.error)
        return _error(error)
    if replay is not None:
        logger.warning("oauth.token_replayed grant=%s: the grant's tokens are revoked", grant_type)
        return _error(replay)
    logger.info("oauth.token_issued grant=%s", grant_type)
    return JSONResponse(
        {
            "access_token": pair.access_token,
            "token_type": "Bearer",
            "expires_in": pair.expires_in,
            "refresh_token": pair.refresh_token,
            "scope": oauth.SCOPE,
        },
        headers=NO_STORE,
    )
