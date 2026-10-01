"""CIRCOE Toolbox MCP client (S6, handoff Task 15): the mail tools VIPER uses, behind `MailToolbox`.

Port of the reference `src/server/toolboxMcpClient.ts`. JSON-RPC 2.0 over Streamable HTTP
(`httpx2`, JSON or SSE answers). The Toolbox server is stateless: every operation runs
`initialize` → `notifications/initialized` → `tools/call` (also correct against a server that
returns an `mcp-session-id`). One total deadline per operation (`VIPER_TOOLBOX_TIMEOUT_MS`), each
HTTP request bounded by what is left of it.

Tool contract checked in `circoe-labs/circoe-toolbox` (commit 60ad176, 2026-09-29,
`references/toolbox-capabilities.md`):

- `infomaniak.mail.create_draft` {to: email[1..50], cc?, bcc?: email[≤50], subject: 1..500,
  text: 1..200000} → {draftId, …}; never sends; **no `from`**: the sender is the default mailbox
  of the Infomaniak API token behind the Toolbox connection (VIPER's `from_email` is not sent);
- `infomaniak.mail.send_draft` {draftId} → {sent: true, draftId, provider: {transport, etop,
  cancelResource}}; no Message-ID; only the Toolbox allowlist applies (S7 calls it);
- `infomaniak.mail.delete_draft` {draftId} → {deleted: true}; a missing draft is an HTTP 404
  error from Infomaniak, reported here as `deleted=False` (idempotent);
- `infomaniak.mail.list_drafts` {limit 1..100} → {folder, drafts: [{draftId, subject, date, …}]}
  (S7's reconciliation);
- a tool failure is `result.isError` + a French text (internal codes are not transmitted):
  classified by pattern into a `toolbox_*` code, the text itself is never kept or logged (it may
  quote an address).

A 401 triggers one token refresh attempt (`ToolboxAuth.refresh_after_unauthorized`), else
`toolbox_auth_expired` (the token is marked to reconnect). Only identifiers, codes, durations and
upstream statuses are logged.
"""

import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Protocol

import httpx2

from app.services.errors import ToolboxError
from app.services.toolbox.errors import toolbox_error

logger = logging.getLogger(__name__)

TOOLS = {
    "create_draft": "infomaniak.mail.create_draft",
    "send_draft": "infomaniak.mail.send_draft",
    "delete_draft": "infomaniak.mail.delete_draft",
    "list_drafts": "infomaniak.mail.list_drafts",
}
PROTOCOL_VERSION = "2025-06-18"
CLIENT_INFO = {"name": "VIPER", "version": "1.0.0"}
MAX_ADDRESSES = 50
SUBJECT_MAX_LENGTH = 500
TEXT_MAX_LENGTH = 200_000
DRAFT_ID_MAX_LENGTH = 200
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class TokenProvider(Protocol):
    """Source of the bearer token (`oauth.ToolboxAuth`)."""

    def access_token(self) -> str | None: ...

    def refresh_after_unauthorized(self, rejected: str) -> str | None: ...


@dataclass(frozen=True, slots=True)
class DraftInput:
    to: list[str]
    subject: str
    text: str
    cc: list[str] = field(default_factory=list)
    bcc: list[str] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class DraftSummary:
    draft_id: str
    subject: str
    date: str | None


@dataclass(frozen=True, slots=True)
class SendResult:
    draft_id: str
    transport: str | None
    cancel_resource: str | None


class MailToolbox(Protocol):
    """The mail operations VIPER needs. Tests inject a fake or the MCP client over a fake
    transport."""

    def create_draft(self, draft: DraftInput) -> str: ...

    def send_draft(self, draft_id: str) -> SendResult: ...

    def delete_draft(self, draft_id: str) -> bool: ...

    def list_drafts(self, limit: int = 100) -> list[DraftSummary]: ...


