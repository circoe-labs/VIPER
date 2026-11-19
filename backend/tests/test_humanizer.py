"""HumanGPT quality check (« Humanizer »): the adapter against an `httpx2.MockTransport`, the
settings (write-only key, enabled, minimum), « Tester la clé », the `humanizer-check` endpoint and
the gate of `validate` (`humanizer_score_too_low`, `humanizer_unavailable`). No real call."""

import json
import logging
import uuid
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.services import humanizer
from app.services.humanizer import HumanizerClient, HumanizerError
from tests.test_contact_messages_api import SENDER, messages, ok, prospect_id, refused
from tests.test_runtime_settings import URL, put

KEY = "hgpt_test_SECRET_never_logged_1234"
TEXT = "Bonjour Pierre,\n\nUn message écrit à la main, avec ses petites maladresses."


def detect_answer(score: float, verdict: str = "human") -> dict[str, Any]:
    return {"verdict": verdict, "score": score, "confidence": 0.9, "abstain": False, "signals": []}


def client_with(
    handler: Any, *, sleeps: list[float] | None = None
) -> tuple[HumanizerClient, list[httpx2.Request]]:
    seen: list[httpx2.Request] = []

    def record(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        result: httpx2.Response = handler(request, len(seen))
        return result

    return (
        HumanizerClient(
            KEY,
            base_url="https://api.humangpt.test/v1/",
            transport=httpx2.MockTransport(record),
            sleep=(sleeps if sleeps is not None else []).append,
        ),
        seen,
    )


# --- the adapter -------------------------------------------------------------------------------


def test_detect_sends_the_text_in_french_and_converts_the_score() -> None:
    client, seen = client_with(lambda request, n: httpx2.Response(200, json=detect_answer(0.18)))

    detection = client.detect(TEXT)

    assert detection.human_score == 82 and detection.verdict == "human"
    [request] = seen
    assert (request.method, str(request.url)) == ("POST", "https://api.humangpt.test/v1/detect")
    assert request.headers["authorization"] == f"Bearer {KEY}"
    assert json.loads(request.content) == {"text": TEXT, "language": "fr"}


def test_the_human_score_is_clamped_and_rounded() -> None:
    for ai, human in ((0.0, 100), (1.0, 0), (0.555, 44), (0.994, 1)):
        client, _ = client_with(lambda r, n, ai=ai: httpx2.Response(200, json=detect_answer(ai)))
        assert client.detect(TEXT).human_score == human


@pytest.mark.parametrize(
    ("status", "body", "code"),
    [
        (401, {"error": {"code": "invalid_api_key", "message": "x"}}, "humanizer_auth_failed"),
        (402, {"error": {"code": "quota_exceeded", "message": "x"}}, "humanizer_quota_exceeded"),
        (422, {"error": {"code": "invalid_request", "message": "x"}}, "humanizer_text_invalid"),
        (200, {"verdict": "human"}, "humanizer_invalid_output"),
        (200, {"verdict": "human", "score": 1.5}, "humanizer_invalid_output"),
    ],
)
def test_typed_errors_never_carry_the_key_or_the_text(
    status: int, body: dict[str, Any], code: str
) -> None:
    client, seen = client_with(lambda request, n: httpx2.Response(status, json=body))

    with pytest.raises(HumanizerError) as error:
        client.detect(TEXT)

    assert error.value.code == code
    assert KEY not in str(error.value) and "petites maladresses" not in str(error.value)
    assert len(seen) == 1  # neither a client error nor a quota error is retried


def test_only_429_and_5xx_are_retried_with_the_given_delay() -> None:
    sleeps: list[float] = []

    def handler(request: httpx2.Request, n: int) -> httpx2.Response:
        if n == 1:
            return httpx2.Response(
                429, json={"error": {"code": "rate_limited", "retry_after_seconds": 2}}
            )
        if n == 2:
            return httpx2.Response(502, json={"error": {"code": "engine_error"}})
        return httpx2.Response(200, json=detect_answer(0.5, "mixed"))

    client, seen = client_with(handler, sleeps=sleeps)

    detection = client.detect(TEXT)

    assert (detection.human_score, detection.verdict) == (50, "mixed")
    assert len(seen) == 3 and sleeps == [2.0, 1.0]


def test_a_persistent_failure_and_a_network_error_are_typed() -> None:
    client, seen = client_with(
        lambda request, n: httpx2.Response(503, json={"error": {"code": "engine_error"}})
    )
    with pytest.raises(HumanizerError) as error:
        client.detect(TEXT)
    assert (error.value.code, error.value.upstream_status) == ("humanizer_upstream_error", 503)
    assert len(seen) == humanizer.MAX_RETRIES + 1

    def down(request: httpx2.Request, n: int) -> httpx2.Response:
        raise httpx2.ConnectError("refused", request=request)

    unreachable, _ = client_with(down)
    with pytest.raises(HumanizerError) as unreachable_error:
        unreachable.detect(TEXT)
    assert unreachable_error.value.code == "humanizer_upstream_error"

    def slow(request: httpx2.Request, n: int) -> httpx2.Response:
        raise httpx2.ReadTimeout("slow", request=request)

    timeout, _ = client_with(slow)
    with pytest.raises(HumanizerError) as timeout_error:
        timeout.detect(TEXT)
    assert timeout_error.value.code == "humanizer_timeout"


def test_an_empty_or_too_long_text_is_refused_before_any_call() -> None:
    client, seen = client_with(lambda request, n: httpx2.Response(200, json=detect_answer(0.1)))
    for text in ("  \n", "mot " * (humanizer.MAX_WORDS + 1)):
        with pytest.raises(HumanizerError) as error:
            client.detect(text)
        assert error.value.code == "humanizer_text_invalid"
    assert seen == []


def test_no_log_line_holds_the_key_or_the_text(caplog: pytest.LogCaptureFixture) -> None:
    settings = Settings(humanizer_api_key=SecretStr(KEY), humanizer_min_score=70)
    transport = httpx2.MockTransport(lambda request: httpx2.Response(200, json=detect_answer(0.4)))
    with caplog.at_level(logging.DEBUG):
        check = humanizer.check_text(settings, TEXT, transport)

    assert (check.human_score, check.passed, check.min_score) == (60, False, 70)
    assert KEY not in caplog.text and "petites maladresses" not in caplog.text


# --- the settings and « Tester la clé » ---------------------------------------------------------


def test_the_key_is_write_only_and_the_options_are_validated(client: TestClient) -> None:
    body = ok(client.get(URL))
    assert body["humanizer_api_key"]["set"] is False and body["humanizer_available"] is False
    assert body["fields"]["humanizer_enabled"]["value"] is False
    assert body["fields"]["humanizer_min_score"]["value"] == 70

    saved = ok(put(client, humanizer_api_key=KEY, humanizer_enabled=True, humanizer_min_score=80))

    assert KEY not in json.dumps(saved)
    assert saved["humanizer_api_key"]["set"] is True
    assert saved["humanizer_api_key"]["last4"] == KEY[-4:] and saved["humanizer_available"] is True
    assert saved["fields"]["humanizer_enabled"]["value"] is True
    assert saved["fields"]["humanizer_min_score"]["value"] == 80
    for bad in (101, -1):
        assert put(client, humanizer_min_score=bad).status_code == 422
    cleared = ok(put(client, humanizer_api_key=None, humanizer_enabled=False))
    assert cleared["humanizer_available"] is False
    assert cleared["fields"]["humanizer_enabled"]["value"] is False


def test_the_key_check_calls_usage_with_the_saved_key(app: FastAPI, client: TestClient) -> None:
    assert ok(client.post(f"{URL}/humanizer/check"))["code"] == "humanizer_not_configured"
    ok(put(client, humanizer_api_key=KEY))
    seen: list[httpx2.Request] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        if len(seen) == 1:
            return httpx2.Response(200, json={"words_remaining": 1000})
        return httpx2.Response(401, json={"error": {"code": "invalid_api_key"}})

    app.state.humanizer_transport = httpx2.MockTransport(handler)

    passed = ok(client.post(f"{URL}/humanizer/check"))
    failed = ok(client.post(f"{URL}/humanizer/check"))

    assert (passed["ok"], passed["code"]) == (True, None)
    assert (failed["ok"], failed["code"]) == (False, "humanizer_auth_failed")
    assert (seen[0].method, seen[0].url.path) == ("GET", "/v1/usage")
    assert seen[0].headers["authorization"] == f"Bearer {KEY}"
    assert KEY not in json.dumps([passed, failed])


# --- the gate of « Valider » --------------------------------------------------------------------


class Humanizer:
    """Scripted HumanGPT: the AI probability to answer, or a status to fail with."""

    def __init__(self, app: FastAPI) -> None:
        self.calls: list[dict[str, Any]] = []
        self.ai_score = 0.1
        self.status = 200
        app.state.humanizer_transport = httpx2.MockTransport(self.handle)

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.calls.append(json.loads(request.content))
        if self.status != 200:
            return httpx2.Response(self.status, json={"error": {"code": "invalid_api_key"}})
        return httpx2.Response(200, json=detect_answer(self.ai_score))


@pytest.fixture
def gate(app: FastAPI, client: TestClient) -> Humanizer:
    app.state.settings = Settings(
        database_url=app.state.settings.database_url,
        default_outbound_email=SENDER,
        humanizer_api_key=SecretStr(KEY),
        humanizer_enabled=True,
        humanizer_min_score=70,
    )
    return Humanizer(app)


def draft(client: TestClient, db_session: Session) -> tuple[uuid.UUID, str]:
    prospect = prospect_id(db_session)
    path = messages(prospect)
    created = client.put(
        f"{path}/contact",
        json={"subject": "Sujet", "body_text": TEXT, "to": ["a@exemple.example"]},
    )
    assert created.status_code == 201, created.text
    return prospect, path


def test_the_defaults_tell_the_editor_about_the_gate(
    gate: Humanizer, client: TestClient, db_session: Session
) -> None:
    defaults = ok(client.get(messages(prospect_id(db_session))))["defaults"]

    assert defaults["humanizer"] == {"enabled": True, "configured": True, "min_score": 70}


def test_a_human_enough_message_is_validated_after_the_check(
    gate: Humanizer, client: TestClient, db_session: Session
) -> None:
    gate.ai_score = 0.25  # human score 75
    _, path = draft(client, db_session)

    body = ok(client.post(f"{path}/contact/validate", json={"expected_revision": 1}))

    assert body["message"]["status"] == "validated"
    assert gate.calls == [{"text": TEXT, "language": "fr"}]


def test_a_message_below_the_minimum_is_refused_and_stays_a_draft(
    gate: Humanizer, client: TestClient, db_session: Session
) -> None:
    gate.ai_score = 0.4  # human score 60
    _, path = draft(client, db_session)

    body = refused(
        client.post(f"{path}/contact/validate", json={"expected_revision": 1}),
        422,
        "humanizer_score_too_low",
    )

    message = body["message"]
    assert "60/100" in message and "70/100" in message
    assert (body["human_score"], body["min_score"]) == (60, 70)
    assert ok(client.get(f"{path}/contact"))["message"]["status"] == "draft"


def test_a_failing_humanizer_refuses_never_passes(
    gate: Humanizer, client: TestClient, db_session: Session
) -> None:
    gate.status = 401
    _, path = draft(client, db_session)

    body = refused(
        client.post(f"{path}/contact/validate", json={"expected_revision": 1}),
        503,
        "humanizer_unavailable",
    )

    assert body["reason"] == "humanizer_auth_failed"
    assert KEY not in json.dumps(body)
    assert ok(client.get(f"{path}/contact"))["message"]["status"] == "draft"


def test_the_gate_is_off_when_disabled_or_without_key(
    app: FastAPI, gate: Humanizer, client: TestClient, db_session: Session
) -> None:
    gate.ai_score = 0.9
    _, path = draft(client, db_session)
    base = app.state.settings
    app.state.settings = base.model_copy(update={"humanizer_enabled": False})
    ok(client.post(f"{path}/contact/validate", json={"expected_revision": 1}))
    assert gate.calls == []

    _, other = draft(client, db_session)
    app.state.settings = base.model_copy(update={"humanizer_api_key": None})
    ok(client.post(f"{other}/contact/validate", json={"expected_revision": 1}))
    assert gate.calls == []


def test_the_other_refusals_come_first_and_cost_no_call(
    gate: Humanizer, client: TestClient, db_session: Session
) -> None:
    _, path = draft(client, db_session)

    refused(
        client.post(f"{path}/contact/validate", json={"expected_revision": 9}),
        409,
        "revision_conflict",
    )
    refused(
        client.post(f"{path}/r1/validate", json={"expected_revision": 1}), 404, "message_not_found"
    )

    assert gate.calls == []


# --- the check endpoint --------------------------------------------------------------------------


def test_the_check_endpoint_scores_a_text_or_a_saved_step(
    gate: Humanizer, client: TestClient, db_session: Session
) -> None:
    gate.ai_score = 0.2
    prospect, _ = draft(client, db_session)

    by_text = ok(client.post("/api/contact/humanizer-check", json={"text": "Un autre texte"}))
    by_step = ok(
        client.post(
            "/api/contact/humanizer-check", json={"prospect_id": str(prospect), "step": "contact"}
        )
    )

    assert by_text == {"human_score": 80, "verdict": "human", "passed": True, "min_score": 70}
    assert by_step == by_text
    assert [call["text"] for call in gate.calls] == ["Un autre texte", TEXT]

    gate.ai_score = 0.5
    low = ok(client.post("/api/contact/humanizer-check", json={"text": "Encore"}))
    assert (low["human_score"], low["passed"]) == (50, False)


def test_the_check_endpoint_refusals(
    app: FastAPI, gate: Humanizer, client: TestClient, anonymous_client: TestClient
) -> None:
    assert (
        anonymous_client.post("/api/contact/humanizer-check", json={"text": "x"}).status_code == 401
    )
    assert client.post("/api/contact/humanizer-check", json={}).status_code == 422
    assert client.post("/api/contact/humanizer-check", json={"text": "  "}).status_code == 422
    gate.status = 401
    refused(
        client.post("/api/contact/humanizer-check", json={"text": "x"}),
        503,
        "humanizer_unavailable",
    )
    app.state.settings = app.state.settings.model_copy(update={"humanizer_api_key": None})
    body = refused(
        client.post("/api/contact/humanizer-check", json={"text": "x"}),
        503,
        "humanizer_unavailable",
    )
    assert body["reason"] == "humanizer_not_configured"
