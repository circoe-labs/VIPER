"""« Évaluer le score »: the LLM judges the prospect directly (2026-11-18), the client is mocked.

The success path stores a traceable assessment that becomes the displayed score; every failure
(malformed answer, timeout, refusal, no key, unknown prospect) leaves the current score untouched
and says why; the editable prompt and the Circoe target reach the model."""

import json
from collections.abc import Callable
from typing import Any

import httpx2
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import ProspectScoreAssessment, User
from app.services import person_links
from app.services.person_links import Person
from app.services.prospect_scoring_prompt import DEFAULT_CIRCOE_TARGET
from tests.builders import FIXTURE_ACTOR, add_company, add_prospect

INTEGRATIONS = "/api/settings/integrations"
ANSWER: dict[str, Any] = {
    "score": 82,
    "rationale": "Directeur général d’une ETI industrielle : forte adéquation.",
    "criteria": [
        {"label": "Poste décisionnaire", "delta": 25, "evidence": "Directeur général"},
        {"label": "Taille", "delta": -3, "evidence": "non renseigné"},
    ],
}


def url(prospect_id: Any) -> str:
    return f"/api/prospects/{prospect_id}/score/evaluate"


def configure(client: TestClient, **extra: Any) -> None:
    version = client.get(INTEGRATIONS).json()["version"]
    saved = client.put(
        INTEGRATIONS,
        json={
            "version": version,
            "openai_api_key": "sk-fake",
            "openai_model": "fake-1",
            "openai_base_url": "http://127.0.0.1:9/v1",
            **extra,
        },
    )
    assert saved.status_code == 200, saved.text


def answer_with(app: FastAPI, content: object) -> list[dict[str, Any]]:
    """Answer every call with `content` (an object, or a raw string); returns the requests."""
    received: list[dict[str, Any]] = []

    def handle(request: httpx2.Request) -> httpx2.Response:
        received.append(json.loads(request.content))
        text = content if isinstance(content, str) else json.dumps(content)
        output = [{"type": "message", "content": [{"type": "output_text", "text": text}]}]
        return httpx2.Response(
            200, json={"status": "completed", "model": "fake-1-snapshot", "output": output}
        )

    app.state.openai_transport = httpx2.MockTransport(handle)
    return received


def transport(app: FastAPI, handle: Callable[[httpx2.Request], httpx2.Response]) -> None:
    app.state.openai_transport = httpx2.MockTransport(handle)


def score_of(client: TestClient, prospect_id: Any) -> dict[str, Any]:
    score: dict[str, Any] = client.get(f"/api/prospects/{prospect_id}").json()["score"]
    return score


def stored(db_session: Session) -> int:
    db_session.expire_all()
    return db_session.scalar(select(func.count()).select_from(ProspectScoreAssessment)) or 0


def test_success_stores_a_traceable_assessment_that_becomes_the_displayed_score(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session, display_name="Vatinel"))
    configure(client)
    received = answer_with(app, ANSWER)
    assert score_of(client, prospect.id)["total"] == 50
    assert score_of(client, prospect.id)["assessment"] is None

    response = client.post(url(prospect.id))

    assert response.status_code == 200, response.text
    score = response.json()
    assert score["total"] == 82
    assert score["band"] == "green"
    assert score["summary"] == ANSWER["rationale"]
    info = score["assessment"]
    assert info["model"] == "fake-1-snapshot"
    assert len(info["prompt_version"]) == 8
    assert info["actor_display"]
    assert [item["label"] for item in info["criteria"]] == ["Poste décisionnaire", "Taille"]
    assert score_of(client, prospect.id)["total"] == 82  # read again from the prospect
    db_session.expire_all()
    row = db_session.scalars(select(ProspectScoreAssessment)).one()
    assert (row.score, row.model, len(row.prompt_hash), row.prospect_id) == (
        82,
        "fake-1-snapshot",
        64,
        prospect.id,
    )
    assert row.actor_type == "human" and row.duration_ms >= 0
    assert row.criteria[0] == {
        "label": "Poste décisionnaire",
        "delta": 25,
        "evidence": "Directeur général",
    }
    # The call was a strict structured output that does not keep the request at the provider.
    sent = received[0]
    assert sent["store"] is False
    assert sent["text"]["format"]["strict"] is True
    assert sent["text"]["format"]["name"] == "prospect_score"


