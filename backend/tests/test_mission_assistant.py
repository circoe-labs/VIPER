"""The voice mission assistant (Slice 06): a conversational turn that only proposes edits of the
form's draft, through bounded tools; the mission is created by the form's own validated create.

The model is a scripted fake of the OpenAI Responses API (`httpx2.MockTransport`): no real call. The
last test is the handoff's trace: transcript -> tool calls -> draft actions -> validated create.
"""

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy.orm import Session

from tests.builders import add_company

MISSIONS = "/api/missions"
ASSISTANT = f"{MISSIONS}/assistant"
INTEGRATIONS = "/api/settings/integrations"
KEY = "sk-test-not-a-real-key"

Request = dict[str, Any]
Step = Callable[[Request], list[dict[str, Any]]]


def call(name: str, arguments: dict[str, Any], call_id: str = "c1") -> dict[str, Any]:
    return {
        "type": "function_call",
        "name": name,
        "call_id": call_id,
        "arguments": json.dumps(arguments),
    }


def say(text: str) -> list[dict[str, Any]]:
    return [{"type": "message", "content": [{"type": "output_text", "text": text}]}]


def outputs(request: Request) -> list[Any]:
    """The tool results the assistant sent back to the model in this round."""
    return [
        json.loads(item["output"])
        for item in request["input"]
        if item.get("type") == "function_call_output"
    ]


class FakeModel:
    """Plays one scripted step per model call and records every request."""

    def __init__(self, *steps: Step) -> None:
        self.steps = list(steps)
        self.requests: list[Request] = []

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        body = json.loads(request.content)
        self.requests.append(body)
        output = self.steps[len(self.requests) - 1](body)
        return httpx2.Response(
            200, json={"status": "completed", "model": "fake-1", "output": output}
        )


def enable(app: FastAPI, client: TestClient, *steps: Step) -> FakeModel:
    version = client.get(INTEGRATIONS).json()["version"]
    saved = client.put(
        INTEGRATIONS,
        json={
            "version": version,
            "openai_api_key": KEY,
            "openai_model": "fake-1",
            "openai_base_url": "http://127.0.0.1:9/v1",
        },
    )
    assert saved.status_code == 200, saved.text
    model = FakeModel(*steps)
    app.state.openai_transport = httpx2.MockTransport(model.handle)
    return model


def blank_draft(**changes: Any) -> dict[str, Any]:
    draft: dict[str, Any] = {
        "name": "",
        "category_id": None,
        "prompt": None,
        "skill_ids": None,
        "source_ids": None,
        "targets": [],
        "context_refs": [],
        "recurring": False,
        "missing": "Choisissez une catégorie.",
    }
    return {**draft, **changes}


def turn(client: TestClient, text: str, draft: dict[str, Any] | None = None) -> Any:
    return client.post(
        f"{ASSISTANT}/turn",
        json={"messages": [{"role": "user", "content": text}], "draft": draft or blank_draft()},
    )


def category_id(client: TestClient, key: str) -> str:
    rows = client.get("/api/mission-categories").json()
    return str(next(row["id"] for row in rows if row["key"] == key))


# --- availability and errors ---------------------------------------------------------------------


def test_capabilities_follow_the_configuration(app: FastAPI, client: TestClient) -> None:
    assert client.get(f"{ASSISTANT}/capabilities").json() == {"assistant": False, "speech": False}
    enable(app, client)
    assert client.get(f"{ASSISTANT}/capabilities").json()["assistant"] is True


def test_a_turn_without_the_ai_configured_says_so(client: TestClient) -> None:
    response = turn(client, "Crée une mission")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "ai_not_configured"


def test_the_last_message_must_be_the_persons(app: FastAPI, client: TestClient) -> None:
    enable(app, client)
    response = client.post(
        f"{ASSISTANT}/turn",
        json={"messages": [{"role": "assistant", "content": "Bonjour"}], "draft": blank_draft()},
    )
    assert response.status_code == 422


def test_a_provider_failure_is_a_typed_error_and_nothing_is_applied(
    app: FastAPI, client: TestClient
) -> None:
    enable(app, client)
    app.state.openai_transport = httpx2.MockTransport(lambda _: httpx2.Response(401, json={}))
    response = turn(client, "Un nom")
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "ai_auth_failed"


# --- the creator prompt --------------------------------------------------------------------------