def classify_tool_error(text: str) -> str:
    """The `toolbox_*` code of a Toolbox tool error text (French); the text is never kept."""
    patterns = (
        (r"INFOMANIAK_SEND_ALLOWLIST|liste d'envoi autoris|TOOLBOX_OUTBOUND_BLOCKED", "outbound"),
        (r"Brouillon introuvable|MAIL_DRAFT_NOT_FOUND|a répondu 404", "draft_not_found"),
        (r"Aucune connexion Infomaniak|a répondu 40[13]|token API personnel", "auth_expired"),
        (r"a répondu (5\d\d|429)|ETIMEDOUT|ECONNRESET|fetch failed", "unavailable"),
        (r"Paramètres invalides|TOOL_INPUT_INVALID", "invalid_input"),
    )
    codes = {
        "outbound": "toolbox_outbound_blocked",
        "draft_not_found": "toolbox_draft_not_found",
        "auth_expired": "toolbox_auth_expired",
        "unavailable": "toolbox_unavailable",
        "invalid_input": "toolbox_invalid_input",
    }
    for pattern, name in patterns:
        if re.search(pattern, text, re.IGNORECASE):
            return codes[name]
    return "toolbox_rejected"


def _rpc_message(text: str, content_type: str, request_id: int) -> dict[str, Any] | None:
    """The JSON-RPC answer carrying `request_id`, from a JSON body or an SSE stream."""
    if "text/event-stream" not in content_type:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return next(
                (m for m in parsed if isinstance(m, dict) and m.get("id") == request_id), None
            )
        return parsed if isinstance(parsed, dict) else None
    for block in re.split(r"\r?\n\r?\n", text):
        data = "\n".join(
            line[5:].lstrip() for line in block.splitlines() if line.startswith("data:")
        )
        if not data:
            continue
        message = json.loads(data)
        if isinstance(message, dict) and message.get("id") == request_id:
            return message
    return None


def _addresses(name: str, values: list[str], *, required: bool) -> list[str]:
    cleaned = [value.strip() for value in values if value.strip()]
    if (required and not cleaned) or len(cleaned) > MAX_ADDRESSES:
        raise toolbox_error("toolbox_invalid_input", f"Draft refused before the Toolbox ({name}).")
    if any(not _EMAIL.match(value) for value in cleaned):
        raise toolbox_error("toolbox_invalid_input", f"Draft refused before the Toolbox ({name}).")
    return cleaned


def _draft_id(value: str) -> str:
    value = value.strip()
    if not value or len(value) > DRAFT_ID_MAX_LENGTH:
        raise toolbox_error("toolbox_invalid_input", "Invalid remote draft id.")
    return value


class _Session:
    def __init__(self, token: str) -> None:
        self.token = token
        self.session_id: str | None = None
        self.protocol_version = PROTOCOL_VERSION


