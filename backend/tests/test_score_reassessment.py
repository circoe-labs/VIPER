"""« Réévaluer le score » (S4): one-off prospect mission -> agent proposal -> audited accept.

Failure, rejection and cancellation never change the score; only an accepted proposal writes
scored notes, tied to the reviewed result."""

from datetime import UTC, datetime
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AgentTask
from app.models.agent_missions import AgentTaskResult
from app.models.enums import AgentTaskStatus, AgentTaskType, MissionStatus, SignalOrigin
from app.models.missions import Mission, MissionTarget
from app.models.prospects import ProspectNote
from tests.builders import add_company, add_prospect
from tests.test_mcp_tools import body, call
from tests.test_missions import mint

TODAY = datetime.now(UTC).date().isoformat()
MISSING = "00000000-0000-0000-0000-000000000001"


def url(prospect_id: Any) -> str:
    return f"/api/prospects/{prospect_id}/score/reassessment"


def score_of(client: TestClient, prospect_id: Any) -> dict[str, Any]:
    score: dict[str, Any] = client.get(f"/api/prospects/{prospect_id}").json()["score"]
    return score


def claim(client: TestClient, token: str) -> dict[str, Any]:
    return body(call(client, token, "viper_claim_task", {"task_types": ["reassess_score"]}))


def result_for(claimed: dict[str, Any], **changes: Any) -> dict[str, Any]:
    result = {
        "contributions": [
            {
                "delta": 12,
                "criterion": "Taille",
                "reason": "Dirige un site logistique de 300 personnes",
                "source": "https://exemple.fr/equipe",
                "quote": "Directeur du site de Rouen",
                "observed_on": TODAY,
                "confidence": 80,
            },
            {
                "delta": -4,
                "reason": "Secteur peu ciblé",
                "source": "https://exemple.fr/secteur",
                "observed_on": TODAY,
            },
        ],
        "rationale": "Décideur d'un site correspondant à la cible.",
        "suggested_total": 58,
        "confidence": 75,
    }
    result.update(changes)
    return {"task_id": claimed["task_id"], "claim_id": claimed["claim_id"], "result": result}


def submit_proposal(client: TestClient, db_session: Session) -> tuple[Any, dict[str, Any]]:
    """A prospect with a submitted proposal waiting for review: `(prospect, state)`."""
    prospect = add_prospect(db_session, add_company(db_session))
    client.post(url(prospect.id), json={})
    token = mint(db_session)
    body(call(client, token, "viper_submit_task_result", result_for(claim(client, token))))
    return prospect, client.get(url(prospect.id)).json()


def test_the_request_creates_a_one_off_mission_bound_to_the_prospect(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))

    created = client.post(url(prospect.id), json={})

    assert created.status_code == 201
    assert created.json()["status"] == "queued"
    db_session.expire_all()
    mission = db_session.get(Mission, created.json()["mission_id"])
    assert mission is not None
    assert (mission.task_type, mission.is_recurring, mission.status) == (
        AgentTaskType.REASSESS_SCORE,
        False,
        MissionStatus.ACTIVE,
    )
    targets = db_session.scalars(
        select(MissionTarget).where(MissionTarget.mission_id == mission.id)
    ).all()
    assert [target.prospect_id for target in targets] == [prospect.id]
    task = db_session.get(AgentTask, created.json()["task_id"])
    assert task is not None and task.type is AgentTaskType.REASSESS_SCORE
    # A second click returns the open one instead of opening another mission.
    again = client.post(url(prospect.id), json={})
    assert again.status_code == 200
    assert again.json()["task_id"] == created.json()["task_id"]


