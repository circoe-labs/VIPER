"""A local fake of the CIRCOE Toolbox for the backend tests (Contact port P6: no real call, ever).

Port of the reference `tests/support/fakeToolbox.ts` as an `httpx2.MockTransport` (no socket):
OAuth metadata (RFC 9728/8414), dynamic registration, `/authorize` acting as a person who accepts
everything (`authorize()` returns the redirect's query, as the browser would land on the SPA),
`/token` (PKCE S256, `resource`, optional refresh) and the MCP endpoint (JSON-RPC, JSON or SSE)
with the mail tools — same shapes and same French error texts as `circoe-toolbox` (commit
60ad176). Failure modes on demand (`mode`), token expiry on the fake's own clock, `revoke_all()`.
"""

import base64
import hashlib
import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx2

ORIGIN = "https://toolbox.example.test"
MCP_URL = f"{ORIGIN}/mcp"
SCOPES = ("mail", "calendar", "contacts")


@dataclass
class Draft:
    to: list[str]
    cc: list[str]
    bcc: list[str]
    subject: str
    text: str


@dataclass
class Mode:
    # Every MCP POST answers this HTTP status.
    http_status: int | None = None
    # Every tool call answers `isError` with this text.
    tool_error_text: str | None = None
    # This tool never answers (the client times out).
    hang_tool: str | None = None
    # Network failure on every request.
    unreachable: bool = False
    # The token endpoint refuses the code.
    refuse_token: bool = False
    # This tool runs, then its answer is lost (the client times out after the draft exists).
    lose_answer_of: str | None = None
    # `send_draft` answers this raw tool result (an unrecognised error text, a non-JSON body).
    send_result: dict[str, Any] | None = None


