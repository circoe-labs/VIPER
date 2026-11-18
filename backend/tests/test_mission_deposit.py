"""The permanent « Dépôt » mission: where an agent drops work nobody asked for as a mission.

An agent opens a job with `viper_open_deposit`, then hands it back through the usual claim / submit
/ review process. The mission itself can never be edited, paused, run or deleted.
"""

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.agent_missions import AgentTask, AgentTaskResult
from app.models.enums import AgentTaskStatus, MissionRunStatus, MissionStatus
from app.models.missions import Mission, MissionRun
from tests.builders import add_company
from tests.test_mcp_missions import refused
from tests.test_mcp_tools import body, call
from tests.test_missions import MISSIONS, mint


def deposit_card(client: TestClient) -> dict[str, Any]:
    items = client.get(MISSIONS).json()["items"]
    cards = [item for item in items if item["is_deposit"]]
    assert len(cards) == 1
    card: dict[str, Any] = cards[0]
    return card


def test_the_deposit_exists_and_is_flagged(client: TestClient) -> None:
    card = deposit_card(client)

    assert card["name"] == "Dépôt"
    assert card["status"] == "active"


def test_the_deposit_cannot_be_changed_run_or_deleted(client: TestClient) -> None:
    mission_id = deposit_card(client)["id"]

    assert client.delete(f"{MISSIONS}/{mission_id}").status_code == 409
    assert client.patch(f"{MISSIONS}/{mission_id}", json={"status": "paused"}).status_code == 409
    assert client.patch(f"{MISSIONS}/{mission_id}", json={"status": "cancelled"}).status_code == 409
    assert deposit_card(client)["status"] == "active"


def test_an_agent_drops_a_job_and_hands_it_back_by_the_usual_process(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    token = mint(db_session)

    claimed = body(
        call(
            client,
            token,
            "viper_open_deposit",
            {"task_type": "update_company", "company_id": str(company.id)},
        )
    )

    assert claimed["claim_id"]
    assert claimed["mission"]["name"] == "Dépôt"
    submitted = body(
        call(
            client,
            token,
            "viper_submit_task_result",
            {
                "task_id": claimed["task_id"],
                "claim_id": claimed["claim_id"],
                "result": {"legal_name": "2SN SAS", "confidence": 80},
            },
        )
    )
    assert submitted["status"] == "pending_review"
    db_session.expire_all()
    task = db_session.get(AgentTask, claimed["task_id"])
    assert task is not None
    assert task.status is AgentTaskStatus.SUBMITTED
    assert db_session.scalar(select(AgentTaskResult).where(AgentTaskResult.task_id == task.id))
    # Nothing is applied before a person's review.
    db_session.refresh(company)
    assert company.legal_name is None
    # The drop is a run of the Dépôt, which stays active whatever happens to it.
    card = deposit_card(client)
    assert card["runs_count"] == 1
    assert card["status"] == "active"


def test_the_deposit_stays_active_after_a_drop_is_failed(
    client: TestClient, db_session: Session
) -> None:
    token = mint(db_session)
    claimed = body(call(client, token, "viper_open_deposit", {"task_type": "find_prospects"}))

    call(
        client,
        token,
        "viper_fail_task",
        {"task_id": claimed["task_id"], "claim_id": claimed["claim_id"], "code": "blocked"},
    )

    db_session.expire_all()
    mission = db_session.scalar(select(Mission).where(Mission.is_deposit))
    assert mission is not None and mission.status is MissionStatus.ACTIVE
    run = db_session.scalar(select(MissionRun).where(MissionRun.mission_id == mission.id))
    assert run is not None
    missions_service_refresh(db_session, run)
    assert run.status is MissionRunStatus.DONE
    assert mission.status is MissionStatus.ACTIVE


def missions_service_refresh(session: Session, run: MissionRun) -> None:
    from app.services import missions

    missions.refresh_run(session, run)


def test_a_drop_needs_its_subject_and_a_known_type(
    client: TestClient, db_session: Session
) -> None:
    token = mint(db_session)

    refused(call(client, token, "viper_open_deposit", {"task_type": "update_company"}), "missing")
    refused(call(client, token, "viper_open_deposit", {"task_type": "nope"}), "enum")


def test_a_token_without_the_scope_cannot_drop_that_type(
    client: TestClient, db_session: Session
) -> None:
    token = mint(db_session, scopes=["update_company"])

    refused(
        call(client, token, "viper_open_deposit", {"task_type": "find_prospects"}), "not_allowed"
    )
