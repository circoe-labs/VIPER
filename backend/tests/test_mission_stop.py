"""Slice 03.1: pausing or cancelling a mission stops its tasks.

Pause hides the mission's pending tasks from the queue and from claims, but a task already claimed
may still be finished; resuming offers them again. Cancelling closes every open task and every
running run in the same transaction; a worker still holding a task is refused with the stable code
`task_cancelled`, and nothing it sends afterwards reaches the domain. REST (`PATCH`) and MCP
(`viper_set_mission_status`) go through the same service.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import Company
from app.models.agent_missions import AgentTask, AgentTaskResult
from app.models.enums import AgentResultStatus, AgentTaskStatus, MissionStatus
from app.models.missions import MissionRun
from app.models.organizations import OrganizationRole
from app.services import agent_missions, missions
from app.services.errors import ConflictError
from tests.builders import add_company
from tests.test_mcp_missions import assistant, refused
from tests.test_mcp_tools import body, call
from tests.test_missions import MISSIONS, create, due_mission, mint

RESULT = {"legal_name": "2SN SAS", "confidence": 80}


def mission_with(client: TestClient, *companies: Company, name: str = "Compléter") -> str:
    detail = create(
        client,
        name=name,
        targets=[{"kind": "company", "id": str(company.id)} for company in companies],
        run_now=True,
    )
    mission_id: str = detail["card"]["id"]
    return mission_id


def claim(client: TestClient, token: str) -> dict[str, Any]:
    return body(call(client, token, "viper_claim_task", {"task_types": ["update_company"]}))


def submit(client: TestClient, token: str, claimed: dict[str, Any]) -> dict[str, Any]:
    return call(
        client,
        token,
        "viper_submit_task_result",
        {"task_id": claimed["task_id"], "claim_id": claimed["claim_id"], "result": RESULT},
    )


def heartbeat(client: TestClient, token: str, claimed: dict[str, Any]) -> dict[str, Any]:
    return call(
        client,
        token,
        "viper_heartbeat_task",
        {"task_id": claimed["task_id"], "claim_id": claimed["claim_id"]},
    )


def set_status(client: TestClient, mission_id: str, status: str) -> None:
    response = client.patch(f"{MISSIONS}/{mission_id}", json={"status": status})
    assert response.status_code == 200, response.text


def queue(client: TestClient, token: str) -> dict[str, int]:
    counts: dict[str, int] = body(call(client, token, "viper_task_queue", {}))["tasks"]
    return counts


def statuses(session: Session, mission_id: str) -> tuple[list[str], list[str]]:
    session.expire_all()
    runs = session.scalars(select(MissionRun).where(MissionRun.mission_id == mission_id)).all()
    tasks = session.scalars(
        select(AgentTask).where(AgentTask.run_id.in_([run.id for run in runs]))
    ).all()
    return sorted(task.status.value for task in tasks), [run.status.value for run in runs]


def assert_cancelled_and_refused(
    client: TestClient, session: Session, mission_id: str, token: str, claimed: dict[str, Any]
) -> None:
    tasks, runs = statuses(session, mission_id)
    assert tasks == ["cancelled", "cancelled"]
    assert runs == ["cancelled"]
    assert queue(client, token) == {}
    assert claim(client, token)["task"] is None
    for answer in (heartbeat(client, token, claimed), submit(client, token, claimed)):
        refused(answer, "task_cancelled")
    # Nothing reached the domain or the review queue.
    assert session.scalar(select(func.count()).select_from(AgentTaskResult)) == 0
    for company in session.scalars(select(Company)).all():
        assert company.legal_name is None


def test_cancel_closes_pending_and_claimed_tasks_and_the_run(
    client: TestClient, db_session: Session
) -> None:
    first = add_company(db_session, display_name="2SN")
    second = add_company(db_session, display_name="Acme")
    mission_id = mission_with(client, first, second)
    token = mint(db_session)
    claimed = claim(client, token)

    set_status(client, mission_id, "cancelled")

    assert_cancelled_and_refused(client, db_session, mission_id, token, claimed)
    detail = client.get(f"{MISSIONS}/{mission_id}").json()
    assert detail["card"]["last_run_status"] == "cancelled"
    assert {task["status"] for task in detail["tasks"]} == {"cancelled"}
    # A release or a failure is refused the same way.
    for name in ("viper_release_task", "viper_fail_task"):
        answer = call(
            client,
            token,
            name,
            {"task_id": claimed["task_id"], "claim_id": claimed["claim_id"], "code": "x"},
        )
        refused(answer, "task_cancelled")


def test_cancel_via_mcp_has_the_same_effect(client: TestClient, db_session: Session) -> None:
    first = add_company(db_session, display_name="2SN")
    second = add_company(db_session, display_name="Acme")
    mission_id = mission_with(client, first, second)
    worker = mint(db_session)
    claimed = claim(client, worker)
    manager = assistant(db_session, OrganizationRole.MANAGER)

    answer = body(
        call(
            client,
            manager,
            "viper_set_mission_status",
            {"mission_id": mission_id, "status": "cancelled"},
        )
    )

    assert answer["card"]["status"] == "cancelled"
    assert_cancelled_and_refused(client, db_session, mission_id, worker, claimed)


def test_cancel_rejects_a_result_waiting_for_review(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    mission_id = mission_with(client, company)
    token = mint(db_session)
    result_id = body(submit(client, token, claim(client, token)))["result_id"]

    set_status(client, mission_id, "cancelled")

    db_session.expire_all()
    result = db_session.get(AgentTaskResult, result_id)
    assert result is not None
    assert (result.status, result.decision_note) == (
        AgentResultStatus.REJECTED,
        "mission_cancelled",
    )
    assert statuses(db_session, mission_id) == (["cancelled"], ["cancelled"])
    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})
    assert accepted.status_code == 409, accepted.text
    db_session.expire_all()
    saved = db_session.get(Company, company.id)
    assert saved is not None and saved.legal_name is None


def test_cancel_leaves_other_missions_alone(client: TestClient, db_session: Session) -> None:
    stopped = mission_with(client, add_company(db_session, display_name="2SN"), name="Stop")
    kept = mission_with(client, add_company(db_session, display_name="Acme"), name="Garde")
    token = mint(db_session)

    set_status(client, stopped, "cancelled")

    assert statuses(db_session, kept) == (["pending"], ["running"])
    assert queue(client, token) == {"update_company": 1}
    claimed = claim(client, token)
    assert claimed["mission"]["id"] == kept
    body(submit(client, token, claimed))


def test_pause_hides_the_queue_lets_a_claimed_task_finish_and_resume_offers_it_again(
    client: TestClient, db_session: Session
) -> None:
    first = add_company(db_session, display_name="2SN")
    second = add_company(db_session, display_name="Acme")
    mission_id = mission_with(client, first, second)
    token = mint(db_session)
    claimed = claim(client, token)

    set_status(client, mission_id, "paused")

    assert queue(client, token) == {}
    assert claim(client, token)["task"] is None
    # The task already claimed finishes normally.
    body(heartbeat(client, token, claimed))
    body(submit(client, token, claimed))
    assert statuses(db_session, mission_id) == (["pending", "submitted"], ["running"])

    set_status(client, mission_id, "active")

    assert queue(client, token) == {"update_company": 1}
    assert claim(client, token)["mission"]["id"] == mission_id


def test_pause_via_mcp_hides_the_queue(client: TestClient, db_session: Session) -> None:
    mission_id = mission_with(client, add_company(db_session, display_name="2SN"))
    worker = mint(db_session)
    member = assistant(db_session, OrganizationRole.MEMBER)

    body(
        call(
            client,
            member,
            "viper_set_mission_status",
            {"mission_id": mission_id, "status": "paused"},
        )
    )

    assert queue(client, worker) == {}
    assert claim(client, worker)["task"] is None
    body(
        call(
            client,
            member,
            "viper_set_mission_status",
            {"mission_id": mission_id, "status": "active"},
        )
    )
    assert claim(client, worker)["mission"]["id"] == mission_id


def test_delete_leaves_no_claimable_task_nor_reviewable_result(
    client: TestClient, db_session: Session
) -> None:
    first = add_company(db_session, display_name="2SN")
    second = add_company(db_session, display_name="Acme")
    mission_id = mission_with(client, first, second)
    token = mint(db_session)
    holding = claim(client, token)
    result_id = body(submit(client, token, holding))["result_id"]
    claimed = claim(client, token)

    response = client.delete(f"{MISSIONS}/{mission_id}")

    assert response.status_code == 204, response.text
    db_session.expire_all()
    assert {task.status for task in db_session.scalars(select(AgentTask))} == {
        AgentTaskStatus.CANCELLED
    }
    assert queue(client, token) == {}
    refused(submit(client, token, claimed), "task_cancelled")
    # The detached result is not offered as a tool-mode proposal and cannot be accepted.
    assert client.get(f"{MISSIONS}/proposals").json() == []
    result = db_session.get(AgentTaskResult, result_id)
    assert result is not None and result.status is AgentResultStatus.REJECTED
    assert client.post(f"/api/agents/results/{result_id}/accept", json={}).status_code == 409
    # The run went with the mission (FK cascade).
    assert db_session.scalar(select(func.count()).select_from(MissionRun)) == 0


def test_the_last_run_of_a_closed_recurrence_is_still_offered(
    client: TestClient, db_session: Session
) -> None:
    """`run_due` closes the mission (`done`) in the transaction that creates its last tasks."""
    mission = due_mission(
        client,
        db_session,
        add_company(db_session, display_name="2SN"),
        end_kind="after",
        max_runs=1,
    )
    token = mint(db_session)

    assert len(missions.run_due(db_session, now=datetime.now(UTC))) == 1
    db_session.refresh(mission)
    assert mission.status is MissionStatus.DONE

    assert queue(client, token) == {"update_company": 1}
    claimed = claim(client, token)
    assert claimed["mission"]["id"] == str(mission.id)
    body(submit(client, token, claimed))


def test_a_direct_update_does_not_wait_for_a_paused_mission(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    mission_id = mission_with(client, company)
    set_status(client, mission_id, "paused")
    token = mint(db_session)

    stored = body(
        call(
            client,
            token,
            "viper_update_company",
            {"company_id": str(company.id), "result": RESULT},
        )
    )

    assert stored["status"] == "pending_review"
    # The paused mission's task is untouched and still waits for the resume.
    assert statuses(db_session, mission_id) == (["pending"], ["running"])


def test_a_paused_mission_task_cannot_be_claimed_by_name(
    client: TestClient, db_session: Session
) -> None:
    mission_id = mission_with(client, add_company(db_session, display_name="2SN"))
    set_status(client, mission_id, "paused")
    db_session.expire_all()
    task = db_session.scalars(select(AgentTask)).one()
    agent = ActorContext(type=ActorType.AGENT, display="Agent", id=str(uuid.uuid4()))

    with pytest.raises(ConflictError, match="paused"):
        agent_missions.claim_specific(db_session, agent, task.id)

    set_status(client, mission_id, "active")
    db_session.expire_all()
    claimed = agent_missions.claim_specific(db_session, agent, task.id)
    assert claimed.status is AgentTaskStatus.CLAIMED