def test_the_settings_prompt_briefs_the_model_not_the_category_prompts(
    app: FastAPI, client: TestClient
) -> None:
    model = enable(app, client, lambda _: say("Quel nom ?"), lambda _: say("Et la catégorie ?"))
    first = turn(client, "Je veux une mission")
    assert first.status_code == 200 and first.json()["reply"] == "Quel nom ?"
    default_prompt = client.get(f"{MISSIONS}/creator-prompt").json()["default"]
    assert default_prompt in model.requests[0]["instructions"]

    version = client.get(INTEGRATIONS).json()["version"]
    client.put(
        INTEGRATIONS, json={"version": version, "mission_creator_prompt": "Parle comme un pirate."}
    )
    turn(client, "Encore")
    instructions = model.requests[1]["instructions"]
    assert "Parle comme un pirate." in instructions and default_prompt not in instructions
    # The worker-side category prompts are untouched: only their names are in the catalogue.
    categories = client.get("/api/mission-categories").json()
    assert all(row["general_prompt"] not in instructions for row in categories)
    # The draft and the rules travel with every turn; the tools are the closed list.
    assert "Brouillon actuel" in instructions and "request_creation" in instructions
    tool_names = {tool["name"] for tool in model.requests[1]["tools"]}
    assert "set_category" in tool_names and not {"create_mission", "sql"} & tool_names


# --- draft tools ---------------------------------------------------------------------------------


def test_draft_tools_return_validated_actions_and_apply_nothing(
    app: FastAPI, client: TestClient
) -> None:
    signals = category_id(client, "signals")
    model = enable(
        app,
        client,
        lambda _: [
            call("set_name", {"name": "Veille Normandie"}, "a"),
            call("set_category", {"category_id": signals}, "b"),
            call("set_task_count", {"count": 5}, "c"),
            call(
                "set_recurrence",
                {"recurring": True, "interval_count": 1, "interval_unit": "weeks"},
                "d",
            ),
            call("set_options", {"geography": "Normandie"}, "e"),
        ],
        lambda request: say("C’est noté."),
    )
    response = turn(client, "Veille hebdo en Normandie, 5 éléments validés")
    body = response.json()
    assert response.status_code == 200, body
    assert body["reply"] == "C’est noté." and body["finalize"] is False
    assert [action["tool"] for action in body["actions"]] == [
        "set_name",
        "set_category",
        "set_task_count",
        "set_recurrence",
        "set_options",
    ]
    assert body["actions"][2]["args"] == {"count": 5}
    assert all(action["summary"] for action in body["actions"])
    # Every call was acknowledged to the model.
    assert outputs(model.requests[1]) == [{"ok": True}] * 5
    # No mission exists: the assistant wrote nothing.
    assert client.get(MISSIONS).json()["total"] == 1  # only the Dépôt


def test_invalid_calls_are_refused_to_the_model_and_never_returned(
    app: FastAPI, client: TestClient
) -> None:
    model = enable(
        app,
        client,
        lambda _: [
            call("set_category", {"category_id": "00000000-0000-0000-0000-000000000000"}, "a"),
            call("set_skills", {"skill_ids": ["not-a-uuid"]}, "b"),
            call("set_task_count", {"count": 999}, "c"),
            call("set_recurrence", {"recurring": True, "starts_at": "demain"}, "d"),
            call(
                "add_context_record",
                {"kind": "company", "id": "11111111-1111-1111-1111-111111111111"},
                "e",
            ),
            call("set_sources", {"source_ids": ["22222222-2222-2222-2222-222222222222"]}, "f"),
            call("drop_table", {}, "g"),
            call("set_prompt", {"prompt": "x" * 5001}, "h"),
        ],
        lambda _: say("Je corrige."),
    )
    body = turn(client, "n'importe quoi").json()
    assert body["actions"] == []
    errors = outputs(model.requests[1])
    assert len(errors) == 8 and all("error" in item for item in errors)
    assert "Outil inconnu" in errors[6]["error"]


def test_a_context_record_must_come_from_a_search_and_is_labelled(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, "Acme Logistique")
    db_session.flush()

    def find(_: Request) -> list[dict[str, Any]]:
        return [call("search_context_records", {"kind": "company", "query": "Acme"}, "s")]

    def attach(request: Request) -> list[dict[str, Any]]:
        found = outputs(request)[0]["fiches"]
        assert [row["label"] for row in found] == ["Acme Logistique"]
        assert str(company.id) == found[0]["id"]
        return [
            call("add_context_record", {"kind": "company", "id": found[0]["id"]}, "a"),
            call("add_target", {"kind": "company", "id": found[0]["id"]}, "t"),
            call("request_creation", {}, "r"),
        ]

    model = enable(app, client, find, attach, lambda _: say("Voulez-vous la créer ?"))
    body = turn(client, "Ajoute Acme en contexte et crée").json()
    assert [(a["tool"], a["args"]["label"]) for a in body["actions"]] == [
        ("add_context_record", "Acme Logistique"),
        ("add_target", "Acme Logistique"),
    ]
    # Records fetched in this turn: creation is refused (their text is data, not an instruction).
    refused = outputs(model.requests[2])
    assert refused[1:3] == [{"ok": True}, {"ok": True}] and "confirmation" in refused[3]["error"]
    assert body["finalize"] is False