@dataclass
class FakeToolbox:
    refresh: bool = False
    token_ttl: timedelta = timedelta(days=30)
    sse: bool = False
    allowlist: list[str] | None = None
    now: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    drafts: dict[str, Draft] = field(default_factory=dict)
    sent: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    calls: list[tuple[str, str | None]] = field(default_factory=list)
    registrations: list[dict[str, Any]] = field(default_factory=list)
    token_requests: list[str] = field(default_factory=list)
    mode: Mode = field(default_factory=Mode)
    # Announced token endpoint (a test may make it unsafe).
    token_endpoint: str = f"{ORIGIN}/token"
    _seq: int = 0
    _clients: dict[str, list[str]] = field(default_factory=dict)
    _codes: dict[str, dict[str, str]] = field(default_factory=dict)
    _tokens: dict[str, datetime] = field(default_factory=dict)
    _refresh_tokens: dict[str, str] = field(default_factory=dict)

    @property
    def transport(self) -> httpx2.MockTransport:
        return httpx2.MockTransport(self.handle)

    def revoke_all(self) -> None:
        """Invalidate every issued token (archived member, Toolbox secret rotated…)."""
        self._tokens.clear()

    def _next(self, prefix: str) -> str:
        self._seq += 1
        return f"{prefix}-{self._seq}"

    # --- the browser's part -----------------------------------------------------------------

    def authorize(self, url: str) -> dict[str, str]:
        """Follow `/authorize` like a browser of a person who accepts: the redirect's query."""
        response = self.handle(httpx2.Request("GET", url))
        assert response.status_code == 302, response.text
        location = response.headers["location"]
        return {key: values[0] for key, values in parse_qs(urlsplit(location).query).items()}

    # --- HTTP ---------------------------------------------------------------------------------

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        if self.mode.unreachable:
            raise httpx2.ConnectError("fake toolbox unreachable", request=request)
        url = urlsplit(str(request.url))
        path = url.path
        if request.method == "GET" and path == "/.well-known/oauth-protected-resource":
            return httpx2.Response(
                200,
                json={
                    "resource": MCP_URL,
                    "authorization_servers": [ORIGIN],
                    "scopes_supported": list(SCOPES),
                },
            )
        if request.method == "GET" and path == "/.well-known/oauth-authorization-server":
            return httpx2.Response(
                200,
                json={
                    "issuer": ORIGIN,
                    "authorization_endpoint": f"{ORIGIN}/authorize",
                    "token_endpoint": self.token_endpoint,
                    "registration_endpoint": f"{ORIGIN}/register",
                    "response_types_supported": ["code"],
                    "authorization_response_iss_parameter_supported": True,
                    "grant_types_supported": ["authorization_code", "refresh_token"]
                    if self.refresh
                    else ["authorization_code"],
                    "code_challenge_methods_supported": ["S256"],
                    "token_endpoint_auth_methods_supported": ["none"],
                    "scopes_supported": list(SCOPES),
                },
            )
        if request.method == "POST" and path == "/register":
            return self._register(json.loads(request.content))
        if request.method == "GET" and path == "/authorize":
            return self._authorize({k: v[0] for k, v in parse_qs(url.query).items()})
        if request.method == "POST" and path == "/token":
            form = {k: v[0] for k, v in parse_qs(request.content.decode()).items()}
            return self._token(form)
        if request.method == "POST" and path == "/mcp":
            return self._mcp(request)
        return httpx2.Response(404, json={"error": "not_found"})

    def _register(self, body: dict[str, Any]) -> httpx2.Response:
        self.registrations.append(body)
        uris = [str(uri) for uri in body.get("redirect_uris") or []]
        if not uris:
            return httpx2.Response(400, json={"error": "invalid_redirect_uri"})
        client_id = self._next("client")
        self._clients[client_id] = uris
        return httpx2.Response(
            201,
            json={
                "client_id": client_id,
                "redirect_uris": uris,
                "token_endpoint_auth_method": "none",
            },
        )

    def _authorize(self, p: dict[str, str]) -> httpx2.Response:
        client_id, redirect_uri = p.get("client_id", ""), p.get("redirect_uri", "")
        ok = (
            redirect_uri in self._clients.get(client_id, [])
            and p.get("response_type") == "code"
            and p.get("code_challenge")
            and p.get("code_challenge_method") == "S256"
            and p.get("resource") == MCP_URL
            and all(scope in SCOPES for scope in p.get("scope", "mail").split())
        )
        if not ok:
            return httpx2.Response(400, json={"error": "invalid_request"})
        code = self._next("code")
        self._codes[code] = {
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "challenge": p["code_challenge"],
            "resource": p["resource"],
            "scope": p.get("scope", "mail"),
        }
        back = {"code": code, "iss": ORIGIN}
        if p.get("state"):
            back["state"] = p["state"]
        return httpx2.Response(302, headers={"location": f"{redirect_uri}?{urlencode(back)}"})

    def _issue(self, client_id: str, scope: str) -> dict[str, Any]:
        access = self._next("at")
        self._tokens[access] = self.now() + self.token_ttl
        body: dict[str, Any] = {
            "access_token": access,
            "token_type": "Bearer",
            "expires_in": int(self.token_ttl.total_seconds()),
            "scope": scope,
        }
        if self.refresh:
            refresh = self._next("rt")
            self._refresh_tokens[refresh] = client_id
            body["refresh_token"] = refresh
        return body

    def _token(self, form: dict[str, str]) -> httpx2.Response:
        grant = form.get("grant_type", "")
        self.token_requests.append(grant)
        if grant == "authorization_code":
            record = self._codes.pop(form.get("code", ""), None)
            verifier = form.get("code_verifier", "")
            challenge = (
                base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
                .rstrip(b"=")
                .decode()
            )
            if (
                self.mode.refuse_token
                or record is None
                or record["client_id"] != form.get("client_id")
                or record["redirect_uri"] != form.get("redirect_uri")
                or record["resource"] != form.get("resource")
                or record["challenge"] != challenge
            ):
                return httpx2.Response(400, json={"error": "invalid_grant"})
            return httpx2.Response(200, json=self._issue(record["client_id"], record["scope"]))
        if grant == "refresh_token" and self.refresh:
            client_id = self._refresh_tokens.pop(form.get("refresh_token", ""), None)
            if client_id is None or client_id != form.get("client_id"):
                return httpx2.Response(400, json={"error": "invalid_grant"})
            return httpx2.Response(200, json=self._issue(client_id, "mail"))
        return httpx2.Response(400, json={"error": "unsupported_grant_type"})

    # --- MCP ----------------------------------------------------------------------------------

    def _mcp(self, request: httpx2.Request) -> httpx2.Response:
        auth = request.headers.get("authorization", "")
        token = auth.removeprefix("Bearer ") if auth.startswith("Bearer ") else ""
        message = json.loads(request.content)
        params = message.get("params") or {}
        self.calls.append((message["method"], params.get("name")))
        expires = self._tokens.get(token)
        if expires is None or expires <= self.now():
            return httpx2.Response(
                401,
                json={"error": "authentication_required"},
                headers={"www-authenticate": f'Bearer resource_metadata="{ORIGIN}/.well-known"'},
            )
        if self.mode.http_status:
            return httpx2.Response(self.mode.http_status, json={"error": "boom"})
        if "id" not in message:
            return httpx2.Response(202)
        if message["method"] == "initialize":
            result: Any = {
                "protocolVersion": "2025-06-18",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "fake-toolbox", "version": "0"},
            }
        elif message["method"] == "tools/list":
            result = {
                "tools": [
                    {"name": "infomaniak.mail.create_draft", "description": "Crée un brouillon."},
                    {"name": "infomaniak.mail.list_drafts", "title": "Brouillons"},
                ]
            }
        elif message["method"] == "tools/call":
            name = params.get("name", "")
            if self.mode.hang_tool == name:
                raise httpx2.ReadTimeout("fake toolbox hangs", request=request)
            result = self._tool(name, params.get("arguments") or {})
            if self.mode.lose_answer_of == name:
                raise httpx2.ReadTimeout("fake toolbox answer lost", request=request)
            if result is None:
                return self._rpc(
                    message["id"], error={"code": -32602, "message": f"Tool {name} not found"}
                )
        else:
            return self._rpc(message["id"], error={"code": -32601, "message": "Method not found"})
        return self._rpc(message["id"], result=result)

    def _rpc(self, request_id: Any, **body: Any) -> httpx2.Response:
        payload = {"jsonrpc": "2.0", "id": request_id, **body}
        if self.sse:
            return httpx2.Response(
                200,
                content=f"event: message\ndata: {json.dumps(payload)}\n\n".encode(),
                headers={"content-type": "text/event-stream"},
            )
        return httpx2.Response(200, json=payload)

    @staticmethod
    def _error(text: str) -> dict[str, Any]:
        return {"isError": True, "content": [{"type": "text", "text": text}]}

    @staticmethod
    def _ok(value: dict[str, Any]) -> dict[str, Any]:
        return {"content": [{"type": "text", "text": json.dumps(value, indent=2)}]}

    def _tool(self, name: str, args: dict[str, Any]) -> dict[str, Any] | None:
        if self.mode.tool_error_text:
            return self._error(self.mode.tool_error_text)
        if name == "infomaniak.mail.send_draft" and self.mode.send_result is not None:
            return self.mode.send_result
        if name == "infomaniak.mail.create_draft":
            draft = Draft(
                to=list(args["to"]),
                cc=list(args.get("cc") or []),
                bcc=list(args.get("bcc") or []),
                subject=str(args["subject"]),
                text=str(args["text"]),
            )
            if self.allowlist is not None:
                blocked = [
                    a
                    for a in [*draft.to, *draft.cc, *draft.bcc]
                    if not any(
                        a.endswith(rule) if rule.startswith("@") else a == rule
                        for rule in self.allowlist
                    )
                ]
                if blocked:
                    return self._error(
                        "Destinataire(s) refusé(s) par la liste d'envoi autorisée "
                        f"(INFOMANIAK_SEND_ALLOWLIST) : {', '.join(blocked)}."
                    )
            draft_id = self._next("draft")
            self.drafts[draft_id] = draft
            return self._ok(
                {
                    "draftId": draft_id,
                    "draftUid": self._seq,
                    "to": draft.to,
                    "cc": draft.cc,
                    "bcc": draft.bcc,
                    "subject": draft.subject,
                    "inReplyTo": None,
                    "hint": "Brouillon enregistré.",
                }
            )
        if name == "infomaniak.mail.send_draft":
            draft_id = str(args["draftId"])
            found = self.drafts.pop(draft_id, None)
            if found is None:
                return self._error(f"Brouillon introuvable : {draft_id}")
            self.sent.append(draft_id)
            return self._ok(
                {
                    "sent": True,
                    "pendingConfirmation": False,
                    "draftId": draft_id,
                    "to": found.to,
                    "subject": found.subject,
                    "provider": {"transport": "api", "etop": None, "cancelResource": None},
                }
            )
        if name == "infomaniak.mail.delete_draft":
            draft_id = str(args["draftId"])
            if self.drafts.pop(draft_id, None) is None:
                return self._error('L\'API Infomaniak Mail a répondu 404 : {"result":"error"}')
            self.deleted.append(draft_id)
            return self._ok({"deleted": True, "draftId": draft_id})
        if name == "infomaniak.mail.list_drafts":
            limit = int(args.get("limit", 20))
            return self._ok(
                {
                    "folder": "Drafts",
                    "drafts": [
                        {"draftId": key, "subject": d.subject, "to": d.to, "date": None}
                        for key, d in list(self.drafts.items())[:limit]
                    ],
                }
            )
        return None