def test_the_model_reads_the_whole_sheet_but_neither_the_graph_nor_the_contact_state(
    app: FastAPI, client: TestClient, db_session: Session, pilot_user: User
) -> None:
    company = add_company(db_session, display_name="Vatinel")
    prospect = add_prospect(db_session, company, first_name="Jeanne", last_name="Vatinel")
    other = add_prospect(db_session, company, first_name="Léa", last_name="Autre")
    person_links.create_link(
        db_session,
        FIXTURE_ACTOR,
        Person("prospect", prospect.id),
        Person("member", pilot_user.id),
        "ami",
        100,
        None,
    )
    person_links.create_link(
        db_session,
        FIXTURE_ACTOR,
        Person("prospect", prospect.id),
        Person("prospect", other.id),
        "collègue",
        90,
        None,
    )
    configure(client)
    received = answer_with(app, ANSWER)

    assert client.post(url(prospect.id)).status_code == 200

    text = received[0]["input"]
    sheet = json.loads(text.split("\n", 1)[1])
    assert sheet["identite"]["nom"] == "Vatinel" and sheet["identite"]["prenom"] == "Jeanne"
    assert sheet["societe"]["nom"] == "Vatinel"
    assert set(sheet) >= {"identite", "poste", "emails", "telephones", "societe", "notes"}
    lowered = text.lower()
    for forbidden in ("proximit", "collègue", "séquence", "relance", "cohort", "graph", "lien"):
        assert forbidden not in lowered
    assert "Léa" not in text  # a linked person is not read