def test_the_creation_flag_is_honoured_when_clearly_requested(
    app: FastAPI, client: TestClient
) -> None:
    enable(app, client, lambda _: [call("request_creation", {})], lambda _: say("Je la crée."))
    body = turn(client, "Go, crée-la", blank_draft(name="Veille", missing=None)).json()
    assert body["finalize"] is True and body["actions"] == []
    assert client.get(MISSIONS).json()["total"] == 1  # only the Dépôt


def test_source_library_search_then_attach(app: FastAPI, client: TestClient) -> None:
    created = client.post(
        f"{MISSIONS}/sources",
        json={"url": "https://www.linkedin.com/jobs", "label": "LinkedIn Jobs"},
    )
    assert created.status_code in (200, 201), created.text
    source = created.json()["id"]

    def find(_: Request) -> list[dict[str, Any]]:
        return [call("search_sources", {"query": "linkedin"}, "s")]

    def attach(request: Request) -> list[dict[str, Any]]:
        assert outputs(request)[0]["sources"][0]["id"] == source
        return [call("set_sources", {"source_ids": [source]}, "a")]

    enable(app, client, find, attach, lambda _: say("Source ajoutée."))
    body = turn(client, "Utilise LinkedIn").json()
    assert body["actions"][0]["args"]["source_ids"] == [source]
    assert body["actions"][0]["args"]["labels"] == ["LinkedIn Jobs"]


def test_the_tool_loop_is_bounded(app: FastAPI, client: TestClient) -> None:
    forever = [lambda _: [call("get_draft", {})]] * 10
    model = enable(app, client, *forever)
    body = turn(client, "boucle").json()
    assert len(model.requests) == 6
    assert body["reply"] and body["actions"] == []


# --- the handoff trace ---------------------------------------------------------------------------


