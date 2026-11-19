"""HumanGPT quality check of a mail (« Humanizer »): is the message written like a human?

Optional gate of « Valider » (Paramètres > Config AI > Humanizer): when enabled and a key is
saved, the current body is sent to `POST {base}/detect` and the message cannot be validated below
the required minimum. Contract checked on https://humangpt.io/api-docs (2026-11-19):

- base `https://api.humangpt.io/v1`, `Authorization: Bearer hgpt_…`;
- `POST /detect` `{text (<= 8000 words), language: "fr"}` -> `{verdict: human|ai|mixed,
  score: 0..1 (probability the text is AI), confidence, abstain, signals, request_id}`;
- `GET /usage` is the cheap authenticated call used by « Tester la clé »;
- errors `{error: {code, message}}`: 401 `invalid_api_key`, 402 `quota_exceeded`, 429
  `rate_limited` (`retry_after_seconds`), 5xx `engine_error`; a detection may take up to 120 s;
  only 429 and 5xx are retried.

VIPER's quality score is `human_score = round((1 - score) * 100)` (0-100, higher = more human).

The check is never silent: a failed call raises `HumanizerError` (`humanizer_unavailable` once
mapped by `ensure_human_enough`), so a person can switch the feature off, never a pass by default.
Callers must not hold a database transaction while calling (the call can last minutes). The key
and the text never reach a log line or an error message.

HTTP client: `httpx2` (ADR-0001); tests inject an `httpx2.MockTransport`
(`state.humanizer_transport`).
"""

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from http import HTTPStatus
from typing import Any

import httpx2

from app.core.config import Settings
from app.services.errors import ContactMessageError

logger = logging.getLogger(__name__)

LANGUAGE = "fr"
# The API accepts at most 8000 words per detection.
MAX_WORDS = 8000
DETECT_TIMEOUT_SECONDS = 120.0
USAGE_TIMEOUT_SECONDS = 15.0
CONNECT_TIMEOUT_SECONDS = 10.0
MAX_RETRIES = 2
MAX_RETRY_DELAY_SECONDS = 10.0
VERDICTS = ("human", "ai", "mixed")