def test_the_default_prompt_and_circoe_target_are_the_instructions(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    configure(client)
    received = answer_with(app, ANSWER)

    client.post(url(prospect.id))

    instructions = received[0]["instructions"]
    assert "analyste commercial de Circoe" in instructions
    assert DEFAULT_CIRCOE_TARGET in instructions
    assert "adéquation commerciale uniquement" in instructions  # the fixed guardrail


def test_a_customised_prompt_and_target_are_applied_and_change_the_prompt_version(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    configure(client)
    received = answer_with(app, ANSWER)
    first = client.post(url(prospect.id)).json()["assessment"]["prompt_version"]

    version = client.get(INTEGRATIONS).json()["version"]
    client.put(
        INTEGRATIONS,
        json={
            "version": version,
            "prospect_scoring_prompt": "Tu es un évaluateur très strict.",
            "circoe_target": "Cible : les cimenteries du Grand Est.",
        },
    )
    second = client.post(url(prospect.id)).json()["assessment"]["prompt_version"]

    instructions = received[1]["instructions"]
    assert instructions.startswith("Tu es un évaluateur très strict.")
    assert "Cible : les cimenteries du Grand Est." in instructions
    assert "analyste commercial de Circoe" not in instructions
    assert "adéquation commerciale uniquement" in instructions  # still fixed
    assert first != second

    version = client.get(INTEGRATIONS).json()["version"]
    reset = client.put(
        INTEGRATIONS,
        json={"version": version, "prospect_scoring_prompt": None, "circoe_target": None},
    )
    assert reset.status_code == 200
    assert client.post(url(prospect.id)).json()["assessment"]["prompt_version"] == first


def test_the_integrations_page_exposes_the_defaults(client: TestClient) -> None:
    data = client.get(INTEGRATIONS).json()

    assert "analyste commercial de Circoe" in data["prospect_scoring_prompt_default"]
    assert data["circoe_target_default"] == DEFAULT_CIRCOE_TARGET
    assert data["fields"]["prospect_scoring_prompt"]["value"] is None


def test_an_out_of_range_score_and_deltas_are_clamped(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    configure(client)
    answer_with(
        app,
        {
            "score": 150,
            "rationale": "Trop beau.",
            "criteria": [{"label": "Tout", "delta": -400, "evidence": "x"}],
        },
    )

    response = client.post(url(prospect.id))

    assert response.status_code == 200, response.text
    assert response.json()["total"] == 100
    assert response.json()["assessment"]["criteria"][0]["delta"] == -100


def failed(
    client: TestClient, db_session: Session, prospect_id: Any, status: int, code: str
) -> dict[str, Any]:
    before = score_of(client, prospect_id)
    response = client.post(url(prospect_id))
    assert response.status_code == status, response.text
    detail: dict[str, Any] = response.json()["detail"]
    assert detail["code"] == code
    assert stored(db_session) == 0  # nothing written
    assert score_of(client, prospect_id) == before  # the current score is untouched
    return detail


def test_a_malformed_answer_is_refused_and_the_score_is_unchanged(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    configure(client)

    answer_with(app, "ceci n'est pas du JSON")
    failed(client, db_session, prospect.id, 502, "ai_invalid_output")


def test_a_wrong_shape_is_refused_whatever_the_defect(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    configure(client)
    bad_answers: list[object] = [
        {"score": "élevé", "rationale": "x", "criteria": []},  # a string is not a score
        {"score": 71.5, "rationale": "x", "criteria": []},  # nor a fraction
        {"score": True, "rationale": "x", "criteria": []},  # nor a boolean
        {"score": 70, "rationale": "", "criteria": []},  # a rationale is required
        {"rationale": "x", "criteria": []},  # a key is missing
        {"score": 70, "rationale": "x", "criteria": [], "extra": 1},  # no extra key
        {"score": 70, "rationale": "x", "criteria": [{"label": "a", "delta": 1}]},
        {"score": 70, "rationale": "x", "criteria": [{"label": "a", "delta": "1", "evidence": ""}]},
        [1, 2, 3],  # not an object
    ]
    for bad in bad_answers:
        answer_with(app, bad)
        detail = failed(client, db_session, prospect.id, 502, "ai_invalid_output")
        assert "élevé" not in detail["message"]  # the answer is never echoed


def test_a_timeout_says_so_and_changes_nothing(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    configure(client)

    def slow(request: httpx2.Request) -> httpx2.Response:
        raise httpx2.ReadTimeout("slow", request=request)

    transport(app, slow)
    failed(client, db_session, prospect.id, 504, "ai_timeout")


def test_a_provider_refusal_and_an_auth_failure_are_typed(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    configure(client)
    refusal = [{"type": "message", "content": [{"type": "refusal", "refusal": "non"}]}]
    transport(
        app, lambda request: httpx2.Response(200, json={"status": "completed", "output": refusal})
    )
    failed(client, db_session, prospect.id, 422, "ai_refused")

    transport(
        app,
        lambda request: httpx2.Response(401, json={"error": {"code": "invalid_api_key"}}),
    )
    failed(client, db_session, prospect.id, 502, "ai_auth_failed")


def test_no_key_configured_points_to_config_ai(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session))

    detail = failed(client, db_session, prospect.id, 503, "ai_not_configured")

    assert "Config AI" in detail["message"]


def test_an_unknown_prospect_is_a_404(app: FastAPI, client: TestClient) -> None:
    configure(client)
    answer_with(app, ANSWER)

    assert client.post(url("00000000-0000-0000-0000-000000000001")).status_code == 404


def test_the_latest_assessment_wins_and_without_one_the_note_score_applies(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    configure(client)
    client.post(
        f"/api/prospects/{prospect.id}/notes",
        json={"fact_text": "A liké un post", "score_delta": 5},
    )
    assert score_of(client, prospect.id)["total"] == 55  # the fallback: the notes

    answer_with(app, ANSWER)
    client.post(url(prospect.id))
    answer_with(app, {**ANSWER, "score": 30, "rationale": "Plutôt faible."})
    client.post(url(prospect.id))

    score = score_of(client, prospect.id)
    assert (score["total"], score["band"]) == (30, "red")
    assert score["assessment"]["rationale"] == "Plutôt faible."
    assert [line["delta"] for line in score["contributions"]] == [5]  # the note stays listed
    assert stored(db_session) == 2  # the history is kept


def test_the_config_ai_test_runs_the_saved_prompt_without_storing(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    add_prospect(db_session, add_company(db_session), first_name="Jeanne", last_name="Vatinel")
    configure(client)
    answer_with(app, ANSWER)

    response = client.post(f"{INTEGRATIONS}/scoring/test")

    assert response.status_code == 200, response.text
    data = response.json()
    assert (data["score"], data["prospect_name"]) == (82, "Jeanne Vatinel")
    assert data["criteria"][0]["label"] == "Poste décisionnaire"
    assert stored(db_session) == 0


def test_the_config_ai_test_without_a_key_is_the_same_clear_refusal(
    client: TestClient, db_session: Session
) -> None:
    add_prospect(db_session, add_company(db_session))

    response = client.post(f"{INTEGRATIONS}/scoring/test")

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "ai_not_configured"
