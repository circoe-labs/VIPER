"""OAuth for MCP connectors (ChatGPT, claude.ai…): discovery, registration, the person's approval,
PKCE, tokens on `/mcp`, refresh rotation, replay and revocation.

The chain under test is the connector's: it finds the authorization server from `/mcp`'s 401,
registers, sends the person to « Autoriser … ? », trades the code and calls a tool.
"""

import base64
import hashlib
import secrets
from typing import Any
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from tests.builders import add_company

REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect"


def pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = (
        base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    )
    return verifier, challenge


def register(anonymous: TestClient, **extra: Any) -> dict[str, Any]:
    response = anonymous.post(
        "/oauth/register",
        json={"client_name": "ChatGPT", "redirect_uris": [REDIRECT], **extra},
    )
    assert response.status_code == 201, response.text
    body: dict[str, Any] = response.json()
    return body


def authorize(anonymous: TestClient, client_id: str, challenge: str, **extra: str) -> str:
    """The pending request id the consent page receives."""
    response = anonymous.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": REDIRECT,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
            "state": "etat-123",
            "scope": "viper",
            **extra,
        },
        follow_redirects=False,
    )
    assert response.status_code == 302, response.text
    location = response.headers["location"]
    assert location.startswith("/autoriser?demande="), location
    return location.split("=", 1)[1]


def approve(client: TestClient, request_id: str) -> str:
    response = client.post(f"/api/oauth/requests/{request_id}/approve")
    assert response.status_code == 200, response.text
    redirect = urlsplit(response.json()["redirect"])
    assert f"{redirect.scheme}://{redirect.netloc}{redirect.path}" == REDIRECT
    query = parse_qs(redirect.query)
    assert query["state"] == ["etat-123"]
    return query["code"][0]


def token(anonymous: TestClient, **fields: str) -> Any:
    return anonymous.post("/oauth/token", data=fields)


def connect(anonymous: TestClient, client: TestClient) -> tuple[dict[str, Any], dict[str, Any]]:
    """The whole flow: (registered client, token answer)."""
    registered = register(anonymous)
    verifier, challenge = pkce()
    code = approve(client, authorize(anonymous, registered["client_id"], challenge))
    answer = token(
        anonymous,
        grant_type="authorization_code",
        code=code,
        redirect_uri=REDIRECT,
        code_verifier=verifier,
        client_id=registered["client_id"],
    )
    assert answer.status_code == 200, answer.text
    assert answer.headers["cache-control"] == "no-store"
    return registered, answer.json()


def mcp(anonymous: TestClient, access_token: str, method: str = "tools/list") -> Any:
    return anonymous.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": {}},
        headers={"Authorization": f"Bearer {access_token}"},
    )


def test_the_connector_discovers_the_authorization_server_from_mcp(
    anonymous_client: TestClient,
) -> None:
    refused = anonymous_client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert refused.status_code == 401
    challenge = refused.headers["www-authenticate"]
    assert challenge.startswith('Bearer resource_metadata="')
    metadata_url = challenge.split('"')[1]
    resource = anonymous_client.get(urlsplit(metadata_url).path).json()
    assert resource["resource"].endswith("/mcp")
    server = resource["authorization_servers"][0]
    assert server == metadata_url.split("/.well-known")[0]
    meta = anonymous_client.get("/.well-known/oauth-authorization-server").json()
    assert meta["issuer"] == server
    assert meta["code_challenge_methods_supported"] == ["S256"]
    assert meta["registration_endpoint"] == f"{server}/oauth/register"
    assert anonymous_client.get("/.well-known/oauth-protected-resource/mcp").status_code == 200


def test_a_connector_registers_authorizes_and_calls_a_tool(
    anonymous_client: TestClient, client: TestClient, db_session: Session
) -> None:
    add_company(db_session, display_name="2SN")
    registered, answer = connect(anonymous_client, client)

    assert answer["token_type"] == "Bearer"
    assert answer["expires_in"] == 3600
    tools = mcp(anonymous_client, answer["access_token"])
    assert tools.status_code == 200, tools.text
    assert len(tools.json()["result"]["tools"]) >= 6
    # The connector is an ordinary agent, listed (never its token) and revocable.
    agents = client.get("/api/settings/mcp/agents").json()
    assert [(agent["label"], agent["origin"]) for agent in agents] == [("ChatGPT (OAuth)", "oauth")]
    assert agents[0]["last_used_at"] is not None
    # The connector acts for the person who approved it: its calls are kept under that e-mail.
    assert agents[0]["owner_email"] == "pilote.test@circoe.com"
    assert answer["access_token"] not in str(agents)
    assert "client_secret" not in registered


def test_the_consent_page_reads_the_request_and_a_denial_goes_back(
    anonymous_client: TestClient, client: TestClient
) -> None:
    registered = register(anonymous_client)
    _, challenge = pkce()
    request_id = authorize(anonymous_client, registered["client_id"], challenge)

    shown = client.get(f"/api/oauth/requests/{request_id}").json()
    assert (shown["client_name"], shown["redirect_host"]) == ("ChatGPT", "chatgpt.com")
    # Approving needs a VIPER session.
    assert anonymous_client.post(f"/api/oauth/requests/{request_id}/approve").status_code == 401
    denied = client.post(f"/api/oauth/requests/{request_id}/deny").json()["redirect"]
    assert parse_qs(urlsplit(denied).query)["error"] == ["access_denied"]
    # A decided request cannot be approved afterwards.
    assert client.post(f"/api/oauth/requests/{request_id}/approve").status_code == 404


