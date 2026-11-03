"""`/mcp` UI resources: the mission card template, its listing, and the metadata that ties it to
`viper_create_mission` (doc/architecture/mcp-server.md §3.11)."""

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api import mcp_ui
from app.models.organizations import OrganizationRole
from app.services import agent_capabilities as caps
from tests.builders import add_company
from tests.test_mcp_missions import assistant, enrichment
from tests.test_mcp_tools import body, call
from tests.test_mcp_tools import mint as mint_worker

URI = mcp_ui.MISSION_CARD_URI


def rpc(client: TestClient, token: str, method: str, params: Any = None) -> dict[str, Any]:
    message: dict[str, Any] = {"jsonrpc": "2.0", "id": 7, "method": method}
    if params is not None:
        message["params"] = params
    response = client.post("/mcp", json=message, headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200, response.text
    answer: dict[str, Any] = response.json()
    return answer


def test_initialize_announces_resources(client: TestClient, db_session: Session) -> None:
    token = assistant(db_session)

    capabilities = rpc(client, token, "initialize")["result"]["capabilities"]

    assert capabilities["resources"] == {"listChanged": False, "subscribe": False}
    assert capabilities["tools"] == {"listChanged": False}


def test_the_mission_card_is_listed_and_read(client: TestClient, db_session: Session) -> None:
    token = assistant(db_session)

    listed = rpc(client, token, "resources/list")["result"]["resources"]
    contents = rpc(client, token, "resources/read", {"uri": URI})["result"]["contents"]

    assert [(item["uri"], item["mimeType"]) for item in listed] == [
        (URI, "text/html;profile=mcp-app")
    ]
    assert listed[0]["_meta"]["ui"]["prefersBorder"] is True
    assert listed[0]["_meta"]["ui"]["csp"] == {"connectDomains": [], "resourceDomains": []}
    [content] = contents
    assert content["uri"] == URI
    assert content["mimeType"] == "text/html;profile=mcp-app"
    html = content["text"]
    assert html.startswith("<!doctype html>")
    assert '<html lang="fr">' in html
    for label in ("Créer", "Créer et lancer", "Modifier les paramètres"):
        assert f">{label}</button>" in html
    # Self-contained: the sandbox allows no network, so nothing is fetched from elsewhere.
    assert "<script src" not in html
    assert "<link" not in html
    assert "http://" not in html and "https://" not in html


def test_an_unknown_resource_is_a_json_rpc_error(client: TestClient, db_session: Session) -> None:
    token = assistant(db_session)

    for params in ({"uri": "ui://viper/unknown.html"}, {}, None):
        answer = rpc(client, token, "resources/read", params)
        assert answer["error"]["code"] == -32002, answer
        assert "result" not in answer


def test_resources_need_a_token(client: TestClient) -> None:
    response = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "resources/list"})

    assert response.status_code == 401


def test_a_worker_reads_the_card_too(client: TestClient, db_session: Session) -> None:
    # A static template holds no data: no capability is needed to read it.
    token = mint_worker(db_session)

    answer = rpc(client, token, "resources/read", {"uri": URI})

    assert answer["result"]["contents"][0]["uri"] == URI


def tools(client: TestClient, token: str) -> dict[str, dict[str, Any]]:
    listed = rpc(client, token, "tools/list")["result"]["tools"]
    return {tool["name"]: tool for tool in listed}


def test_create_mission_carries_the_card_template(client: TestClient, db_session: Session) -> None:
    listed = tools(client, assistant(db_session))

    meta = listed["viper_create_mission"]["_meta"]
    assert meta["ui"] == {"resourceUri": URI}
    assert meta["openai/outputTemplate"] == URI
    assert meta["openai/widgetAccessible"] is True
    for key in ("openai/toolInvocation/invoking", "openai/toolInvocation/invoked"):
        assert 0 < len(meta[key]) <= 64
    # The tools the card calls are reachable from it; no other tool renders the card.
    for name in ("viper_mission_options", "viper_update_mission", "viper_run_mission"):
        assert listed[name]["_meta"] == {"openai/widgetAccessible": True}
    others = {
        name
        for name, tool in listed.items()
        if "ui" in tool.get("_meta", {}) or "openai/outputTemplate" in tool.get("_meta", {})
    }
    assert others == {"viper_create_mission"}
    # The schema and annotations are untouched: a client that ignores `_meta` sees the same tool.
    assert listed["viper_create_mission"]["annotations"]["readOnlyHint"] is False
    assert listed["viper_create_mission"]["inputSchema"]["required"] == ["name", "type", "prompt"]


def test_a_created_mission_result_points_to_the_card(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    token = assistant(db_session)

    answer = call(client, token, "viper_create_mission", enrichment(company.id))

    detail = body(answer)
    assert detail["card"]["name"] == "Compléter 2SN"
    assert answer["_meta"] == {"ui": {"resourceUri": URI}, "openai/outputTemplate": URI}


def test_a_refused_creation_still_renders_the_card_with_the_server_error(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    token = assistant(db_session)

    answer = call(client, token, "viper_create_mission", enrichment(company.id, result_limit=9999))

    assert answer["isError"] is True
    assert answer["structuredContent"]["field"] == "result_limit"
    assert answer["structuredContent"]["code"] == "invalid"
    assert answer["_meta"]["openai/outputTemplate"] == URI


def test_authorization_is_unchanged_when_the_card_calls(
    client: TestClient, db_session: Session
) -> None:
    # The card calls `tools/call` like the model does: an agent without `missions.run` cannot
    # « Créer et lancer » from it.
    company = add_company(db_session, display_name="2SN")
    token = assistant(
        db_session,
        role=OrganizationRole.MEMBER,
        capabilities=[caps.MISSIONS_READ, caps.MISSIONS_WRITE],
    )

    answer = call(client, token, "viper_create_mission", enrichment(company.id, run_now=True))

    assert answer["isError"] is True
    assert answer["structuredContent"]["code"] == "capability_denied"
    assert answer["structuredContent"]["capability"] == caps.MISSIONS_RUN


def test_other_tool_results_carry_no_card(client: TestClient, db_session: Session) -> None:
    answer = call(client, assistant(db_session), "viper_mission_options", {})

    assert "_meta" not in answer
