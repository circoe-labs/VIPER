"""Final integration traces (task `viper_mission_agent_configuration_v2`, Slice 08).

Cross-slice scenarios over the real JSON-RPC `/mcp` endpoint and the existing scheduler: a recurring
mission whose objective is reset per run by the scheduler pass (no second scheduler), and several
owner agents told apart end to end.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.enums import AgentMode, AgentProvider
from app.models.missions import Mission, MissionRun
from app.services import mcp_tokens, missions
from tests.builders import add_company
from tests.test_mission_output import _claim, _submit
from tests.test_missions import MISSIONS, due_mission, rpc


def _accept(client: TestClient, submitted: dict[str, Any]) -> None:
    result_id = submitted["structuredContent"]["result_id"]
    assert client.post(f"/api/agents/results/{result_id}/accept", json={}).status_code == 200


def test_a_recurring_objective_is_reset_per_run_by_the_existing_scheduler(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    mission = due_mission(client, db_session, company)
    now = datetime.now(UTC)

    first = missions.run_due(db_session, now=now)
    assert len(first) == 1
    first_id = first[0].id
    token, payload = _claim(client, db_session, "update_company")
    assert payload["objective"] == {"kind": "tasks_accepted", "count": None}
    _accept(
        client, _submit(client, token, payload, {"website_url": "https://2sn.fr", "confidence": 80})
    )

    db_session.expire_all()
    run_one = db_session.get(MissionRun, first_id)
    assert run_one is not None and run_one.objective_met_at is not None
    parent = db_session.get(Mission, mission.id)
    assert parent is not None and parent.status.value == "active"  # a recurring parent never closes
    assert parent.next_run_at is not None

    # Nothing is due yet: the pass starts no duplicate run.
    assert missions.run_due(db_session, now=now) == []

    # One interval later the same scheduler pass opens a fresh run with a fresh objective.
    second = missions.run_due(db_session, now=parent.next_run_at + timedelta(seconds=1))
    assert len(second) == 1 and second[0].id != first_id
    assert second[0].objective_met_at is None
    runs = db_session.scalars(select(MissionRun).where(MissionRun.mission_id == mission.id)).all()
    assert len(runs) == 2
    detail = client.get(f"{MISSIONS}/{mission.id}").json()
    assert detail["card"]["status"] == "active"
    assert detail["objective_progress"]["met"] is False


def _identity(client: TestClient, token: str) -> str:
    answer = rpc(client, token, "viper_whoami", {})
    assert answer["isError"] is False, answer
    return str(answer["structuredContent"]["identity"])


def test_owners_conversations_and_a_scheduled_agent_are_told_apart_over_mcp(
    client: TestClient, db_session: Session
) -> None:
    def mint_for(owner: str, mode: AgentMode = AgentMode.INTERACTIVE) -> str:
        token, _ = mcp_tokens.mint(
            db_session,
            label="Conversation",
            scopes=["*"],
            owner_email=owner,
            provider=AgentProvider.CHATGPT,
            mode=mode,
        )
        return token

    scheduled = mint_for("lucie@circoe.com", AgentMode.SCHEDULED)
    first = mint_for("lucie@circoe.com")
    second = mint_for("lucie@circoe.com")
    other_owner = mint_for("paul@circoe.com")

    # The scheduled agent reserves #1 of its owner; conversations take the next numbers; another
    # owner counts from 1 again.
    assert _identity(client, scheduled) == "ChatGPT lucie #1"
    assert _identity(client, first) == "ChatGPT lucie #2"
    assert _identity(client, second) == "ChatGPT lucie #3"
    assert _identity(client, other_owner) == "ChatGPT paul #1"
