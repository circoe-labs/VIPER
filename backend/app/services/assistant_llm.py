"""A tool-calling turn against the OpenAI Responses API, for the mission-creator assistant.

Same provider, configuration (`VIPER_OPENAI_*`, Paramètres > Connexions), timeouts, bounded retries
and typed `ai_*` errors as the Contact drafting (`mail_generation.openai_client`, which this module
reuses rather than duplicates); only the request differs: `tools` (function calling) instead of a
strict `json_schema`. `store: false`: nothing is kept by the provider. Never the key, the prompt or
the raw answer in an error message or a log line.

The caller owns the loop (`mission_assistant.run_turn`): it feeds the `output` items back, with the
`function_call_output` it computed, until the model answers with plain text.
"""

import logging
import time
from collections.abc import Callable
from typing import Any, Protocol

import httpx2

from app.core.config import Settings
from app.services.mail_generation.openai_client import (
    CONNECT_TIMEOUT_SECONDS,
    RETRYABLE_STATUSES,
    OpenAIConfig,
    OpenAIMailGenerator,
    _retry_delay,
    _upstream_code,
    config_from_settings,
    generation_error,
    missing_settings,
    not_configured,
)

logger = logging.getLogger(__name__)

# Asks for the encrypted reasoning items so a reasoning model can continue a tool loop statelessly
# (`store: false`): they are sent back verbatim with the next call.
INCLUDE = ["reasoning.encrypted_content"]


class AssistantModel(Protocol):
    """One call of the model: returns the Responses `output` items and the answering model."""

    def respond(
        self, instructions: str, input_items: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], str]: ...


class OpenAIAssistantModel:
    def __init__(
        self,
        config: OpenAIConfig,
        *,
        transport: httpx2.BaseTransport | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._config = config
        self._transport = transport
        self._sleep = sleep

    def respond(
        self, instructions: str, input_items: list[dict[str, Any]], tools: list[dict[str, Any]]
    ) -> tuple[list[dict[str, Any]], str]:
        config = self._config
        request = {
            "model": config.model,
            "instructions": instructions,
            "input": input_items,
            "tools": tools,
            "store": False,
            "include": INCLUDE,
        }
        timeout = httpx2.Timeout(
            config.timeout_seconds, connect=min(CONNECT_TIMEOUT_SECONDS, config.timeout_seconds)
        )
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
                    raise generation_error(
                        "ai_timeout",
                        f"The AI did not answer within {round(config.timeout_seconds)} s.",
                    ) from None
                except httpx2.TransportError as error:
                    if can_retry:
                        self._pause(attempt, None, f"network {type(error).__name__}")
                        attempt += 1
                        continue
                    raise generation_error(
                        "ai_upstream_error",
                        "The AI service cannot be reached.",
                        upstream_code=type(error).__name__,
                    ) from None
                if response.status_code >= 400:
                    code = _upstream_code(response)
                    quota = code == "insufficient_quota"
                    if can_retry and response.status_code in RETRYABLE_STATUSES and not quota:
                        self._pause(attempt, response.headers.get("retry-after"), "HTTP error")
                        attempt += 1
                        continue
                    raise OpenAIMailGenerator._status_error(response.status_code, code)
                return self._items(response)

    def _pause(self, attempt: int, retry_after: str | None, cause: str) -> None:
        delay = _retry_delay(attempt, retry_after)
        logger.info(
            "mission_assistant.retry attempt=%s cause=%s delay=%.1fs", attempt + 1, cause, delay
        )
        self._sleep(delay)

    def _items(self, response: httpx2.Response) -> tuple[list[dict[str, Any]], str]:
        unreadable = "The AI service answer is unreadable."
        try:
            payload = response.json()
        except ValueError:
            raise generation_error("ai_invalid_output", unreadable) from None
        output = payload.get("output") if isinstance(payload, dict) else None
        if not isinstance(output, list):
            raise generation_error("ai_invalid_output", unreadable)
        items = [item for item in output if isinstance(item, dict)]
        if any(
            content.get("type") == "refusal"
            for item in items
            if item.get("type") == "message"
            for content in (item.get("content") or [])
            if isinstance(content, dict)
        ):
            raise generation_error("ai_refused", "The AI declined to answer.")
        status = payload.get("status")
        if status and status != "completed":
            raise generation_error(
                "ai_invalid_output",
                "The AI answer is incomplete.",
                upstream_code=str(status)[:80],
            )
        answered = payload.get("model")
        model = answered.strip()[:200] if isinstance(answered, str) and answered.strip() else ""
        return items, model or self._config.model


def assistant_model_for(
    settings: Settings, transport: httpx2.BaseTransport | None
) -> AssistantModel:
    """The adapter over the saved OpenAI settings; `ai_not_configured` (503) when unset."""
    config = config_from_settings(settings)
    if config is None:
        raise not_configured(missing_settings(settings))
    return OpenAIAssistantModel(config, transport=transport)
