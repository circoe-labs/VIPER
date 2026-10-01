"""OpenAI adapter of the Contact drafting (handoff Task 14, docs/07 § OpenAI): server side only.

Port of the reference `src/server/openaiMailGenerator.ts`:

- `POST {VIPER_OPENAI_BASE_URL}/responses` (Responses API) with a strict structured output
  (`text.format` = `json_schema` `{subject, body}`) and `store: false` (the request is not kept by
  OpenAI for later use). API documentation checked by the reference on 2026-09-29
  (developers.openai.com/api/docs/guides/structured-outputs and /guides/text);
- configuration from `Settings` (`VIPER_OPENAI_*`): key and model both required, no model id
  hard-coded (handoff docs/08 §4);
- timeouts per network operation (connect ≤ 10 s; each read / write / pool wait ≤
  `VIPER_OPENAI_TIMEOUT_MS`), not a total per attempt; bounded retries on transient failures
  only (network error, 408/409/429 except an exhausted quota, 5xx) with exponential backoff and a
  capped `Retry-After`; a timeout is not replayed (the person's wait stays bounded);
- typed `MailGenerationError` (stable code + HTTP status); never the key, the prompt or the raw
  answer in an error message or a log line — only the code, the upstream status and the upstream
  error type;
- the output is validated (JSON, schema, bounds, guardrails) before it is returned: the caller
  persists only a valid output.

HTTP client: `httpx2` (the stack's HTTP client, ADR-0001; promoted to a runtime requirement).
Tests inject an `httpx2.MockTransport` or point `base_url` at a local fake: no real call.
"""

import json
import logging
import re
import time
from collections.abc import Callable
from dataclasses import dataclass
from http import HTTPStatus
from typing import Any, Protocol

import httpx2

from app.core.config import Settings
from app.services.errors import MailGenerationError
from app.services.mail_generation.prompt import MailPrompt

logger = logging.getLogger(__name__)

OUTPUT_SCHEMA_NAME = "contact_mail"
# Sent to OpenAI (strict mode: every field required, no additional property).
OUTPUT_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "subject": {
            "type": "string",
            "description": "Objet du mail, une seule ligne, sans préfixe « Objet : ».",
        },
        "body": {
            "type": "string",
            "description": (
                "Corps du mail en texte brut, paragraphes séparés par une ligne vide, sans "
                "signature nominative."
            ),
        },
    },
    "required": ["subject", "body"],
    "additionalProperties": False,
}
SUBJECT_MAX_LENGTH = 200
BODY_MAX_LENGTH = 10_000
MODEL_MAX_LENGTH = 200
RETRYABLE_STATUSES = frozenset({408, 409, 429, 500, 502, 503, 504})
MAX_RETRY_DELAY_SECONDS = 10.0
# At most this long to open the connection, within the attempt's timeout.
CONNECT_TIMEOUT_SECONDS = 10.0


# --- errors ------------------------------------------------------------------------------------

ERROR_STATUS: dict[str, HTTPStatus] = {
    "ai_not_configured": HTTPStatus.SERVICE_UNAVAILABLE,
    "ai_timeout": HTTPStatus.GATEWAY_TIMEOUT,
    "ai_rate_limited": HTTPStatus.TOO_MANY_REQUESTS,
    "ai_auth_failed": HTTPStatus.BAD_GATEWAY,
    "ai_upstream_error": HTTPStatus.BAD_GATEWAY,
    "ai_refused": HTTPStatus.UNPROCESSABLE_CONTENT,
    "ai_invalid_output": HTTPStatus.BAD_GATEWAY,
}


def generation_error(
    code: str, message: str, *, upstream_status: int | None = None, upstream_code: str | None = None
) -> MailGenerationError:
    return MailGenerationError(
        code,
        ERROR_STATUS[code],
        message,
        upstream_status=upstream_status,
        upstream_code=upstream_code,
    )


def not_configured(missing: list[str]) -> MailGenerationError:
    names = ", ".join(missing) or "VIPER_OPENAI_API_KEY, VIPER_OPENAI_MODEL"
    return generation_error(
        "ai_not_configured", f"AI drafting is not configured on the server (missing: {names})."
    )


# --- configuration -----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class OpenAIConfig:
    # Never logged, never in an error message, never returned.
    api_key: str
    model: str
    base_url: str
    timeout_seconds: float
    max_retries: int
    # Read HTTPS_PROXY, NO_PROXY, SSL_CERT_FILE… from the environment (off by default).
    trust_env: bool = False

    def __repr__(self) -> str:
        return (
            f"OpenAIConfig(model={self.model!r}, base_url={self.base_url!r}, "
            f"timeout_seconds={self.timeout_seconds}, max_retries={self.max_retries}, "
            f"trust_env={self.trust_env})"
        )


def missing_settings(settings: Settings) -> list[str]:
    """The names (never the values) of the unset settings the drafting needs."""
    missing = []
    if settings.openai_api_key is None:
        missing.append("VIPER_OPENAI_API_KEY")
    if settings.openai_model is None:
        missing.append("VIPER_OPENAI_MODEL")
    return missing


