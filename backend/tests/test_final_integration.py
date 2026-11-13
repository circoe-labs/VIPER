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

from app.models.missions import Mission, MissionRun
from app.services import missions
from tests.builders import add_company
from tests.test_mission_output import _claim, _submit
from tests.test_missions import MISSIONS, due_mission, mint, rpc


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


def test_two_owners_are_told_apart_end_to_end(client: TestClient, db_session: Session) -> None:
    first = mint(db_session, label="Claude Chat A")
    second = mint(db_session, label="Claude Chat B")
    who = [rpc(client, token, "viper_whoami", {}) for token in (first, second)]
    assert all(answer["isError"] is False for answer in who), who
    identities = {str(answer["structuredContent"]) for answer in who}
    assert len(identities) == 2