class HumanizerError(Exception):
    """A HumanGPT call failed. `code` is stable and worded by the UI (never the key or the text):
    `humanizer_not_configured`, `humanizer_auth_failed`, `humanizer_quota_exceeded`,
    `humanizer_rate_limited`, `humanizer_timeout`, `humanizer_upstream_error`,
    `humanizer_invalid_output`, `humanizer_text_invalid`."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        upstream_status: int | None = None,
        upstream_code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.upstream_status = upstream_status
        self.upstream_code = upstream_code


@dataclass(frozen=True, slots=True)
class HumanCheck:
    human_score: int  # 0-100, higher = more human
    verdict: str  # `human` | `ai` | `mixed`
    passed: bool
    min_score: int


@dataclass(frozen=True, slots=True)
class Detection:
    ai_score: float  # 0-1, higher = more AI
    verdict: str

    @property
    def human_score(self) -> int:
        return max(0, min(100, round((1 - self.ai_score) * 100)))


def configured(settings: Settings) -> bool:
    return settings.humanizer_api_key is not None


def active(settings: Settings) -> bool:
    """The gate applies: switched on and a key saved."""
    return settings.humanizer_enabled and configured(settings)


def _upstream_code(response: httpx2.Response) -> tuple[str | None, float | None]:
    try:
        body = response.json()
    except ValueError:
        # intentional: an error answer without a JSON body has no upstream code to report.
        return None, None
    error = body.get("error") if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return None, None
    code = error.get("code")
    retry = error.get("retry_after_seconds")
    return (
        code[:80] if isinstance(code, str) else None,
        float(retry) if isinstance(retry, int | float) and retry >= 0 else None,
    )


class HumanizerClient:
    def __init__(
        self,
        api_key: str,
        *,
        base_url: str,
        transport: httpx2.BaseTransport | None = None,
        trust_env: bool = False,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._transport = transport
        self._trust_env = trust_env
        self._sleep = sleep

    @classmethod
    def from_settings(
        cls, settings: Settings, transport: httpx2.BaseTransport | None = None
    ) -> HumanizerClient:
        if settings.humanizer_api_key is None:
            raise HumanizerError(
                "humanizer_not_configured", "Aucune clé HumanGPT n’est enregistrée."
            )
        return cls(
            settings.humanizer_api_key.get_secret_value(),
            base_url=settings.humanizer_base_url,
            transport=transport,
        )

    def _request(
        self, method: str, path: str, *, timeout: float, json: dict[str, Any] | None = None
    ) -> Any:
        http_timeout = httpx2.Timeout(timeout, connect=min(CONNECT_TIMEOUT_SECONDS, timeout))
        with httpx2.Client(
            timeout=http_timeout, transport=self._transport, trust_env=self._trust_env
        ) as client:
            attempt = 0
            while True:
                can_retry = attempt < MAX_RETRIES
                try:
                    response = client.request(
                        method,
                        f"{self._base_url}{path}",
                        json=json,
                        headers={"Authorization": f"Bearer {self._api_key}"},
                    )
                except httpx2.TimeoutException:
                    raise HumanizerError(
                        "humanizer_timeout",
                        f"HumanGPT n’a pas répondu en {round(timeout)} s.",
                    ) from None
                except httpx2.TransportError as error:
                    if can_retry:
                        self._pause(attempt, None, f"network {type(error).__name__}")
                        attempt += 1
                        continue
                    raise HumanizerError(
                        "humanizer_upstream_error",
                        "HumanGPT est injoignable.",
                        upstream_code=type(error).__name__,
                    ) from None
                if response.status_code < 400:
                    break
                code, retry_after = _upstream_code(response)
                retryable = response.status_code == 429 or response.status_code >= 500
                if retryable and can_retry and code != "quota_exceeded":
                    self._pause(attempt, retry_after, f"HTTP {response.status_code}")
                    attempt += 1
                    continue
                raise self._status_error(response.status_code, code)
        try:
            return response.json()
        except ValueError:
            raise HumanizerError(
                "humanizer_invalid_output", "La réponse de HumanGPT est illisible."
            ) from None

    def _pause(self, attempt: int, retry_after: float | None, cause: str) -> None:
        delay = min(
            MAX_RETRY_DELAY_SECONDS,
            retry_after if retry_after is not None else 0.5 * 2.0**attempt,
        )
        logger.info("humanizer.retry attempt=%s cause=%s delay=%.1fs", attempt + 1, cause, delay)
        self._sleep(delay)

    @staticmethod
    def _status_error(status: int, code: str | None) -> HumanizerError:
        def error(name: str, message: str) -> HumanizerError:
            return HumanizerError(name, message, upstream_status=status, upstream_code=code)

        if status in (401, 403):
            return error("humanizer_auth_failed", "La clé HumanGPT a été refusée.")
        if status == 402 or code == "quota_exceeded":
            return error("humanizer_quota_exceeded", "Le quota HumanGPT est épuisé.")
        if status == 429:
            return error(
                "humanizer_rate_limited", "HumanGPT limite le débit : réessayez dans un instant."
            )
        if status in (400, 413, 422):
            return error("humanizer_text_invalid", "HumanGPT a refusé ce texte.")
        return error("humanizer_upstream_error", f"HumanGPT a échoué (HTTP {status}).")

    def detect(self, text: str) -> Detection:
        """`POST /detect`: how likely the text is written by an AI."""
        if not text.strip():
            raise HumanizerError("humanizer_text_invalid", "Le message est vide.")
        if len(text.split()) > MAX_WORDS:
            raise HumanizerError(
                "humanizer_text_invalid",
                f"Le message dépasse {MAX_WORDS} mots, limite de HumanGPT.",
            )
        payload = self._request(
            "POST",
            "/detect",
            timeout=DETECT_TIMEOUT_SECONDS,
            json={"text": text, "language": LANGUAGE},
        )
        score = payload.get("score") if isinstance(payload, dict) else None
        verdict = payload.get("verdict") if isinstance(payload, dict) else None
        if isinstance(score, bool) or not isinstance(score, int | float) or not 0 <= score <= 1:
            raise HumanizerError(
                "humanizer_invalid_output", "La réponse de HumanGPT n’a pas le format attendu."
            )
        return Detection(float(score), verdict if verdict in VERDICTS else "mixed")

    def check_key(self) -> None:
        """`GET /usage`: the key is accepted (nothing is consumed)."""
        self._request("GET", "/usage", timeout=USAGE_TIMEOUT_SECONDS)


def check_text(
    settings: Settings, text: str, transport: httpx2.BaseTransport | None = None
) -> HumanCheck:
    """Detect `text` with the saved key and compare it to the required minimum. Raises
    `HumanizerError`. Never called inside a database transaction."""
    started = time.monotonic()
    try:
        detection = HumanizerClient.from_settings(settings, transport).detect(text)
    except HumanizerError as error:
        logger.warning(
            "humanizer.detect_failed code=%s upstream_status=%s upstream_code=%s duration=%.1fs",
            error.code,
            error.upstream_status,
            error.upstream_code,
            time.monotonic() - started,
        )
        raise
    result = HumanCheck(
        human_score=detection.human_score,
        verdict=detection.verdict,
        passed=detection.human_score >= settings.humanizer_min_score,
        min_score=settings.humanizer_min_score,
    )
    logger.info(
        "humanizer.detect_ok human_score=%s verdict=%s passed=%s duration=%.1fs",
        result.human_score,
        result.verdict,
        result.passed,
        time.monotonic() - started,
    )
    return result


def unavailable(error: HumanizerError) -> ContactMessageError:
    """`humanizer_unavailable`: the check could not be made, so nothing passes by default."""
    return ContactMessageError(
        "humanizer_unavailable",
        HTTPStatus.SERVICE_UNAVAILABLE,
        f"{error} Le contrôle HumanGPT n’a pas pu être fait : réessayez, ou désactivez-le dans "
        "Paramètres > Config AI.",
        reason=error.code,
    )


def too_low(check: HumanCheck) -> ContactMessageError:
    return ContactMessageError(
        "humanizer_score_too_low",
        HTTPStatus.UNPROCESSABLE_CONTENT,
        f"Score d’humanité insuffisant : {check.human_score}/100 pour un minimum requis de "
        f"{check.min_score}/100. Réécrivez le message pour qu’il sonne plus humain, puis "
        "validez à nouveau.",
        human_score=check.human_score,
        min_score=check.min_score,
        verdict=check.verdict,
    )


def check_or_refuse(
    settings: Settings, text: str, transport: httpx2.BaseTransport | None = None
) -> HumanCheck:
    """`check_text` with the failure typed as `humanizer_unavailable`."""
    try:
        return check_text(settings, text, transport)
    except HumanizerError as error:
        raise unavailable(error) from error


def ensure_human_enough(
    settings: Settings, text: str, transport: httpx2.BaseTransport | None = None
) -> HumanCheck:
    """The gate of « Valider »: `humanizer_score_too_low` (422, with the numbers) below the
    minimum, `humanizer_unavailable` (503) when HumanGPT could not answer."""
    check = check_or_refuse(settings, text, transport)
    if not check.passed:
        raise too_low(check)
    return check
