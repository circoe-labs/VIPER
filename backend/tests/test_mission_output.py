"""Mission objective and output contract (Slice 04): the envelope a claimed task answers with,
omission of unchanged fields, `not_found` / `blocked` outcomes, and run-level objective
completion (one-off closes, recurring keeps its schedule). `result_limit` stays a cap."""

from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Mission
from app.models.agent_missions import AgentTask
from app.models.enums import AgentTaskType, MissionType
from app.models.missions import MissionRun
from app.services import mission_output
from app.services.agent_payloads import RESULT_MODELS
from app.services.errors import InvalidFieldError
from tests.builders import add_company
from tests.test_missions import MISSIONS, create, mint, rpc


def _claim(client: TestClient, db_session: Session, scope: str) -> tuple[str, dict[str, Any]]:
    token = mint(db_session, label=f"Agent {scope}", scopes=[scope])
    return token, rpc(client, token, "viper_claim_task", {})["structuredContent"]


def _submit(client: TestClient, token: str, payload: dict[str, Any], result: dict[str, Any]) -> Any:
    return rpc(
        client,
        token,
        "viper_submit_task_result",
        {"task_id": payload["task_id"], "claim_id": payload["claim_id"], "result": result},
    )


def _company(name: str, siren: str | None = None) -> dict[str, Any]:
    return {
        "display_name": name,
        "siren": siren,
        "confidence": 70,
        "evidence": [{"field": "display_name", "source": f"https://example.test/{name}"}],
    }


# --- contract generation ------------------------------------------------------------------------


def _contract(task_type: AgentTaskType, *, multiple: bool, limit: int | None) -> dict[str, Any]:
    return mission_output.output_contract(
        task_type,
        RESULT_MODELS[task_type].model_json_schema(),
        allow_multiple=multiple,
        result_limit=limit,
    )


def test_the_contract_is_deterministic_and_switches_envelope() -> None:
    single = _contract(AgentTaskType.FIND_PROSPECTS, multiple=False, limit=20)
    many = _contract(AgentTaskType.FIND_PROSPECTS, multiple=True, limit=20)

    assert single == _contract(AgentTaskType.FIND_PROSPECTS, multiple=False, limit=20)
    assert (single["envelope"], single["max_items"]) == ("single", 1)
    assert single["schema"]["properties"]["companies"]["maxItems"] == 1
    assert (many["envelope"], many["max_items"]) == ("list", 20)
    assert many["schema"]["properties"]["companies"]["maxItems"] == 20
    assert many["omit_unchanged"] is True
    assert "outcome" in single["schema"]["properties"]


def test_a_targeted_task_is_one_record_whatever_allow_multiple_says() -> None:
    contract = _contract(AgentTaskType.UPDATE_COMPANY, multiple=True, limit=20)

    assert contract["envelope"] == "single"
    assert contract["one_target_per_task"] is True
    assert contract["items_field"] is None


# --- claim payload and submission ---------------------------------------------------------------


def test_the_claim_carries_the_contract_and_one_item_is_the_default(
    client: TestClient, db_session: Session
) -> None:
    create(client, kind=MissionType.PROSPECTION, result_kind="companies", run_now=True)
    token, payload = _claim(client, db_session, "find_prospects")

    assert payload["output_contract"]["envelope"] == "single"
    assert payload["output_contract"]["version"] == mission_output.OUTPUT_CONTRACT_VERSION
    assert payload["output_schema"]["properties"]["companies"]["maxItems"] == 1
    assert payload["objective"] == {"kind": "tasks_accepted", "count": None}
    assert payload["mission"]["allow_multiple"] is False

    refused = _submit(
        client, token, payload, {"companies": [_company("A"), _company("B")], "confidence": 60}
    )

    assert refused["isError"] is True
    assert refused["structuredContent"]["code"] == "too_many"
    accepted = _submit(client, token, payload, {"companies": [_company("A")], "confidence": 60})
    assert accepted["isError"] is False, accepted["structuredContent"]