def test_pkce_the_redirect_and_the_code_are_checked(
    anonymous_client: TestClient, client: TestClient
) -> None:
    registered = register(anonymous_client)
    verifier, challenge = pkce()
    code = approve(client, authorize(anonymous_client, registered["client_id"], challenge))
    base = {"grant_type": "authorization_code", "code": code, "client_id": registered["client_id"]}

    wrong_verifier = token(anonymous_client, **base, code_verifier=pkce()[0])
    assert (wrong_verifier.status_code, wrong_verifier.json()["error"]) == (400, "invalid_grant")
    wrong_redirect = token(
        anonymous_client, **base, code_verifier=verifier, redirect_uri="https://evil.example/cb"
    )
    assert wrong_redirect.json()["error"] == "invalid_grant"
    first = token(anonymous_client, **base, code_verifier=verifier)
    assert first.status_code == 200
    # A replayed code fails and revokes what it gave.
    replay = token(anonymous_client, **base, code_verifier=verifier)
    assert replay.json()["error"] == "invalid_grant"
    assert mcp(anonymous_client, first.json()["access_token"]).status_code == 401


def test_authorize_refuses_an_unknown_redirect_without_following_it(
    anonymous_client: TestClient,
) -> None:
    registered = register(anonymous_client)
    _, challenge = pkce()
    response = anonymous_client.get(
        "/oauth/authorize",
        params={
            "response_type": "code",
            "client_id": registered["client_id"],
            "redirect_uri": "https://evil.example/cb",
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        },
        follow_redirects=False,
    )
    assert response.headers["location"].startswith("/autoriser?erreur=")
    # No PKCE: the error goes back to the (registered) client.
    plain = anonymous_client.get(
        "/oauth/authorize",
        params={"response_type": "code", "client_id": registered["client_id"], "state": "s"},
        follow_redirects=False,
    )
    query = parse_qs(urlsplit(plain.headers["location"]).query)
    assert (query["error"], query["state"]) == (["invalid_request"], ["s"])


def test_refresh_rotates_and_a_reused_refresh_token_ends_the_grant(
    anonymous_client: TestClient, client: TestClient
) -> None:
    registered, answer = connect(anonymous_client, client)
    base = {"grant_type": "refresh_token", "client_id": registered["client_id"]}

    renewed = token(anonymous_client, **base, refresh_token=answer["refresh_token"])
    assert renewed.status_code == 200, renewed.text
    fresh = renewed.json()
    assert fresh["refresh_token"] != answer["refresh_token"]
    assert mcp(anonymous_client, fresh["access_token"]).status_code == 200

    reused = token(anonymous_client, **base, refresh_token=answer["refresh_token"])
    assert reused.json()["error"] == "invalid_grant"
    assert mcp(anonymous_client, fresh["access_token"]).status_code == 401
    assert token(anonymous_client, **base, refresh_token=fresh["refresh_token"]).status_code == 400


def test_revoking_the_agent_stops_its_oauth_tokens(
    anonymous_client: TestClient, client: TestClient
) -> None:
    registered, answer = connect(anonymous_client, client)
    agent = client.get("/api/settings/mcp/agents").json()[0]

    revoked = client.post(f"/api/settings/mcp/agents/{agent['id']}/revoke")

    assert revoked.status_code == 200
    assert revoked.json()["revoked_at"] is not None
    assert mcp(anonymous_client, answer["access_token"]).status_code == 401
    refused = token(
        anonymous_client,
        grant_type="refresh_token",
        client_id=registered["client_id"],
        refresh_token=answer["refresh_token"],
    )
    assert refused.json()["error"] == "invalid_grant"


def test_a_confidential_client_must_send_its_secret(
    anonymous_client: TestClient, client: TestClient
) -> None:
    registered = register(anonymous_client, token_endpoint_auth_method="client_secret_basic")
    assert registered["client_secret"]
    verifier, challenge = pkce()
    code = approve(client, authorize(anonymous_client, registered["client_id"], challenge))
    fields = {"grant_type": "authorization_code", "code": code, "code_verifier": verifier}

    without = token(anonymous_client, **fields, client_id=registered["client_id"])
    assert (without.status_code, without.json()["error"]) == (401, "invalid_client")
    basic = base64.b64encode(
        f"{registered['client_id']}:{registered['client_secret']}".encode()
    ).decode()
    accepted = anonymous_client.post(
        "/oauth/token", data=fields, headers={"Authorization": f"Basic {basic}"}
    )
    assert accepted.status_code == 200, accepted.text


def test_registration_refuses_unsafe_redirects(anonymous_client: TestClient) -> None:
    for uris in ([], ["http://chatgpt.com/cb"], ["https://x.example/cb#frag"], "https://x"):
        response = anonymous_client.post("/oauth/register", json={"redirect_uris": uris})
        assert response.status_code == 400, uris
        assert response.json()["error"] == "invalid_redirect_uri"
    local = anonymous_client.post(
        "/oauth/register", json={"redirect_uris": ["http://localhost:6274/oauth/callback"]}
    )
    assert local.status_code == 201
    assert local.json()["client_name"] == "localhost"
