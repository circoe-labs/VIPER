"""Stable `toolbox_*` codes of the CIRCOE Toolbox integration (S6) and their HTTP status.

One table for the OAuth connection, the MCP client and the remote-draft operations, so the API,
the message's `last_error_code` and the UI's French copy speak the same codes. Messages are
English and identifier-free; the Toolbox's own error text (French, it may quote an address) is
classified, never kept (`mcp_client.classify_tool_error`).
"""

from http import HTTPStatus

from app.services.errors import ToolboxError

ERROR_STATUS: dict[str, HTTPStatus] = {
    # Configuration and connection.
    "toolbox_not_configured": HTTPStatus.SERVICE_UNAVAILABLE,
    "toolbox_not_connected": HTTPStatus.CONFLICT,
    "toolbox_auth_expired": HTTPStatus.CONFLICT,
    # Transport and the Toolbox's answer.
    "toolbox_unavailable": HTTPStatus.BAD_GATEWAY,
    "toolbox_timeout": HTTPStatus.GATEWAY_TIMEOUT,
    "toolbox_invalid_response": HTTPStatus.BAD_GATEWAY,
    "toolbox_rejected": HTTPStatus.UNPROCESSABLE_CONTENT,
    "toolbox_outbound_blocked": HTTPStatus.UNPROCESSABLE_CONTENT,
    "toolbox_invalid_input": HTTPStatus.UNPROCESSABLE_CONTENT,
    "toolbox_draft_not_found": HTTPStatus.NOT_FOUND,
    # The OAuth return (`POST /api/settings/toolbox/callback`).
    "toolbox_state_invalid": HTTPStatus.BAD_REQUEST,
    "toolbox_access_denied": HTTPStatus.FORBIDDEN,
    "toolbox_authorization_failed": HTTPStatus.BAD_REQUEST,
    "toolbox_issuer_mismatch": HTTPStatus.BAD_REQUEST,
    "toolbox_token_exchange_failed": HTTPStatus.BAD_GATEWAY,
    "toolbox_scope_missing": HTTPStatus.UNPROCESSABLE_CONTENT,
}
# Replaying the same call is safe (the Toolbox refused or never got it).
RETRYABLE = frozenset({"toolbox_unavailable", "toolbox_timeout"})


def toolbox_error(
    code: str,
    message: str,
    *,
    outcome_unknown: bool = False,
    upstream_status: int | None = None,
) -> ToolboxError:
    return ToolboxError(
        code,
        ERROR_STATUS[code],
        message,
        retryable=code in RETRYABLE,
        outcome_unknown=outcome_unknown,
        upstream_status=upstream_status,
    )
