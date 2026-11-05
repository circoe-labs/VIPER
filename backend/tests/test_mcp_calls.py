"""« Historique des appels » (Paramètres > MCP): who asked what on `/mcp`, by e-mail."""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api import mcp as mcp_api
from app.models.organizations import OrganizationRole
from app.services import mcp_calls, mcp_tokens
from tests.builders import add_company, add_user
from tests.test_mcp import call

CALLS = "/api/settings/mcp/calls"


def test_every_tool_call_is_kept_under_the_owner_email(
    client: TestClient, db_session: Session
) -> None:
    # A token lends its owner's rights only while that account exists (agent_capabilities).
    add_user(db_session, "marie@circoe.com", display_name="Marie", role=OrganizationRole.MEMBER)
    add_user(db_session, "paul@circoe.com", display_name="Paul", role=OrganizationRole.MEMBER)
    marie, _ = mcp_tokens.mint(
        db_session, label="Claude de Marie", scopes=["*"], owner_email="Marie@Circoe.com"
    )
    paul, _ = mcp_tokens.mint(
        db_session, label="ChatGPT de Paul", scopes=["*"], owner_email="paul@circoe.com"
    )
    company = add_company(db_session, display_name="2SN")

    call(client, marie, "viper_get_company", {"company_id": str(company.id)})
    refused = call(client, paul, "viper_get_company", {"company_id": str(uuid.uuid4())})
    assert refused["isError"] is True

    history = client.get(CALLS).json()
    assert history["emails"] == ["marie@circoe.com", "paul@circoe.com"]
    newest, oldest = history["calls"]
    assert (oldest["user_email"], oldest["agent"], oldest["tool"], oldest["outcome"]) == (
        "marie@circoe.com",
        "Claude de Marie",
        "viper_get_company",
        "ok",
    )
    assert oldest["arguments"] == {"company_id": str(company.id)}
    assert (newest["user_email"], newest["outcome"], newest["error_code"]) == (
        "paul@circoe.com",
        "refused",
        "not_found",
    )
    only_marie = client.get(CALLS, params={"email": "marie@circoe.com"}).json()["calls"]
    assert [row["agent"] for row in only_marie] == ["Claude de Marie"]


def test_the_history_pages_and_shortens_long_texts(client: TestClient, db_session: Session) -> None:
    token, _ = mcp_tokens.mint(db_session, label="Agent", scopes=["*"], owner_email="a@circoe.com")
    for _ in range(3):
        call(client, token, "viper_list_companies", {"search": "x" * 1000})

    first = client.get(CALLS, params={"limit": 2}).json()
    assert first["has_more"] is True
    stored = first["calls"][0]["arguments"]["search"]
    assert len(stored) == mcp_calls.TEXT_LIMIT + 1 and stored.endswith("…")
    rest = client.get(CALLS, params={"limit": 2, "before": first["calls"][-1]["created_at"]})
    assert len(rest.json()["calls"]) == 1
    assert rest.json()["has_more"] is False


def test_the_history_needs_a_session(anonymous_client: TestClient) -> None:
    assert anonymous_client.get(CALLS).status_code == 401


def test_a_crashing_tool_is_kept_as_error(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    token, _ = mcp_tokens.mint(db_session, label="Agent", scopes=["*"], owner_email="a@circoe.com")

    def crash(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("boom")

    monkeypatch.setattr(mcp_api.mcp_reads, "list_companies", crash)
    result = call(client, token, "viper_list_companies", {})
    assert result["isError"] is True
    assert result["structuredContent"]["code"] == "internal"

    (row,) = client.get(CALLS).json()["calls"]
    assert (row["user_email"], row["tool"], row["outcome"], row["error_code"]) == (
        "a@circoe.com",
        "viper_list_companies",
        "error",
        "internal",
    )
