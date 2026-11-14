"""Optional Whisper-compatible speech-to-text for the voice mission assistant.

`POST {VIPER_STT_BASE_URL}/audio/transcriptions` (multipart `file`, `model`, `language`,
`response_format=json`): the shape of OpenAI's endpoint and of the local servers that copy it
(faster-whisper-server, whisper.cpp server, LocalAI…), so the deployment can keep the audio on
its own machine. Unset (`stt_base_url`), `available` is false and the browser falls back to its own
speech recognition, then to typed text (graceful degradation: doc/architecture/missions.md §7f).

Typed errors reuse `MailGenerationError` (the API already maps it to `{code, message}`): codes
`stt_not_configured` 503, `stt_invalid_audio` 422, `stt_timeout` 504, `stt_upstream_error` 502.
Never the key, the audio or the transcript in an error message or a log line; the audio is neither
stored nor logged.
"""

import logging
from http import HTTPStatus

import httpx2

from app.core.config import Settings
from app.services.errors import MailGenerationError

logger = logging.getLogger(__name__)

MAX_AUDIO_BYTES = 12 * 1024 * 1024
MAX_TRANSCRIPT_LENGTH = 4000
CONNECT_TIMEOUT_SECONDS = 10.0
STT_STATUS = {
    "stt_not_configured": HTTPStatus.SERVICE_UNAVAILABLE,
    "stt_invalid_audio": HTTPStatus.UNPROCESSABLE_CONTENT,
    "stt_timeout": HTTPStatus.GATEWAY_TIMEOUT,
    "stt_upstream_error": HTTPStatus.BAD_GATEWAY,
}


def _error(code: str, message: str, *, upstream_status: int | None = None) -> MailGenerationError:
    return MailGenerationError(code, STT_STATUS[code], message, upstream_status=upstream_status)


def _endpoint(settings: Settings) -> tuple[str, str | None] | None:
    """(base URL, bearer key): the dedicated service, else the OpenAI account already configured
    for the assistant (its transcription endpoint; model `stt_model`), else None."""
    if settings.stt_base_url is not None:
        key = settings.stt_api_key.get_secret_value() if settings.stt_api_key else None
        return settings.stt_base_url, key
    if settings.openai_api_key is not None:
        return settings.openai_base_url, settings.openai_api_key.get_secret_value()
    return None


def available(settings: Settings) -> bool:
    return _endpoint(settings) is not None


def transcribe(
    settings: Settings,
    audio: bytes,
    *,
    content_type: str,
    language: str = "fr",
    transport: httpx2.BaseTransport | None = None,
) -> str:
    """The text of one utterance ('' when nothing intelligible was said)."""
    endpoint = _endpoint(settings)
    if endpoint is None:
        raise _error("stt_not_configured", "No speech-to-text service is configured.")
    if not audio:
        raise _error("stt_invalid_audio", "The recording is empty.")
    if len(audio) > MAX_AUDIO_BYTES:
        raise _error("stt_invalid_audio", "The recording is too long.")
    base_url, api_key = endpoint
    headers = {}
    if api_key is not None:
        headers["Authorization"] = f"Bearer {api_key}"
    # The recorder names its container in the content type (`audio/webm;codecs=opus`).
    extension = "ogg" if "ogg" in content_type else "mp4" if "mp4" in content_type else "webm"
    timeout_seconds = settings.stt_timeout_ms / 1000
    timeout = httpx2.Timeout(timeout_seconds, connect=min(CONNECT_TIMEOUT_SECONDS, timeout_seconds))
    try:
        with httpx2.Client(timeout=timeout, transport=transport) as client:
            response = client.post(
                f"{base_url}/audio/transcriptions",
                headers=headers,
                data={
                    "model": settings.stt_model,
                    "language": language,
                    "response_format": "json",
                },
                files={"file": (f"speech.{extension}", audio, content_type or "audio/webm")},
            )
    except httpx2.TimeoutException:
        raise _error("stt_timeout", "The speech-to-text service did not answer in time.") from None
    except httpx2.TransportError as error:
        logger.warning("stt.unreachable error=%s", type(error).__name__)
        raise _error(
            "stt_upstream_error", "The speech-to-text service cannot be reached."
        ) from None
    if response.status_code >= 400:
        logger.warning("stt.failed upstream_status=%s", response.status_code)
        raise _error(
            "stt_upstream_error",
            f"The speech-to-text service failed (HTTP {response.status_code}).",
            upstream_status=response.status_code,
        )
    try:
        body = response.json()
    except ValueError:
        raise _error("stt_upstream_error", "The speech-to-text answer is unreadable.") from None
    text = body.get("text") if isinstance(body, dict) else None
    if not isinstance(text, str):
        raise _error("stt_upstream_error", "The speech-to-text answer is unreadable.")
    return text.strip()[:MAX_TRANSCRIPT_LENGTH]