def test_allow_multiple_accepts_the_list_form(client: TestClient, db_session: Session) -> None:
    create(
        client,
        kind=MissionType.PROSPECTION,
        result_kind="companies",
        run_now=True,
        allow_multiple=True,
    )
    token, payload = _claim(client, db_session, "find_prospects")

    assert payload["output_contract"]["envelope"] == "list"
    submitted = _submit(
        client, token, payload, {"companies": [_company("A"), _company("B")], "confidence": 60}
    )
    assert submitted["isError"] is False, submitted["structuredContent"]


def test_unchanged_values_produce_no_diff(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN", website_url="https://2sn.fr")
    create(
        client,
        targets=[{"kind": "company", "id": str(company.id)}],
        run_now=True,
    )
    token, payload = _claim(client, db_session, "update_company")

    submitted = _submit(
        client,
        token,
        payload,
        {"website_url": "https://2sn.fr", "legal_name": "2SN SAS", "confidence": 80},
    )

    assert submitted["isError"] is False, submitted["structuredContent"]
    items = client.get(f"/api/agents/results/{submitted['structuredContent']['result_id']}").json()[
        "proposal"
    ]["items"]
    assert [item["field"] for item in items] == ["legal_name"]


def test_not_found_closes_the_task_without_inventing_data(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    detail = create(client, targets=[{"kind": "company", "id": str(company.id)}], run_now=True)
    token, payload = _claim(client, db_session, "update_company")

    with_data = _submit(
        client,
        token,
        payload,
        {"outcome": "not_found", "siren": "732829320", "notes": "rien", "confidence": 0},
    )
    assert with_data["structuredContent"]["code"] == "outcome_with_data"
    no_note = _submit(client, token, payload, {"outcome": "not_found", "confidence": 0})
    assert no_note["structuredContent"]["code"] == "missing"

    done = _submit(
        client,
        token,
        payload,
        {"outcome": "not_found", "notes": "Registre et site consultés, rien.", "confidence": 0},
    )

    assert done["isError"] is False, done["structuredContent"]
    assert done["structuredContent"]["summary"]["items"] == 0
    after = client.get(f"{MISSIONS}/{detail['card']['id']}").json()
    assert after["tasks"][0]["status"] == "accepted"
    # Nothing to apply: the answer is « nothing exists », and the one-off objective is met.
    assert after["card"]["status"] == "done"


def test_blocked_fails_the_task_and_leaves_the_mission_open(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    detail = create(client, targets=[{"kind": "company", "id": str(company.id)}], run_now=True)
    token, payload = _claim(client, db_session, "update_company")

    _submit(
        client,
        token,
        payload,
        {"outcome": "blocked", "notes": "Site derrière un mur de connexion.", "confidence": 0},
    )

    after = client.get(f"{MISSIONS}/{detail['card']['id']}").json()
    assert after["tasks"][0]["status"] == "failed"
    assert after["card"]["status"] == "active"
    assert after["runs"][0]["note"].startswith("Objectif non atteint")


# --- objective ----------------------------------------------------------------------------------


def test_a_one_off_mission_closes_only_when_its_objective_is_met(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    detail = create(client, targets=[{"kind": "company", "id": str(company.id)}], run_now=True)
    token, payload = _claim(client, db_session, "update_company")
    submitted = _submit(client, token, payload, {"website_url": "https://2sn.fr", "confidence": 80})
    result_id = submitted["structuredContent"]["result_id"]

    # Submitted is not accepted: a model's say-so never completes a mission.
    pending = client.get(f"{MISSIONS}/{detail['card']['id']}").json()
    assert pending["card"]["status"] == "active"
    assert pending["objective_progress"]["met"] is False

    assert client.post(f"/api/agents/results/{result_id}/accept", json={}).status_code == 200

    done = client.get(f"{MISSIONS}/{detail['card']['id']}").json()
    assert done["card"]["status"] == "done"
    assert done["objective_progress"]["met"] is True
    assert done["runs"][0]["objective_met_at"]


def test_a_recurring_run_meets_its_own_objective_and_the_mission_stays_scheduled(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    detail = create(
        client,
        targets=[{"kind": "company", "id": str(company.id)}],
        run_now=True,
        is_recurring=True,
        interval_count=1,
        interval_unit="days",
    )
    token, payload = _claim(client, db_session, "update_company")
    submitted = _submit(client, token, payload, {"website_url": "https://2sn.fr", "confidence": 80})
    client.post(
        f"/api/agents/results/{submitted['structuredContent']['result_id']}/accept", json={}
    )

    after = client.get(f"{MISSIONS}/{detail['card']['id']}").json()

    assert after["runs"][0]["objective_met_at"]
    assert after["card"]["status"] == "active"
    assert after["card"]["next_run_at"]


def test_a_new_run_snapshots_the_objective_and_history_is_immutable(
    client: TestClient, db_session: Session
) -> None:
    detail = create(
        client,
        kind=MissionType.PROSPECTION,
        result_kind="companies",
        run_now=True,
        objective={"kind": "accepted_items", "count": 3},
        allow_multiple=True,
    )
    mission_id = detail["card"]["id"]
    run = db_session.scalar(select(MissionRun).where(MissionRun.mission_id == mission_id))
    assert run is not None and run.config is not None
    assert run.config["objective"] == {"kind": "accepted_items", "count": 3}

    mission = db_session.get(Mission, mission_id)
    assert mission is not None
    mission.objective = {"kind": "accepted_items", "count": 9}
    db_session.flush()
    db_session.refresh(run)

    assert run.config["objective"]["count"] == 3


def test_objective_count_above_the_result_limit_raises_the_run_cap(client: TestClient) -> None:
    body = {
        "name": "Découverte",
        "type": "prospection",
        "prompt": "Trouve des sociétés.",
        "result_kind": "companies",
        "result_limit": 5,
        "objective": {"kind": "accepted_items", "count": 6},
    }

    response = client.post(MISSIONS, json=body)

    assert response.status_code == 201, response.text
    assert response.json()["rule"]["objective"] == {"kind": "accepted_items", "count": 6}
    ok = client.post(MISSIONS, json={**body, "objective": {"kind": "accepted_items", "count": 5}})
    assert ok.status_code == 201, ok.text
    assert ok.json()["result_limit"] == 5
    assert ok.json()["rule"]["objective"] == {"kind": "accepted_items", "count": 5}


def test_discovery_continues_one_item_at_a_time_until_the_objective(
    client: TestClient, db_session: Session
) -> None:
    detail = create(
        client,
        kind=MissionType.PROSPECTION,
        result_kind="companies",
        run_now=True,
        objective={"kind": "accepted_items", "count": 2},
    )
    mission_id = detail["card"]["id"]
    token = mint(db_session, label="Agent découverte", scopes=["find_prospects"])

    for index, name in enumerate(("Alpha SA", "Beta SA")):
        payload = rpc(client, token, "viper_claim_task", {})["structuredContent"]
        assert payload["task"] == "find_prospects", f"step {index}"
        submitted = _submit(
            client, token, payload, {"companies": [_company(name)], "confidence": 70}
        )
        assert submitted["isError"] is False, submitted["structuredContent"]
        result_id = submitted["structuredContent"]["result_id"]
        accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})
        assert accepted.status_code == 200, accepted.text
        midway = client.get(f"{MISSIONS}/{mission_id}").json()
        assert midway["card"]["status"] == ("active" if index == 0 else "done")

    tasks = db_session.scalars(select(AgentTask)).all()
    assert len(tasks) == 2


def test_the_objective_is_validated_before_it_is_stored() -> None:
    with pytest.raises(InvalidFieldError):
        mission_output.parse_objective({"kind": "accepted_items"})
    with pytest.raises(InvalidFieldError):
        mission_output.parse_objective({"kind": "tasks_accepted", "count": 2})
    assert mission_output.parse_objective(None) == mission_output.DEFAULT_OBJECTIVE
