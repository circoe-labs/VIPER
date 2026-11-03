"""The MCP endpoint: transport, authentication, and the six tools an agent uses.

The loop under test is the one that matters: a person opens an analysis, an agent claims a task,
submits a result, and the task waits for a review — nothing is written to the company.
"""

import uuid
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import AgentTask, AgentTaskResult
from app.models.enums import AgentTaskStatus
from app.services import mcp_tokens
from tests.builders import add_company, add_prospect


def mint(session: Session, scopes: list[str] | None = None) -> str:
    token, _ = mcp_tokens.mint(session, label="Agent claude-01", scopes=scopes or ["*"])
    return token


def rpc(client: TestClient, token: str, method: str, params: dict[str, Any] | None = None) -> Any:
    body: dict[str, Any] = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    return client.post("/mcp", json=body, headers={"Authorization": f"Bearer {token}"})


def call(client: TestClient, token: str, name: str, arguments: dict[str, Any]) -> Any:
    response = rpc(client, token, "tools/call", {"name": name, "arguments": arguments})
    assert response.status_code == 200, response.text
    return response.json()["result"]


def open_review(client: TestClient, session: Session) -> dict[str, Any]:
    company = add_company(session, display_name="2SN")
    add_prospect(session, company)
    response = client.post("/api/agents/threads", json={"company_id": str(company.id)})
    assert response.status_code == 201, response.text
    detail: dict[str, Any] = response.json()
    return detail


def test_initialize_and_tools_list(client: TestClient, db_session: Session) -> None:
    token = mint(db_session)

    hello = rpc(client, token, "initialize").json()["result"]
    tools = rpc(client, token, "tools/list").json()["result"]["tools"]

    assert hello["protocolVersion"]
    assert hello["serverInfo"]["name"] == "VIPER"
    assert [tool["name"] for tool in tools] == [
        "viper_whoami",
        "viper_claim_task",
        "viper_heartbeat_task",
        "viper_submit_task_result",
        "viper_fail_task",
        "viper_release_task",
        "viper_task_queue",
        "viper_list_companies",
        "viper_get_company",
        "viper_list_prospects",
        "viper_get_prospect",
        "viper_update_company",
        "viper_update_prospect",
        "viper_search",
        "viper_get_dashboard",
        "viper_get_prospection_metrics",
        "viper_list_missions",
        "viper_get_mission",
        "viper_list_pending_reviews",
        "viper_get_contact_overview",
        "viper_get_prospect_messages",
    ]
    assert tools[0]["inputSchema"]["type"] == "object"


def test_a_missing_or_unknown_token_is_refused(client: TestClient) -> None:
    assert (
        client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"}).status_code == 401
    )

    response = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "ping"},
        headers={"Authorization": "Bearer viper_nope"},
    )

    assert response.status_code == 401


def test_claim_returns_the_mission_payload(client: TestClient, db_session: Session) -> None:
    detail = open_review(client, db_session)
    token = mint(db_session)

    result = call(client, token, "viper_claim_task", {"task_types": ["update_company"]})

    assert result["isError"] is False
    payload = result["structuredContent"]
    assert payload["task"] == "update_company"
    assert payload["task_id"] in [task["id"] for task in detail["tasks"]]
    assert uuid.UUID(payload["claim_id"])
    assert payload["company_data"]["display_name"] == "2SN"
    assert payload["output_schema"]["properties"]["siren"]
    assert payload["lease"]["expires_at"]


def test_a_scoped_token_never_sees_another_type(client: TestClient, db_session: Session) -> None:
    open_review(client, db_session)
    other = mint(db_session, scopes=["update_employee"])

    # Nothing of its own type is queued, and it may not widen its scope by asking.
    assert call(client, other, "viper_claim_task", {})["structuredContent"]["task"] is None
    assert call(client, other, "viper_claim_task", {"task_types": ["update_company"]})["isError"]

    allowed = mint(db_session, scopes=["update_company"])
    mine = call(client, allowed, "viper_claim_task", {"task_types": ["update_company"]})
    assert mine["isError"] is False, mine["structuredContent"]
    assert mine["structuredContent"]["task"] == "update_company"


def test_submit_stores_a_proposal_and_waits_for_review(
    client: TestClient, db_session: Session
) -> None:
    detail = open_review(client, db_session)
    token = mint(db_session)
    claimed = call(client, token, "viper_claim_task", {"task_types": ["update_company"]})
    payload = claimed["structuredContent"]

    result = call(
        client,
        token,
        "viper_submit_task_result",
        {
            "task_id": payload["task_id"],
            "claim_id": payload["claim_id"],
            "result": {"legal_name": "2SN SAS", "confidence": 70},
        },
    )

    assert result["isError"] is False
    stored = result["structuredContent"]
    assert stored["status"] == "pending_review"
    assert stored["summary"]["items"] == 1
    task = db_session.get(AgentTask, uuid.UUID(payload["task_id"]))
    assert task is not None
    assert task.status is AgentTaskStatus.SUBMITTED
    results = db_session.query(AgentTaskResult).filter_by(task_id=task.id).all()
    assert len(results) == 1
    # The thread now shows it as waiting for a person.
    refreshed = client.get(f"/api/agents/threads/{detail['thread']['id']}").json()
    assert refreshed["thread"]["tasks_submitted"] == 1


def test_an_invalid_result_is_refused_and_the_lease_kept(
    client: TestClient, db_session: Session
) -> None:
    open_review(client, db_session)
    token = mint(db_session)
    payload = call(client, token, "viper_claim_task", {"task_types": ["update_company"]})[
        "structuredContent"
    ]

    result = call(
        client,
        token,
        "viper_submit_task_result",
        {
            "task_id": payload["task_id"],
            "claim_id": payload["claim_id"],
            "result": {"confidence": 200},
        },
    )

    assert result["isError"] is True
    assert result["structuredContent"]["code"] == "schema"
    task = db_session.get(AgentTask, uuid.UUID(payload["task_id"]))
    assert task is not None
    assert task.status is AgentTaskStatus.CLAIMED


def test_fail_requeues_and_queue_counts(client: TestClient, db_session: Session) -> None:
    open_review(client, db_session)
    token = mint(db_session)
    payload = call(client, token, "viper_claim_task", {"task_types": ["update_company"]})[
        "structuredContent"
    ]

    failed = call(
        client,
        token,
        "viper_fail_task",
        {"task_id": payload["task_id"], "claim_id": payload["claim_id"], "code": "blocked"},
    )
    queue = call(client, token, "viper_task_queue", {})

    assert failed["structuredContent"]["status"] == "pending"
    assert queue["structuredContent"]["tasks"]["update_company"] == 1


def test_a_lost_claim_is_refused(client: TestClient, db_session: Session) -> None:
    open_review(client, db_session)
    token = mint(db_session)
    payload = call(client, token, "viper_claim_task", {"task_types": ["update_company"]})[
        "structuredContent"
    ]

    result = call(
        client,
        token,
        "viper_submit_task_result",
        {
            "task_id": payload["task_id"],
            "claim_id": str(uuid.uuid7()),
            "result": {"confidence": 50},
        },
    )

    assert result["isError"] is True
    assert result["structuredContent"]["code"] == "conflict"


def test_an_unknown_method_is_a_jsonrpc_error(client: TestClient, db_session: Session) -> None:
    token = mint(db_session)

    response = rpc(client, token, "resources/list").json()

    assert response["error"]["code"] == -32601


def test_notifications_are_acknowledged_without_a_body(
    client: TestClient, db_session: Session
) -> None:
    token = mint(db_session)

    response = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "method": "notifications/initialized"},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 202
    assert response.content == b""
