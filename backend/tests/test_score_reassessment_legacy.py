"""Legacy `reassess_score` agent tasks (retired request path, 2026-11-18).

« Évaluer le score » now calls the LLM directly (`test_prospect_scoring.py`); no code creates a
`reassess_score` task any more. A task that already exists (created before this change) can still
be claimed and its proposal reviewed: the contract (`score_reassessment.py`) is kept for that and
pinned here. Removal condition: no `reassess_score` task left open in production, then drop the
contract, its hooks in `agent_payloads` / `agent_review` and this file.
"""

from datetime import UTC, datetime
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AgentTask
from app.models.agent_missions import AgentTaskResult
from app.models.enums import AgentTaskType, MissionResultKind, MissionType, SignalOrigin
from app.models.prospects import ProspectNote
from app.services import missions
from tests.builders import FIXTURE_ACTOR, add_company, add_prospect
from tests.test_mcp_tools import body, call
from tests.test_missions import mint

TODAY = datetime.now(UTC).date().isoformat()


def legacy_task(db_session: Session, prospect_id: Any) -> AgentTask:
    """What the retired request created: a one-off mission forcing the `reassess_score` task."""
    missions.create(
        db_session,
        FIXTURE_ACTOR,
        missions.MissionInput(
            name="Réévaluer le score — test",
            type=MissionType.OTHER,
            prompt="Réévalue le score.",
            targets=(missions.TargetInput(prospect_id=prospect_id),),
            result_kind=MissionResultKind.ENRICHMENT,
            task_type=AgentTaskType.REASSESS_SCORE,
        ),
        run_now=True,
    )
    db_session.flush()
    task = db_session.scalars(
        select(AgentTask).where(AgentTask.type == AgentTaskType.REASSESS_SCORE)
    ).one()
    return task


def claim(client: TestClient, token: str) -> dict[str, Any]:
    return body(call(client, token, "viper_claim_task", {"task_types": ["reassess_score"]}))


def test_the_claim_payload_carries_commercial_fit_inputs_only(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    legacy_task(db_session, prospect.id)

    payload = claim(client, mint(db_session))

    assert payload["task"] == "reassess_score"
    assert payload["subject"]["prospect_id"] == str(prospect.id)
    assert "emails" not in payload["user_data"]
    assert payload["criteria"]["forbidden_inputs"]


def test_an_accepted_legacy_proposal_still_writes_scored_notes_with_a_trace(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session))
    legacy_task(db_session, prospect.id)
    token = mint(db_session)
    claimed = claim(client, token)
    result = {
        "contributions": [
            {
                "delta": 12,
                "reason": "Dirige un site logistique",
                "source": "https://exemple.fr/equipe",
                "observed_on": TODAY,
            }
        ],
        "rationale": "Décideur d'un site correspondant à la cible.",
        "confidence": 75,
    }
    body(
        call(
            client,
            token,
            "viper_submit_task_result",
            {"task_id": claimed["task_id"], "claim_id": claimed["claim_id"], "result": result},
        )
    )
    db_session.expire_all()
    stored = db_session.scalars(select(AgentTaskResult)).one()

    accepted = client.post(f"/api/agents/results/{stored.id}/accept", json={"accepted_items": None})

    assert accepted.status_code == 200, accepted.text
    score = client.get(f"/api/prospects/{prospect.id}").json()["score"]
    assert score["total"] == 62
    notes = db_session.scalars(
        select(ProspectNote).where(ProspectNote.prospect_id == prospect.id)
    ).all()
    assert [(note.origin, note.task_result_id) for note in notes] == [
        (SignalOrigin.AGENT, stored.id)
    ]
