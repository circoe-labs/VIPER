"""MCP tool mode: reading the base, and posting a result without claiming a mission.

The two halves share one rule: a read never writes, and a write never applies. A proposal posted
through `viper_update_company` / `viper_update_prospect` lands in `agent_task_results` as
`pending_review`, exactly like a mission submission, and only a person's accept writes the base.
"""

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AgentTask, Company, Prospect
from app.models.enums import AgentTaskStatus
from app.services import mcp_tokens
from tests.builders import add_company, add_email, add_phone, add_prospect, add_role


def mint(session: Session, scopes: list[str] | None = None) -> str:
    token, _ = mcp_tokens.mint(session, label="Agent claude-01", scopes=scopes or ["*"])
    return token


def call(
    client: TestClient, token: str, name: str, arguments: dict[str, Any]
) -> dict[str, Any]:
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
    return result


def body(answer: dict[str, Any]) -> dict[str, Any]:
    assert answer["isError"] is False, answer["structuredContent"]
    content: dict[str, Any] = answer["structuredContent"]
    return content


def test_read_companies_and_one_company(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN", website_url="https://2sn.fr")
    role = add_role(db_session, label="RH")
    add_prospect(db_session, company, first_name="Marie", last_name="Dupont", role_id=role.id)
    token = mint(db_session)

    page = body(call(client, token, "viper_list_companies", {"search": "2SN"}))
    detail = body(call(client, token, "viper_get_company", {"company_id": str(company.id)}))

    assert page["total"] == 1
    assert page["companies"][0]["display_name"] == "2SN"
    assert page["companies"][0]["prospect_count"] == 1
    assert detail["id"] == str(company.id)
    assert detail["website_url"] == "https://2sn.fr"
    assert detail["prospects"][0]["name"] == "Marie Dupont"
    assert detail["prospects"][0]["role"] == "RH"
    # The Circoe-internal commercial columns stay out of an agent's read.
    assert "client_approach" not in detail


def test_read_prospects_by_company_and_one_record(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    other = add_company(db_session, display_name="Autre")
    marie = add_prospect(db_session, company, first_name="Marie", last_name="Dupont")
    add_email(db_session, marie, "marie@2sn.fr", is_primary=True, is_active=True)
    add_phone(db_session, marie, "+33600000000", is_primary=True, is_active=True)
    add_prospect(db_session, other, first_name="Paul", last_name="Martin")
    token = mint(db_session)

    page = body(call(client, token, "viper_list_prospects", {"company_ids": [str(company.id)]}))
    record = body(call(client, token, "viper_get_prospect", {"prospect_id": str(marie.id)}))

    assert page["total"] == 1
    assert page["prospects"][0]["name"] == "Marie Dupont"
    assert page["prospects"][0]["company"]["display_name"] == "2SN"
    assert page["prospects"][0]["primary_email"] == "marie@2sn.fr"
    assert record["company"]["display_name"] == "2SN"
    assert record["emails"][0]["address"] == "marie@2sn.fr"
    assert record["phones"][0]["number"] == "+33600000000"
    assert record["version"]


def test_an_unknown_company_is_a_clean_refusal(client: TestClient, db_session: Session) -> None:
    token = mint(db_session)

    answer = call(
        client, token, "viper_get_company", {"company_id": "01a18922-0000-7000-8000-000000000000"}
    )

    assert answer["isError"] is True
    assert answer["structuredContent"]["code"] == "not_found"


def test_update_company_stores_a_proposal_and_only_a_person_writes(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    token = mint(db_session)

    answer = call(
        client,
        token,
        "viper_update_company",
        {
            "company_id": str(company.id),
            "result": {"legal_name": "2SN SAS", "confidence": 80},
        },
    )

    stored = body(answer)
    assert stored["status"] == "pending_review"
    assert stored["summary"]["items"] == 1
    db_session.expire_all()
    before = db_session.get(Company, company.id)
    assert before is not None
    assert before.legal_name is None
    task = db_session.scalar(select(AgentTask).where(AgentTask.company_id == company.id))
    assert task is not None
    assert task.status is AgentTaskStatus.SUBMITTED

    accepted = client.post(f"/api/agents/results/{stored['result_id']}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["applied"]["fields"] == ["legal_name"]
    db_session.expire_all()
    after = db_session.get(Company, company.id)
    assert after is not None
    assert after.legal_name == "2SN SAS"


def test_a_second_tool_proposal_waits_for_the_first_review(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    token = mint(db_session)
    first = call(
        client,
        token,
        "viper_update_company",
        {"company_id": str(company.id), "result": {"legal_name": "2SN SAS", "confidence": 80}},
    )
    assert first["isError"] is False

    again = call(
        client,
        token,
        "viper_update_company",
        {"company_id": str(company.id), "result": {"siren": "123456789", "confidence": 80}},
    )

    assert again["isError"] is True
    assert again["structuredContent"]["code"] == "conflict"


def test_update_prospect_stores_a_proposal_and_only_a_person_writes(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    role = add_role(db_session, label="RH")
    prospect = add_prospect(db_session, company, first_name="Marie", last_name="Dupont")
    add_email(db_session, prospect, "marie@old.example", is_primary=True, is_active=True)
    token = mint(db_session)

    answer = call(
        client,
        token,
        "viper_update_prospect",
        {
            "prospect_id": str(prospect.id),
            "result": {
                "exact_job_title": "Directrice RH",
                "role": "RH",
                "emails": ["marie@2sn.fr"],
                "confidence": 70,
            },
        },
    )

    stored = body(answer)
    assert stored["status"] == "pending_review"
    assert stored["summary"]["items"] == 3
    db_session.expire_all()
    before = db_session.get(Prospect, prospect.id)
    assert before is not None
    assert before.exact_job_title is None

    accepted = client.post(f"/api/agents/results/{stored['result_id']}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    db_session.expire_all()
    saved = db_session.get(Prospect, prospect.id)
    assert saved is not None
    assert saved.exact_job_title == "Directrice RH"
    assert saved.role_id == role.id
    assert {email.address for email in saved.emails} == {"marie@old.example", "marie@2sn.fr"}


def test_a_token_scope_still_bounds_the_tool_proposals(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    prospect = add_prospect(db_session, company)
    token = mint(db_session, scopes=["update_company"])

    refused = call(
        client,
        token,
        "viper_update_prospect",
        {
            "prospect_id": str(prospect.id),
            "result": {"exact_job_title": "RH", "confidence": 50},
        },
    )

    assert refused["isError"] is True
    assert refused["structuredContent"]["code"] == "not_allowed"