def config_from_settings(settings: Settings) -> OpenAIConfig | None:
    """None when the key or the model is missing (`ai_not_configured`)."""
    if settings.openai_api_key is None or settings.openai_model is None:
        return None
    return OpenAIConfig(
        api_key=settings.openai_api_key.get_secret_value(),
        model=settings.openai_model,
        base_url=settings.openai_base_url,
        timeout_seconds=settings.openai_timeout_ms / 1000,
        max_retries=settings.openai_max_retries,
        trust_env=settings.openai_trust_env,
    )


# --- the port ----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class GeneratedMail:
    subject: str
    body: str
    # The model that answered (the snapshot OpenAI names), else the configured one.
    model: str


class MailGenerator(Protocol):
    def generate(self, prompt: MailPrompt) -> GeneratedMail: ...


# --- output validation -------------------------------------------------------------------------

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
# A body keeps its line breaks and tabs; other control characters are refused.
_BODY_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
# « [Prénom] », « {entreprise} », « <nom> », « XXX »: a field left to complete (the prompt forbids
# them). Short bracketed texts only, so a sentence in parentheses is never caught.
_PLACEHOLDER = re.compile(r"\[[^\]\n]{1,60}\]|\{[^}\n]{0,60}\}|<[^>\n]{1,40}>|\bX{3,}\b")
# A link ends at a space, a bracket, a quote or a French guillemet (« https://… » or «https://…»).
_URL = re.compile(r"(?:https?://|www\.)[^\s<>()\"'«»]+", re.IGNORECASE)
# An e-mail address: VIPER never sends one to the model, so one in the answer is invented.
_EMAIL = re.compile(r"[^\s@<>()\"'«»,;:]+@[^\s@<>()\"'«»,;:]+\.[^\s@<>()\"'«»,;:.]{2,}")


def _invalid(message: str) -> MailGenerationError:
    return generation_error("ai_invalid_output", message)


def validate_output(text: str, *, booking_url: str | None) -> tuple[str, str]:
    """The `{subject, body}` answer, checked independently of OpenAI's strict mode.

    Guardrails beyond the reference's schema check (an output breaking them is refused, never
    repaired): no field left to complete, no link but the configured booking link, and no e-mail
    address (VIPER sends none to the model: a link or an address would be a fact it does not hold).
    """
    try:
        data = json.loads(text)
    except ValueError:
        raise _invalid("The AI answer is not valid JSON: nothing was saved.") from None
    if not isinstance(data, dict) or set(data) != {"subject", "body"}:
        raise _invalid("The AI answer does not have the expected subject/body shape.")
    subject, body = data["subject"], data["body"]
    if not isinstance(subject, str) or not isinstance(body, str):
        raise _invalid("The AI answer does not have the expected subject/body shape.")
    subject, body = subject.strip(), body.replace("\r\n", "\n").strip()
    if not subject or len(subject) > SUBJECT_MAX_LENGTH or _CONTROL.search(subject):
        raise _invalid("The AI subject is empty, too long or spans several lines.")
    if not body or len(body) > BODY_MAX_LENGTH or _BODY_CONTROL.search(body):
        raise _invalid("The AI body is empty, too long or holds control characters.")
    if _PLACEHOLDER.search(subject) or _PLACEHOLDER.search(body):
        raise _invalid("The AI text holds a field left to complete.")
    allowed = (booking_url or "").rstrip("/.")
    text = f"{subject}\n{body}"
    for match in _URL.finditer(text):
        if not allowed or match.group(0).rstrip("/.,;:!?") != allowed:
            raise _invalid("The AI text holds a link that was not provided.")
    # The booking link may hold an `@` (a path segment): addresses are looked for outside links.
    if _EMAIL.search(_URL.sub(" ", text)):
        raise _invalid("The AI text holds an e-mail address.")
    return subject, body


def extract_output_text(payload: object) -> str:
    """The output text of a `/responses` answer; a refusal and an incomplete answer are typed."""
    if not isinstance(payload, dict):
        raise _invalid("The AI service answer is unreadable: nothing was saved.")
    output = payload.get("output")
    items = output if isinstance(output, list) else []
    contents = [
        content
        for item in items
        if isinstance(item, dict) and item.get("type") == "message"
        for content in (item.get("content") or [])
        if isinstance(content, dict)
    ]
    if any(content.get("type") == "refusal" for content in contents):
        raise generation_error("ai_refused", "The AI declined to write this message.")
    status = payload.get("status")
    if status and status != "completed":
        details = payload.get("incomplete_details")
        reason = details.get("reason") if isinstance(details, dict) else None
        raise generation_error(
            "ai_invalid_output",
            "The AI answer is incomplete: nothing was saved.",
            upstream_code=str(reason or status)[:80],
        )
    text = "".join(
        content["text"]
        for content in contents
        if content.get("type") == "output_text" and isinstance(content.get("text"), str)
    )
    if not text.strip():
        raise _invalid("The AI answer is empty: nothing was saved.")
    return text


