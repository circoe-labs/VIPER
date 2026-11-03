"""Agents HTTP API (`/api/agents`): the threads a person opens, sees and organises."""

import uuid
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import AgentTask
from app.models.enums import AgentTaskStatus
from tests.builders import add_company, add_prospect

AGENTS = "/api/agents/threads"


def test_opening_a_company_review_creates_its_tasks(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    add_prospect(db_session, company, first_name="Marie", last_name="Dupont")

    response = client.post(AGENTS, json={"company_id": str(company.id)})

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["thread"]["title"] == "2SN"
    assert body["thread"]["company_name"] == "2SN"
    # Only the types an agent can complete are queued (P1: the company itself).
    assert body["thread"]["tasks_total"] == 1
    types = [task["type"] for task in body["tasks"]]
    assert types == ["update_company"]
    assert body["tasks"][0]["status"] == "pending"


def test_opening_twice_completes_the_same_thread(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")

    first = client.post(AGENTS, json={"company_id": str(company.id)})
    second = client.post(AGENTS, json={"company_id": str(company.id)})

    assert first.json()["thread"]["id"] == second.json()["thread"]["id"]
    listed = client.get(AGENTS).json()
    assert listed["total"] == 1


def test_the_cards_count_tasks_and_agents(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    add_prospect(db_session, company)
    created = client.post(AGENTS, json={"company_id": str(company.id)}).json()
    task = db_session.get(AgentTask, created["tasks"][0]["id"])
    assert task is not None
    task.status = AgentTaskStatus.CLAIMED
    # A claimed row needs its whole claim (the database CHECK).
    now = datetime.now(UTC)
    task.claim_id = uuid.uuid7()
    task.claimed_by_id = "claude-01"
    task.claimed_by_label = "Agent claude-01"
    task.claimed_at = now
    task.lease_expires_at = now
    db_session.flush()

    card = client.get(AGENTS).json()["items"][0]

    assert card["tasks_claimed"] == 1
    assert card["agents"] == ["Agent claude-01"]


def test_pausing_a_thread_is_audited_and_kept(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session)
    thread_id = client.post(AGENTS, json={"company_id": str(company.id)}).json()["thread"]["id"]

    response = client.patch(f"{AGENTS}/{thread_id}", json={"status": "paused"})

    assert response.status_code == 200, response.text
    assert response.json()["thread"]["status"] == "paused"
    assert client.get(AGENTS).json()["items"][0]["status"] == "paused"


def test_an_unknown_company_is_a_404(client: TestClient) -> None:
    response = client.post(AGENTS, json={"company_id": str(uuid.uuid4())})

    assert response.status_code == 404


@pytest.mark.parametrize(
    ("method", "path"),
    [("GET", AGENTS), ("POST", AGENTS), ("GET", f"{AGENTS}/00000000-0000-0000-0000-000000000000")],
)
def test_the_routes_require_a_session(anonymous_client: TestClient, method: str, path: str) -> None:
    assert anonymous_client.request(method, path).status_code == 401


def test_the_settings_page_lists_the_mcp_tools(client: TestClient) -> None:
    response = client.get("/api/settings/mcp")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["endpoint"] == "/mcp"
    tools = {tool["name"]: tool for tool in body["tools"]}
    assert "viper_claim_task" in tools
    claim = tools["viper_claim_task"]
    assert claim["description"]
    parameters = {item["name"]: item for item in claim["parameters"]}
    assert parameters["task_types"]["type"] == "liste de string"
    assert parameters["task_types"]["enum"] == [
        "update_company",
        "update_employee",
        "find_employees",
        "surveil_signals",
        "find_prospects",
    ]


def test_the_settings_page_shows_a_nullable_field_by_its_type(client: TestClient) -> None:
    """`anyOf: [{type: integer}, {type: null}]` is an integer, not an « objet »."""
    body = client.get("/api/settings/mcp").json()
    create = next(tool for tool in body["tools"] if tool["name"] == "viper_create_mission")
    types = {item["name"]: item["type"] for item in create["parameters"]}

    assert types["max_runs"] == "integer"
    assert types["agent_id"] == "string"
    assert "objet" not in types.values()


def test_the_settings_page_is_not_taken_by_the_taxonomy_route(client: TestClient) -> None:
    """`/settings/{taxonomy}` is a catch-all: the MCP route must be registered before it."""
    response = client.get("/api/settings/mcp")

    assert response.status_code == 200
    assert "tools" in response.json()
