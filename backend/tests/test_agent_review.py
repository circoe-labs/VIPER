"""Reviewing a proposal: accept applies the company changes, reject sends the task back.

The loop the product exists for: a person opens an analysis, an agent submits, the person accepts
— and the company is written by the ordinary company service, attributed to the person.
"""

import uuid
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import AgentTask, CommercialSegment, Company
from app.models.enums import AgentResultStatus, AgentTaskStatus
from app.services import mcp_tokens
from tests.builders import add_company, add_prospect


def mint(session: Session) -> str:
    token, _ = mcp_tokens.mint(session, label="Agent claude-01", scopes=["*"])
    return token


def call(client: TestClient, token: str, name: str, arguments: dict[str, Any]) -> Any:
    response = client.post(
        "/mcp",
        json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        },
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200, response.text
    result: dict[str, Any] = response.json()["result"]
    assert result["isError"] is False, result["structuredContent"]
    return result["structuredContent"]


def submitted(client: TestClient, session: Session, result: dict[str, Any]) -> str:
    """Open a review, claim it with a fresh agent, submit `result`; returns the result id."""
    company = add_company(session, display_name="2SN")
    add_prospect(session, company)
    created = client.post("/api/agents/threads", json={"company_id": str(company.id)})
    assert created.status_code == 201, created.text
    token = mint(session)
    payload = call(client, token, "viper_claim_task", {"task_types": ["update_company"]})
    answered = call(
        client,
        token,
        "viper_submit_task_result",
        {
            "task_id": payload["task_id"],
            "claim_id": payload["claim_id"],
            "result": result,
        },
    )
    return str(answered["result_id"])


def test_accepting_applies_the_accepted_items(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    add_prospect(db_session, company)
    created = client.post("/api/agents/threads", json={"company_id": str(company.id)}).json()
    token = mint(db_session)
    payload = call(client, token, "viper_claim_task", {"task_types": ["update_company"]})
    answered = call(
        client,
        token,
        "viper_submit_task_result",
        {
            "task_id": payload["task_id"],
            "claim_id": payload["claim_id"],
            "result": {
                "legal_name": "2SN SAS",
                "siren": "732829320",
                "confidence": 80,
                "evidence": [{"field": "legal_name", "source": "https://2sn.fr/mentions"}],
            },
        },
    )["result_id"]

    print("PROPOSAL", client.get(f"/api/agents/results/{answered}").json()["proposal"])
    response = client.post(
        f"/api/agents/results/{answered}/accept",
        json={"accepted_items": ["legal_name"], "note": "Raison sociale vérifiée"},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "accepted"
    assert body["applied"]["fields"] == ["legal_name"]
    db_session.expire_all()
    assert body["decision_note"] == "Raison sociale vérifiée"
    stored = db_session.get(Company, uuid.UUID(created["thread"]["company_id"]))
    assert stored is not None
    assert stored.legal_name == "2SN SAS"
    # The SIREN was not accepted: it stays empty.
    assert stored.siren is None
    task = db_session.get(AgentTask, uuid.UUID(payload["task_id"]))
    assert task is not None
    assert task.status is AgentTaskStatus.ACCEPTED


def test_accepting_a_taxonomy_by_label_stores_its_id(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    add_prospect(db_session, company)
    client.post("/api/settings/commercial-segments", json={"label": "Grands comptes"})
    created = client.post("/api/agents/threads", json={"company_id": str(company.id)}).json()
    token = mint(db_session)
    payload = call(client, token, "viper_claim_task", {"task_types": ["update_company"]})
    result_id = call(
        client,
        token,
        "viper_submit_task_result",
        {
            "task_id": payload["task_id"],
            "claim_id": payload["claim_id"],
            "result": {"commercial_segment": "Grands comptes", "confidence": 60},
        },
    )["result_id"]

    response = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert response.status_code == 200, response.text
    db_session.expire_all()
    stored = db_session.get(Company, uuid.UUID(created["thread"]["company_id"]))
    assert stored is not None
    segment = db_session.get(CommercialSegment, stored.commercial_segment_id)
    assert segment is not None
    assert segment.label == "Grands comptes"


def test_rejecting_requeues_the_task(client: TestClient, db_session: Session) -> None:
    result_id = submitted(client, db_session, {"legal_name": "2SN SAS", "confidence": 50})

    response = client.post(
        f"/api/agents/results/{result_id}/reject", json={"reason": "Source non fiable"}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "rejected"
    task = db_session.get(AgentTask, uuid.UUID(body["task_id"]))
    assert task is not None
    assert task.status is AgentTaskStatus.PENDING
    assert task.attempts == 1


def test_a_result_cannot_be_decided_twice(client: TestClient, db_session: Session) -> None:
    result_id = submitted(client, db_session, {"legal_name": "2SN SAS", "confidence": 50})
    assert client.post(f"/api/agents/results/{result_id}/accept", json={}).status_code == 200

    again = client.post(f"/api/agents/results/{result_id}/reject", json={"reason": "Trop tard"})

    assert again.status_code == 409


def test_rejecting_needs_a_reason(client: TestClient, db_session: Session) -> None:
    result_id = submitted(client, db_session, {"legal_name": "2SN SAS", "confidence": 50})

    response = client.post(f"/api/agents/results/{result_id}/reject", json={"reason": "  "})

    assert response.status_code == 422


def test_the_review_reads_the_proposal(client: TestClient, db_session: Session) -> None:
    result_id = submitted(client, db_session, {"legal_name": "2SN SAS", "confidence": 50})

    body = client.get(f"/api/agents/results/{result_id}").json()

    assert body["company_name"] == "2SN"
    assert body["proposal"]["items"][0]["after"] == "2SN SAS"
    assert body["status"] == AgentResultStatus.PENDING_REVIEW.value