def test_trace_transcript_to_draft_actions_to_validated_create(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    """Speech transcript -> assistant tool calls -> draft actions -> the form's validated create."""
    company = add_company(db_session, "Transports Durand")
    db_session.flush()
    prospection = category_id(client, "prospection")
    signals = category_id(client, "signals")

    # Turn 1: the person talks; the assistant proposes a draft and asks one question.
    enable(
        app,
        client,
        lambda _: [
            call("set_name", {"name": "Veille Durand"}, "a"),
            call("set_category", {"category_id": signals}, "b"),
            call("search_context_records", {"kind": "company", "query": "Durand"}, "c"),
        ],
        lambda request: [
            call(
                "add_target", {"kind": "company", "id": outputs(request)[2]["fiches"][0]["id"]}, "d"
            ),
            call(
                "set_recurrence",
                {"recurring": True, "interval_count": 1, "interval_unit": "weeks"},
                "e",
            ),
        ],
        lambda _: say("Veille hebdomadaire sur Transports Durand. Je la crée ?"),
        # Turn 2: « oui, go » -> creation requested.
        lambda _: [call("request_creation", {})],
        lambda _: say("C’est parti."),
    )
    first = turn(client, "Une veille chaque semaine sur Transports Durand").json()
    assert first["finalize"] is False and "Je la crée" in first["reply"]
    # The browser lays these actions over the form; its `toInput()` is what we post below.
    applied = {action["tool"]: action["args"] for action in first["actions"]}
    assert applied["add_target"]["label"] == "Transports Durand"
    assert prospection != signals

    draft = blank_draft(
        name=applied["set_name"]["name"],
        category_id=applied["set_category"]["category_id"],
        targets=[{"kind": "company", "id": str(company.id), "label": "Transports Durand"}],
        recurring=True,
        interval_count=1,
        interval_unit="weeks",
        missing=None,
    )
    second = client.post(
        f"{ASSISTANT}/turn",
        json={
            "messages": [
                {"role": "user", "content": "Une veille chaque semaine sur Transports Durand"},
                {"role": "assistant", "content": first["reply"]},
                {"role": "user", "content": "Oui, go"},
            ],
            "draft": draft,
        },
    ).json()
    assert second["finalize"] is True

    # The form's own save: the ordinary validated create. No mission existed until now.
    assert client.get(MISSIONS).json()["total"] == 1  # only the Dépôt
    created = client.post(
        MISSIONS,
        json={
            "name": draft["name"],
            "category_id": draft["category_id"],
            "prompt": None,
            "skill_ids": None,
            "source_ids": None,
            "targets": [{"kind": "company", "id": str(company.id)}],
            "is_recurring": True,
            "interval_count": 1,
            "interval_unit": "weeks",
            "result_kind": "signals",
            "run_now": False,
        },
    )
    assert created.status_code in (200, 201), created.text
    assert created.json()["card"]["name"] == "Veille Durand"
    assert client.get(MISSIONS).json()["total"] == 2  # + the Dépôt


# --- speech to text ------------------------------------------------------------------------------


def test_transcribe_is_unavailable_without_a_service(client: TestClient) -> None:
    response = client.post(
        f"{ASSISTANT}/transcribe", files={"audio": ("a.webm", b"x", "audio/webm")}
    )
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "stt_not_configured"


def test_transcribe_falls_back_to_the_openai_account_of_the_assistant(
    app: FastAPI, client: TestClient
) -> None:
    seen: list[httpx2.Request] = []

    def whisper(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(200, json={"text": "Bonjour"})

    app.state.settings = app.state.settings.model_copy(update={"openai_api_key": SecretStr("sk-x")})
    app.state.stt_transport = httpx2.MockTransport(whisper)
    assert client.get(f"{ASSISTANT}/capabilities").json()["speech"] is True
    response = client.post(
        f"{ASSISTANT}/transcribe", files={"audio": ("a.webm", b"x", "audio/webm")}
    )
    assert response.json() == {"text": "Bonjour"}
    assert str(seen[0].url) == "https://api.openai.com/v1/audio/transcriptions"
    assert seen[0].headers["authorization"] == "Bearer sk-x"


def test_transcribe_forwards_to_a_whisper_compatible_service(
    app: FastAPI, client: TestClient
) -> None:
    seen: list[httpx2.Request] = []

    def whisper(request: httpx2.Request) -> httpx2.Response:
        seen.append(request)
        return httpx2.Response(200, json={"text": "  Crée une veille  "})

    app.state.settings = app.state.settings.model_copy(
        update={"stt_base_url": "http://127.0.0.1:9/v1"}
    )
    app.state.stt_transport = httpx2.MockTransport(whisper)
    assert client.get(f"{ASSISTANT}/capabilities").json()["speech"] is True
    response = client.post(
        f"{ASSISTANT}/transcribe",
        files={"audio": ("a.webm", b"RIFFdata", "audio/webm;codecs=opus")},
    )
    assert response.status_code == 200 and response.json() == {"text": "Crée une veille"}
    assert str(seen[0].url) == "http://127.0.0.1:9/v1/audio/transcriptions"
    assert b'name="model"' in seen[0].content and b"RIFFdata" in seen[0].content


def test_transcribe_service_failure_is_typed(app: FastAPI, client: TestClient) -> None:
    app.state.settings = app.state.settings.model_copy(
        update={"stt_base_url": "http://127.0.0.1:9/v1"}
    )
    app.state.stt_transport = httpx2.MockTransport(lambda _: httpx2.Response(500))
    response = client.post(
        f"{ASSISTANT}/transcribe", files={"audio": ("a.webm", b"x", "audio/webm")}
    )
    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "stt_upstream_error"


def test_stt_settings_come_from_the_environment(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.core.config import Settings

    monkeypatch.setenv("VIPER_STT_BASE_URL", "http://127.0.0.1:8000/v1/")
    settings = Settings(runtime_settings_path=tmp_path / "r.json")
    assert settings.stt_base_url == "http://127.0.0.1:8000/v1"
    monkeypatch.setenv("VIPER_STT_BASE_URL", " ")
    assert Settings(runtime_settings_path=tmp_path / "r.json").stt_base_url is None


def test_the_task_count_follows_the_linked_records(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, "Acme Logistique")
    db_session.flush()
    prospection = category_id(client, "prospection")
    enrichment = category_id(client, "enrichment")

    def search(_: Request) -> list[dict[str, Any]]:
        return [call("search_context_records", {"kind": "company", "query": "Acme"}, "s")]

    def fill(_: Request) -> list[dict[str, Any]]:
        return [
            call("set_category", {"category_id": prospection, "result_kind": "prospects"}, "a"),
            call("add_target", {"kind": "company", "id": str(company.id)}, "b"),
            call("set_task_count", {"count": 50}, "c"),
            call("set_category", {"category_id": enrichment}, "d"),
            call("set_task_count", {"count": 50}, "e"),
        ]

    model = enable(app, client, search, fill, lambda _: say("C’est noté."))
    body = turn(client, "Trouve-moi 50 prospects chez Acme").json()

    assert [a["args"] for a in body["actions"] if a["tool"] == "set_task_count"] == [{"count": 50}]
    # On records to complete, one task per record: the model is told so.
    assert "fixé par les fiches liées (1)" in outputs(model.requests[2])[-1]["error"]
    assert "50 prospects chez X" in model.requests[0]["instructions"]