def test_the_claim_payload_carries_commercial_fit_inputs_only(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    client.post(url(prospect.id), json={})

    payload = claim(client, mint(db_session))

    assert payload["task"] == "reassess_score"
    assert payload["subject"]["prospect_id"] == str(prospect.id)
    assert payload["current_score"]["total"] == 50
    assert payload["criteria"]["weights"] is None
    assert "emails" not in payload["user_data"]
    assert payload["criteria"]["forbidden_inputs"]


def test_a_proposal_changes_nothing_until_accepted_then_the_score_moves_with_a_trace(
    client: TestClient, db_session: Session
) -> None:
    prospect, state = submit_proposal(client, db_session)

    assert score_of(client, prospect.id)["total"] == 50
    assert state["status"] == "proposal"
    assert state["proposal"]["projected_total"] == 58
    assert state["proposal"]["current_total"] == 50
    assert len(state["proposal"]["items"]) == 2

    accepted = client.post(
        f"/api/agents/results/{state['result_id']}/accept", json={"accepted_items": None}
    )

    assert accepted.status_code == 200, accepted.text
    score = score_of(client, prospect.id)
    assert score["total"] == 58
    assert {line["origin"] for line in score["contributions"]} == {"agent"}
    db_session.expire_all()
    notes = db_session.scalars(
        select(ProspectNote).where(ProspectNote.prospect_id == prospect.id)
    ).all()
    assert len(notes) == 2
    assert {str(note.task_result_id) for note in notes} == {state["result_id"]}
    assert all(note.origin is SignalOrigin.AGENT and note.source_url for note in notes)
    final = client.get(url(prospect.id)).json()
    assert final["status"] == "applied"
    assert final["decided_by"]


def test_a_partial_accept_applies_only_the_chosen_contributions(
    client: TestClient, db_session: Session
) -> None:
    prospect, state = submit_proposal(client, db_session)
    first = state["proposal"]["items"][0]["key"]

    client.post(
        f"/api/agents/results/{state['result_id']}/accept", json={"accepted_items": [first]}
    )

    assert score_of(client, prospect.id)["total"] == 62


def test_a_rejected_proposal_leaves_the_score_and_a_new_request_starts_over(
    client: TestClient, db_session: Session
) -> None:
    prospect, state = submit_proposal(client, db_session)

    client.post(
        f"/api/agents/results/{state['result_id']}/reject", json={"reason": "Trop optimiste"}
    )

    assert score_of(client, prospect.id)["total"] == 50
    assert client.get(url(prospect.id)).json()["status"] == "rejected"
    restarted = client.post(url(prospect.id), json={})
    assert restarted.status_code == 201
    assert restarted.json()["status"] == "queued"


def test_an_agent_failure_and_a_cancellation_never_touch_the_score(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    client.post(url(prospect.id), json={})
    token = mint(db_session)
    claimed = claim(client, token)

    call(
        client,
        token,
        "viper_fail_task",
        {
            "task_id": claimed["task_id"],
            "claim_id": claimed["claim_id"],
            "code": "blocked",
            "message": "Sources injoignables",
        },
    )

    state = client.get(url(prospect.id)).json()
    assert state["status"] == "queued"
    assert state["failure_message"] == "Sources injoignables"
    assert score_of(client, prospect.id)["total"] == 50
    cancelled = client.delete(url(prospect.id)).json()
    assert cancelled["status"] == "cancelled"
    assert score_of(client, prospect.id)["total"] == 50


def test_a_proposal_without_rationale_is_refused_and_a_bad_source_is_a_refused_item(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    client.post(url(prospect.id), json={})
    token = mint(db_session)
    claimed = claim(client, token)

    no_rationale = call(
        client, token, "viper_submit_task_result", result_for(claimed, rationale=None)
    )

    assert no_rationale["isError"] is True
    bad_source = call(
        client,
        token,
        "viper_submit_task_result",
        result_for(
            claimed,
            contributions=[
                {"delta": 5, "reason": "Fait", "source": "pas une url", "observed_on": TODAY}
            ],
        ),
    )
    assert bad_source["isError"] is False
    state = client.get(url(prospect.id)).json()
    assert state["status"] == "proposal"
    assert state["proposal"]["items"] == []
    assert state["proposal"]["refused"][0]["reason"] == "format"


def test_an_unknown_prospect_is_a_404(client: TestClient) -> None:
    assert client.get(url(MISSING)).status_code == 404
    assert client.post(url(MISSING), json={}).status_code == 404


def test_the_accepted_result_is_the_audited_decision(
    client: TestClient, db_session: Session
) -> None:
    _, state = submit_proposal(client, db_session)
    client.post(f"/api/agents/results/{state['result_id']}/accept", json={"accepted_items": None})

    db_session.expire_all()
    result = db_session.get(AgentTaskResult, state["result_id"])
    assert result is not None and result.decided_by_display
    assert result.applied is not None and len(result.applied["score_notes"]) == 2
    task = db_session.get(AgentTask, state["task_id"])
    assert task is not None and task.status is AgentTaskStatus.ACCEPTED
