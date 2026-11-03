"""MCP conversational reads: an assistant reads the same figures, in the same shape, as the page.

Each tool is compared with the REST endpoint backing the same screen, and checked on one figure the
test data makes certain. None of them writes; every one is declared read-only to the host.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api import mcp_conversational
from app.models import ContactMessage
from app.models.enums import ContactMessageStatus, MissionType
from tests.builders import add_company, add_email, add_prospect, start_sequence
from tests.test_mcp_tools import body, call, mint
from tests.test_missions import create

CAPABILITIES = {
    "viper_search": "records.read",
    "viper_get_dashboard": "dashboard.read",
    "viper_get_prospection_metrics": "dashboard.read",
    "viper_list_missions": "missions.read",
    "viper_get_mission": "missions.read",
    "viper_list_pending_reviews": "reviews.read",
    "viper_get_contact_overview": "contact.read",
    "viper_get_prospect_messages": "contact.read",
}


def rest(client: TestClient, path: str, **params: Any) -> dict[str, Any]:
    response = client.get(f"/api{path}", params=params)
    assert response.status_code == 200, response.text
    answer: dict[str, Any] = response.json()
    return answer


def test_every_read_tool_is_listed_read_only_with_its_capability(
    client: TestClient, db_session: Session
) -> None:
    token = mint(db_session)
    response = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={"Authorization": f"Bearer {token}"},
    )
    listed = {tool["name"]: tool for tool in response.json()["result"]["tools"]}

    assert {tool.name: tool.capability for tool in mcp_conversational.TOOLS} == CAPABILITIES
    for name in CAPABILITIES:
        assert listed[name]["annotations"] == {
            "readOnlyHint": True,
            "destructiveHint": False,
            "openWorldHint": False,
        }
        assert listed[name]["inputSchema"]["type"] == "object"


def test_search_finds_a_company_and_its_people(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="Renault Trucks")
    add_prospect(db_session, company, first_name="Marie", last_name="Renaudin")
    token = mint(db_session)

    found = body(call(client, token, "viper_search", {"query": "Renau"}))

    assert found == rest(client, "/search", q="Renau")
    groups = {group["type"]: group["items"] for group in found["groups"]}
    assert groups["company"][0]["id"] == str(company.id)
    assert groups["prospect"][0]["company_name"] == "Renault Trucks"


def test_search_refuses_a_one_letter_query(client: TestClient, db_session: Session) -> None:
    token = mint(db_session)

    answer = call(client, token, "viper_search", {"query": "R"})

    assert answer["isError"] is True
    assert answer["structuredContent"]["field"] == "q"


def test_dashboard_equals_the_home_page(client: TestClient, db_session: Session) -> None:
    add_prospect(db_session, add_company(db_session), first_name="Jean")
    token = mint(db_session)

    dashboard = body(call(client, token, "viper_get_dashboard", {}))

    home = rest(client, "/home")
    assert dashboard["counts"] == home["counts"]
    assert dashboard["companies"] == home["companies"] == 1
    assert dashboard["counts"]["all"] == 1
    assert dashboard["progress"] == home["progress"]


def test_prospection_metrics_and_recent_additions(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session)
    add_prospect(db_session, company, first_name="Nouveau")
    old = add_prospect(db_session, company, first_name="Ancien")
    old.created_at = datetime.now(UTC) - timedelta(days=30)
    db_session.flush()
    token = mint(db_session)

    metrics = body(
        call(
            client,
            token,
            "viper_get_prospection_metrics",
            {"added_within_days": 7, "segment": "never_verified"},
        )
    )

    assert metrics["overview"] == rest(client, "/prospection/overview")
    assert metrics["counters"] == rest(client, "/prospection/counters")
    assert metrics["overview"]["total"] == 2
    assert metrics["segment"] == {"key": "never_verified", "count": 2}
    assert metrics["added"]["days"] == 7
    assert metrics["added"]["total"] == 1
    assert metrics["added"]["counts"]["all"] == 1
    assert metrics["added"]["segment_count"] == 1


def test_prospection_metrics_refuse_an_unknown_segment(
    client: TestClient, db_session: Session
) -> None:
    token = mint(db_session)

    answer = call(client, token, "viper_get_prospection_metrics", {"segment": "nope"})

    assert answer["isError"] is True
    assert answer["structuredContent"]["field"] == "segment"


def test_missions_list_and_detail(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    created = create(client, targets=[{"kind": "company", "id": str(company.id)}], run_now=True)
    create(
        client,
        name="Veille",
        kind=MissionType.SIGNALS,
        targets=[{"kind": "company", "id": str(company.id)}],
        result_kind="signals",
    )
    token = mint(db_session)

    listed = body(call(client, token, "viper_list_missions", {}))
    enrichment = body(call(client, token, "viper_list_missions", {"type": "enrichment"}))
    detail = body(call(client, token, "viper_get_mission", {"mission_id": created["card"]["id"]}))

    assert listed == rest(client, "/missions")
    assert listed["total"] == 2
    assert enrichment["total"] == 1
    assert enrichment["items"][0]["name"] == "Compléter les fiches"
    assert detail == rest(client, f"/missions/{created['card']['id']}")
    assert len(detail["tasks"]) == 1
    assert detail["targets"][0]["label"] == "2SN"


def test_pending_reviews_count_tool_proposals_and_mission_results(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    token = mint(db_session)
    stored = body(
        call(
            client,
            token,
            "viper_update_company",
            {"company_id": str(company.id), "result": {"legal_name": "2SN SAS", "confidence": 80}},
        )
    )

    pending = body(call(client, token, "viper_list_pending_reviews", {}))

    assert pending["total"] == 1
    assert pending["missions"] == []
    proposal = pending["proposals"][0]
    assert proposal["result_id"] == stored["result_id"]
    assert proposal["subject_label"] == "2SN"
    assert proposal["submitted_by_label"] == "Agent claude-01"
    assert proposal["digest"]
    rest_rows = client.get("/api/missions/proposals").json()
    assert {key: proposal[key] for key in rest_rows[0]} == rest_rows[0]


def test_contact_overview_equals_the_contact_pages(client: TestClient, db_session: Session) -> None:
    prospect = add_prospect(db_session, add_company(db_session), first_name="Jean")
    add_email(db_session, prospect, "jean@exemple.example", is_primary=True)
    start_sequence(db_session, prospect)
    token = mint(db_session)

    overview = body(call(client, token, "viper_get_contact_overview", {}))

    assert overview["dashboard"] == rest(client, "/contact/dashboard")
    assert overview["scheduling"] == rest(client, "/contact/scheduling")
    # The cohort S41 started in October: the Contact of this sequence is due.
    assert overview["dashboard"]["to_send"]["total"] == 1
    assert overview["dashboard"]["dispatch"]["active"] is False


def test_contact_overview_refuses_a_malformed_week(client: TestClient, db_session: Session) -> None:
    token = mint(db_session)

    answer = call(client, token, "viper_get_contact_overview", {"week": "2026-W99"})

    assert answer["isError"] is True
    assert answer["structuredContent"]["field"] == "week"


def test_prospect_messages_show_the_sequence_and_its_draft(
    client: TestClient, db_session: Session
) -> None:
    prospect = add_prospect(db_session, add_company(db_session), first_name="Jean")
    add_email(db_session, prospect, "jean@exemple.example", is_primary=True)
    sequence = start_sequence(db_session, prospect)
    db_session.add(
        ContactMessage(
            prospect_id=prospect.id,
            sequence_id=sequence.id,
            rank=0,
            status=ContactMessageStatus.DRAFT,
            to_recipients=["jean@exemple.example"],
            subject="Bonjour",
            body_text="Premier contact.",
        )
    )
    db_session.flush()
    token = mint(db_session)

    messages = body(
        call(client, token, "viper_get_prospect_messages", {"prospect_id": str(prospect.id)})
    )

    assert messages == rest(client, f"/prospects/{prospect.id}/messages")
    contact = messages["steps"][0]["message"]
    assert (contact["status"], contact["subject"], contact["to"]) == (
        "draft",
        "Bonjour",
        ["jean@exemple.example"],
    )
    assert messages["sequence"]["next_step"] == "contact"


def test_an_unknown_prospect_is_a_clean_refusal(client: TestClient, db_session: Session) -> None:
    token = mint(db_session)

    answer = call(
        client,
        token,
        "viper_get_prospect_messages",
        {"prospect_id": "00000000-0000-0000-0000-000000000000"},
    )

    assert answer["isError"] is True
    assert answer["structuredContent"]["code"] == "not_found"