class McpMailToolbox:
    """`MailToolbox` over the Toolbox MCP endpoint."""

    def __init__(
        self,
        *,
        mcp_url: str,
        tokens: TokenProvider,
        timeout_seconds: float,
        transport: httpx2.BaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._url = mcp_url
        self._tokens = tokens
        self._timeout = timeout_seconds
        self._transport = transport
        self._clock = clock
        self._next_id = 1

    # --- transport ---

    def _post(
        self,
        client: httpx2.Client,
        session: _Session,
        body: dict[str, Any],
        deadline: float,
        sensitive: bool,
    ) -> httpx2.Response:
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise self._timeout_error(sensitive)
        headers = {
            "Authorization": f"Bearer {session.token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "MCP-Protocol-Version": session.protocol_version,
        }
        if session.session_id:
            headers["Mcp-Session-Id"] = session.session_id
        try:
            return client.post(self._url, json=body, headers=headers, timeout=remaining)
        except httpx2.TimeoutException:
            raise self._timeout_error(sensitive) from None
        except httpx2.TransportError:
            raise toolbox_error(
                "toolbox_unavailable", "The Toolbox cannot be reached.", outcome_unknown=sensitive
            ) from None

    def _timeout_error(self, sensitive: bool) -> ToolboxError:
        return toolbox_error(
            "toolbox_timeout",
            f"The Toolbox did not answer within {round(self._timeout)} s.",
            outcome_unknown=sensitive,
        )

    @staticmethod
    def _check_status(response: httpx2.Response, sensitive: bool) -> None:
        status = response.status_code
        if status in (401, 403):
            raise toolbox_error(
                "toolbox_auth_expired",
                "The Toolbox connection expired or was refused: reconnect it.",
                upstream_status=status,
            )
        if status >= 500 or status in (408, 429):
            raise toolbox_error(
                "toolbox_unavailable",
                "The Toolbox is unavailable.",
                upstream_status=status,
                outcome_unknown=sensitive and status >= 500,
            )
        if not 200 <= status < 300:
            raise toolbox_error(
                "toolbox_rejected", "The Toolbox refused the request.", upstream_status=status
            )

    def _rpc(
        self,
        client: httpx2.Client,
        session: _Session,
        method: str,
        params: dict[str, Any],
        deadline: float,
        sensitive: bool = False,
    ) -> tuple[object, str | None]:
        request_id = self._next_id
        self._next_id += 1
        body = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
        response = self._post(client, session, body, deadline, sensitive)
        self._check_status(response, sensitive)
        try:
            message = _rpc_message(
                response.text, response.headers.get("content-type", ""), request_id
            )
        except ValueError:
            message = None
        if message is None:
            raise toolbox_error(
                "toolbox_invalid_response",
                "The Toolbox answer is unreadable.",
                upstream_status=response.status_code,
                outcome_unknown=sensitive,
            )
        error = message.get("error")
        if isinstance(error, dict):
            unknown_tool = "not found" in str(error.get("message", "")).lower()
            raise toolbox_error(
                "toolbox_rejected" if unknown_tool else "toolbox_invalid_response",
                f"MCP error {error.get('code', '')}".strip(),
                upstream_status=response.status_code,
            )
        return message.get("result"), response.headers.get("mcp-session-id")

    def _call_once(
        self,
        client: httpx2.Client,
        token: str,
        tool: str,
        arguments: dict[str, Any],
        deadline: float,
        sensitive: bool,
    ) -> object:
        session = _Session(token)
        result, session_id = self._rpc(
            client,
            session,
            "initialize",
            {"protocolVersion": PROTOCOL_VERSION, "capabilities": {}, "clientInfo": CLIENT_INFO},
            deadline,
        )
        version = result.get("protocolVersion") if isinstance(result, dict) else None
        if isinstance(version, str):
            session.protocol_version = version
        session.session_id = session_id
        notified = self._post(
            client,
            session,
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
            deadline,
            False,
        )
        if notified.status_code in (401, 403):
            self._check_status(notified, False)
        call, _ = self._rpc(
            client,
            session,
            "tools/call",
            {"name": tool, "arguments": arguments},
            deadline,
            sensitive,
        )
        return call

    def _call(
        self, tool: str, arguments: dict[str, Any], *, sensitive: bool = False
    ) -> dict[str, Any]:
        token = self._tokens.access_token()
        if token is None:
            raise toolbox_error(
                "toolbox_not_connected",
                "The Toolbox is not connected: connect it from Settings > Connexions.",
            )
        started = self._clock()
        deadline = started + self._timeout
        with httpx2.Client(transport=self._transport, trust_env=False) as client:
            try:
                raw = self._call_once(client, token, tool, arguments, deadline, sensitive)
            except ToolboxError as error:
                if error.code != "toolbox_auth_expired" or error.upstream_status is None:
                    raise
                refreshed = self._tokens.refresh_after_unauthorized(token)
                if refreshed is None:
                    raise
                raw = self._call_once(client, refreshed, tool, arguments, deadline, sensitive)
        logger.info(
            "toolbox.call tool=%s duration_ms=%s", tool, round((self._clock() - started) * 1000)
        )
        return self._tool_result(raw, sensitive)

    @staticmethod
    def _tool_result(raw: object, sensitive: bool) -> dict[str, Any]:
        if not isinstance(raw, dict):
            raise toolbox_error(
                "toolbox_invalid_response", "The Toolbox tool result is unreadable."
            )
        content = raw.get("content")
        parts = content if isinstance(content, list) else []
        text = "\n".join(str(part.get("text", "")) for part in parts if isinstance(part, dict))
        if raw.get("isError"):
            code = classify_tool_error(text)
            raise toolbox_error(
                code,
                f"The Toolbox refused the operation ({code}).",
                outcome_unknown=sensitive and code == "toolbox_unavailable",
            )
        structured = raw.get("structuredContent")
        if isinstance(structured, dict):
            return structured
        try:
            value = json.loads(text)
        except ValueError:
            value = None
        if isinstance(value, dict):
            return value
        raise toolbox_error("toolbox_invalid_response", "The Toolbox tool result is not JSON.")

    # --- the tools ---

    def create_draft(self, draft: DraftInput) -> str:
        subject, text = draft.subject.strip(), draft.text
        if not subject or len(subject) > SUBJECT_MAX_LENGTH:
            raise toolbox_error(
                "toolbox_invalid_input", "Draft refused before the Toolbox (subject)."
            )
        if not text.strip() or len(text) > TEXT_MAX_LENGTH:
            raise toolbox_error("toolbox_invalid_input", "Draft refused before sending (text).")
        arguments: dict[str, Any] = {
            "to": _addresses("to", draft.to, required=True),
            "subject": subject,
            "text": text,
        }
        for name, values in (("cc", draft.cc), ("bcc", draft.bcc)):
            cleaned = _addresses(name, values, required=False)
            if cleaned:
                arguments[name] = cleaned
        result = self._call(TOOLS["create_draft"], arguments)
        draft_id = result.get("draftId")
        if not isinstance(draft_id, str | int) or not str(draft_id).strip():
            raise toolbox_error("toolbox_invalid_response", "The Toolbox returned no draft id.")
        return str(draft_id)

    def send_draft(self, draft_id: str) -> SendResult:
        result = self._call(TOOLS["send_draft"], {"draftId": _draft_id(draft_id)}, sensitive=True)
        if result.get("sent") is not True:
            raise toolbox_error(
                "toolbox_invalid_response",
                "The Toolbox did not confirm the send.",
                outcome_unknown=True,
            )
        provider = result.get("provider")
        provider = provider if isinstance(provider, dict) else {}
        transport, cancel = provider.get("transport"), provider.get("cancelResource")
        answered = result.get("draftId")
        return SendResult(
            draft_id=str(answered) if answered else draft_id,
            transport=transport if isinstance(transport, str) else None,
            cancel_resource=cancel if isinstance(cancel, str) else None,
        )

    def delete_draft(self, draft_id: str) -> bool:
        """True when deleted, False when the draft was already gone (idempotent)."""
        try:
            result = self._call(TOOLS["delete_draft"], {"draftId": _draft_id(draft_id)})
        except ToolboxError as error:
            if error.code == "toolbox_draft_not_found":
                return False
            raise
        deleted = result.get("deleted")
        if not isinstance(deleted, bool):
            raise toolbox_error(
                "toolbox_invalid_response", "The Toolbox delete answer is unreadable."
            )
        return deleted

    def list_drafts(self, limit: int = 100) -> list[DraftSummary]:
        result = self._call(TOOLS["list_drafts"], {"limit": max(1, min(100, limit))})
        drafts = result.get("drafts")
        if not isinstance(drafts, list):
            raise toolbox_error("toolbox_invalid_response", "The Toolbox draft list is unreadable.")
        summaries = []
        for item in drafts:
            if not isinstance(item, dict) or not item.get("draftId"):
                continue
            subject, date = item.get("subject"), item.get("date")
            summaries.append(
                DraftSummary(
                    draft_id=str(item["draftId"]),
                    subject=subject if isinstance(subject, str) else "",
                    date=date if isinstance(date, str) else None,
                )
            )
        return summaries