# --- the adapter -------------------------------------------------------------------------------


def _retry_delay(attempt: int, retry_after: str | None) -> float:
    if retry_after:
        try:
            seconds = float(retry_after)
        except ValueError:
            seconds = -1.0  # not a number of seconds (an HTTP date): the backoff applies
        if seconds >= 0:
            return min(MAX_RETRY_DELAY_SECONDS, seconds)
    return min(MAX_RETRY_DELAY_SECONDS, 0.5 * 2.0**attempt)


def _upstream_code(response: httpx2.Response) -> str | None:
    try:
        body = response.json()
    except ValueError:
        # intentional: an error answer without a JSON body has no upstream code to report.
        return None
    error = body.get("error") if isinstance(body, dict) else None
    code = (error.get("code") or error.get("type")) if isinstance(error, dict) else None
    return code[:80] if isinstance(code, str) else None


class OpenAIMailGenerator:
    """`MailGenerator` over the OpenAI Responses API."""

    def __init__(
        self,
        config: OpenAIConfig,
        *,
        booking_url: str | None = None,
        transport: httpx2.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._config = config
        self._booking_url = booking_url
        self._transport = transport
        self._sleep = sleep

    def _timeout_error(self) -> MailGenerationError:
        seconds = round(self._config.timeout_seconds)
        return generation_error(
            "ai_timeout", f"The AI did not answer within {seconds} s: nothing was saved."
        )

    def generate(self, prompt: MailPrompt) -> GeneratedMail:
        config = self._config
        request = {
            "model": config.model,
            "instructions": prompt.instructions,
            "input": prompt.input,
            "store": False,
            "text": {
                "format": {
                    "type": "json_schema",
                    "name": OUTPUT_SCHEMA_NAME,
                    "schema": OUTPUT_JSON_SCHEMA,
                    "strict": True,
                }
            },
        }
        timeout = httpx2.Timeout(
            config.timeout_seconds, connect=min(CONNECT_TIMEOUT_SECONDS, config.timeout_seconds)
        )
        # `trust_env` (VIPER_OPENAI_TRUST_ENV): honour the server's HTTPS_PROXY, SSL_CERT_FILE…
        with httpx2.Client(
            timeout=timeout, transport=self._transport, trust_env=config.trust_env
        ) as client:
            attempt = 0
            while True:
                can_retry = attempt < config.max_retries
                try:
                    response = client.post(
                        f"{config.base_url}/responses",
                        json=request,
                        headers={"Authorization": f"Bearer {config.api_key}"},
                    )
                except httpx2.TimeoutException:
                    raise self._timeout_error() from None
                except httpx2.TransportError as error:
                    if can_retry:
                        self._retry(attempt, None, f"network {type(error).__name__}")
                        attempt += 1
                        continue
                    raise generation_error(
                        "ai_upstream_error",
                        "The AI service cannot be reached: nothing was saved.",
                        upstream_code=type(error).__name__,
                    ) from None
                if response.status_code >= 400:
                    code = _upstream_code(response)
                    quota = code == "insufficient_quota"
                    if can_retry and response.status_code in RETRYABLE_STATUSES and not quota:
                        self._retry(
                            attempt,
                            response.headers.get("retry-after"),
                            f"HTTP {response.status_code}",
                        )
                        attempt += 1
                        continue
                    raise self._status_error(response.status_code, code)
                return self._mail(response)

    def _retry(self, attempt: int, retry_after: str | None, cause: str) -> None:
        delay = _retry_delay(attempt, retry_after)
        logger.info(
            "mail_generation.retry attempt=%s cause=%s delay=%.1fs", attempt + 1, cause, delay
        )
        self._sleep(delay)

    @staticmethod
    def _status_error(status: int, code: str | None) -> MailGenerationError:
        def error(name: str, message: str) -> MailGenerationError:
            return generation_error(name, message, upstream_status=status, upstream_code=code)

        if status in (401, 403):
            return error(
                "ai_auth_failed", "The OpenAI API key was refused: check the server configuration."
            )
        if status == 429:
            message = (
                "The OpenAI quota is exhausted: drafting is not possible for now."
                if code == "insufficient_quota"
                else "The OpenAI rate limit was reached: try again in a moment."
            )
            return error("ai_rate_limited", message)
        return error(
            "ai_upstream_error", f"The AI service failed (HTTP {status}): nothing was saved."
        )

    def _mail(self, response: httpx2.Response) -> GeneratedMail:
        try:
            payload = response.json()
        except ValueError:
            raise _invalid("The AI service answer is unreadable: nothing was saved.") from None
        subject, body = validate_output(extract_output_text(payload), booking_url=self._booking_url)
        answered = payload.get("model") if isinstance(payload, dict) else None
        model = (
            answered.strip()[:MODEL_MAX_LENGTH]
            if isinstance(answered, str) and answered.strip()
            else self._config.model
        )
        return GeneratedMail(subject=subject, body=body, model=model)
