"""« Se connecter avec Infomaniak »: OpenID Connect authorization code flow with PKCE.

VIPER is a confidential client (`client_secret_post`). The browser carries the flow's `state` and
PKCE verifier in a short-lived HttpOnly cookie scoped to the callback; the callback refuses a
`state` that does not match it (login CSRF). The identity comes from the userinfo endpoint, called
with the access token over TLS, so no ID-token signature needs checking. Nothing from Infomaniak is
stored but the account's `sub`.

Contract: `doc/architecture/organizations.md` §2.
"""

import base64
import hashlib
import secrets
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx2

from app.core.config import Settings
from app.services.organizations import Identity

SCOPES = "openid email profile"
TIMEOUT_SECONDS = 15.0
# The cookie value: `<state>.<verifier>`, both URL-safe random strings.
STATE_BYTES = 24
VERIFIER_BYTES = 48


class InfomaniakError(Exception):
    """Infomaniak refused the code or did not answer: the person starts again."""


@dataclass(frozen=True, slots=True)
class Start:
    url: str
    # Goes to the flow cookie only.
    cookie: str


def _challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode()).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode()


def start(settings: Settings, redirect_uri: str) -> Start:
    assert settings.infomaniak_client_id is not None
    state = secrets.token_urlsafe(STATE_BYTES)
    verifier = secrets.token_urlsafe(VERIFIER_BYTES)
    query = urlencode(
        {
            "response_type": "code",
            "client_id": settings.infomaniak_client_id,
            "redirect_uri": redirect_uri,
            "scope": SCOPES,
            "state": state,
            "code_challenge": _challenge(verifier),
            "code_challenge_method": "S256",
        }
    )
    return Start(
        url=f"{settings.infomaniak_issuer}/authorize?{query}", cookie=f"{state}.{verifier}"
    )


def verifier_for(cookie: str | None, state: str | None) -> str | None:
    """The PKCE verifier when the callback's `state` is the one this browser started with."""
    if not cookie or not state or "." not in cookie:
        return None
    expected, verifier = cookie.split(".", 1)
    if not secrets.compare_digest(expected.encode(), state.encode()):
        return None
    return verifier


def identify(
    settings: Settings,
    *,
    code: str,
    verifier: str,
    redirect_uri: str,
    transport: httpx2.BaseTransport | None = None,
) -> Identity:
    """Trade the code for an access token, then read who signed in."""
    assert settings.infomaniak_client_id is not None
    assert settings.infomaniak_client_secret is not None
    try:
        with httpx2.Client(timeout=TIMEOUT_SECONDS, transport=transport) as client:
            token = client.post(
                f"{settings.infomaniak_issuer}/token",
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": redirect_uri,
                    "code_verifier": verifier,
                    "client_id": settings.infomaniak_client_id,
                    "client_secret": settings.infomaniak_client_secret.get_secret_value(),
                },
                headers={"Accept": "application/json"},
            )
            if token.status_code != 200:
                raise InfomaniakError(f"token endpoint answered {token.status_code}")
            access_token = token.json().get("access_token")
            if not isinstance(access_token, str) or not access_token:
                raise InfomaniakError("no access token")
            info = client.get(
                f"{settings.infomaniak_issuer}/oauth2/userinfo",
                headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"},
            )
            if info.status_code != 200:
                raise InfomaniakError(f"userinfo answered {info.status_code}")
            claims: dict[str, Any] = info.json()
    except httpx2.HTTPError as error:
        raise InfomaniakError(type(error).__name__) from error
    except ValueError as error:
        raise InfomaniakError("not JSON") from error
    sub, email = claims.get("sub"), claims.get("email")
    if not isinstance(sub, str | int) or not isinstance(email, str) or not email:
        raise InfomaniakError("userinfo without sub or email")
    verified = claims.get("email_verified")
    name = claims.get("name")
    if not isinstance(name, str) or not name.strip():
        given, family = claims.get("given_name"), claims.get("family_name")
        name = " ".join(part for part in (given, family) if isinstance(part, str) and part)
    return Identity(
        sub=str(sub),
        email=email,
        email_verified=verified if isinstance(verified, bool) else None,
        name=name or None,
    )
