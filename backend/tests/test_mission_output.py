"""« Nombre de tâches » and the output contract: a run holds one task per wanted item, claimable
in parallel; siblings do not find the same thing twice; a one-off mission closes when every task
is finished (accepted, rejected or nothing found), without replacement tasks."""

import uuid
from collections import Counter
from time import perf_counter
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.agent_missions import AgentTask
from app.models.enums import AgentTaskStatus, AgentTaskType, MissionType
from app.models.missions import MissionRun
from app.services import mission_output
from app.services.agent_payloads import RESULT_MODELS
from tests.builders import add_company, add_prospect
from tests.test_mcp_missions import assistant
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


def _companies(*names: str) -> dict[str, Any]:
    return {"companies": [_company(name) for name in names], "confidence": 60}


def _person(first: str, last: str) -> dict[str, Any]:
    return {
        "people": [
            {
                "first_name": first,
                "last_name": last,
                "confidence": 70,
                "evidence": [{"field": "first_name", "source": "https://example.test/team"}],
            }
        ],
        "confidence": 70,
    }


def _discovery(client: TestClient, count: int, **extra: Any) -> dict[str, Any]:
    return create(
        client,
        name="Découverte",
        kind=MissionType.PROSPECTION,
        result_kind="companies",
        run_now=True,
        task_count=count,
        **extra,
    )


def _detail(client: TestClient, mission: dict[str, Any]) -> dict[str, Any]:
    body: dict[str, Any] = client.get(f"{MISSIONS}/{mission['card']['id']}").json()
    return body


def _decide(client: TestClient, submitted: Any, *, accept: bool = True) -> None:
    result_id = submitted["structuredContent"]["result_id"]
    path = f"/api/agents/results/{result_id}/{'accept' if accept else 'reject'}"
    response = client.post(path, json={} if accept else {"reason": "Hors cible"})
    assert response.status_code == 200, response.text


# --- the contract -------------------------------------------------------------------------------


def test_a_discovery_task_of_a_run_takes_one_item_and_other_tasks_their_schema() -> None:
    def contract(task_type: AgentTaskType, rule: dict[str, Any] | None) -> dict[str, Any]:
        return mission_output.output_contract(
            task_type, RESULT_MODELS[task_type].model_json_schema(), rule
        )

    one = contract(AgentTaskType.FIND_PROSPECTS, {"items_per_task": 1})
    assert (one["envelope"], one["max_items"]) == ("single", 1)
    assert one["schema"]["properties"]["companies"]["maxItems"] == 1
    assert contract(AgentTaskType.FIND_EMPLOYEES, {})["max_items"] == 1
    # A « Dépôt » drop or a run migrated from the list mode, a tool-mode task, signal monitoring.
    assert contract(AgentTaskType.FIND_PROSPECTS, {"items_per_task": 20})["max_items"] == 20
    assert contract(AgentTaskType.FIND_EMPLOYEES, None)["max_items"] == 20
    assert contract(AgentTaskType.SURVEIL_SIGNALS, {"items_per_task": 1})["max_items"] == 50
    update = contract(AgentTaskType.UPDATE_COMPANY, {"items_per_task": 20})
    assert (update["max_items"], update["one_target_per_task"]) == (1, True)


# --- the number of tasks ------------------------------------------------------------------------


def test_a_run_creates_the_asked_number_of_tasks_claimable_in_parallel(
    client: TestClient, db_session: Session
) -> None:
    mission = _discovery(client, 50)

    assert mission["rule"]["task_count"] == 50
    assert len(mission["tasks"]) == 50
    assert mission["card"]["tasks_total"] == 50 and mission["card"]["tasks_done"] == 0
    claims = [_claim(client, db_session, "find_prospects")[1] for _ in range(3)]
    assert len({claim["task_id"] for claim in claims}) == 3
    assert claims[0]["output_contract"]["max_items"] == 1
    assert claims[0]["mission"]["task_count"] == 50
    assert "exactly ONE" in claims[0]["instruction"]
    run = db_session.scalars(select(MissionRun)).one()
    assert run.tasks_total == 50


def test_contacts_are_spread_evenly_over_the_linked_companies(
    client: TestClient, db_session: Session
) -> None:
    targets = [
        {"kind": "company", "id": str(add_company(db_session, display_name=name).id)}
        for name in ("Alpha", "Beta", "Gamma")
    ]
    body = {
        "name": "Trouver des prospects",
        "type": "prospection",
        "prompt": "Trouve des responsables logistiques.",
        "result_kind": "prospects",
        "targets": targets,
    }

    too_few = client.post(MISSIONS, json={**body, "task_count": 2})
    assert too_few.status_code == 422
    assert too_few.json()["detail"]["field"] == "task_count"

    mission = client.post(MISSIONS, json={**body, "task_count": 50}).json()

    spread = Counter(task["company_name"] for task in mission["tasks"])
    assert spread == {"Alpha": 17, "Beta": 17, "Gamma": 16}
    # Left out: one per linked company.
    natural = client.post(MISSIONS, json=body).json()
    assert natural["rule"]["task_count"] == 3 and len(natural["tasks"]) == 3


def test_work_on_linked_records_is_one_task_per_record(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    prospect = add_prospect(db_session, company)

    mission = create(
        client,
        targets=[
            {"kind": "company", "id": str(company.id)},
            {"kind": "prospect", "id": str(prospect.id)},
        ],
        run_now=True,
        task_count=40,
    )

    assert mission["rule"]["task_count"] == 2
    assert sorted(task["type"] for task in mission["tasks"]) == [
        "update_company",
        "update_employee",
    ]


def test_the_count_is_bounded_and_500_tasks_are_created_quickly(client: TestClient) -> None:
    body = {
        "name": "Grande découverte",
        "type": "prospection",
        "prompt": "Trouve des sociétés.",
        "result_kind": "companies",
    }
    for wrong in (0, 501):
        assert client.post(MISSIONS, json={**body, "task_count": wrong}).status_code == 422

    started = perf_counter()
    response = client.post(MISSIONS, json={**body, "task_count": 500})
    elapsed = perf_counter() - started

    assert response.status_code == 201, response.text
    assert len(response.json()["tasks"]) == 500
    print(f"500 tasks created and read back in {elapsed:.2f}s")
    assert elapsed < 20


def test_an_agent_reads_a_bounded_task_list(client: TestClient, db_session: Session) -> None:
    mission = _discovery(client, 90)
    token = assistant(db_session)

    read = rpc(client, token, "viper_get_mission", {"mission_id": mission["card"]["id"]})

    body = read["structuredContent"]
    assert not read["isError"], body
    assert len(body["tasks"]) == 60 and body["tasks_omitted"] == 30
    assert body["task_counts"] == {"pending": 90}


# --- one item, never twice ----------------------------------------------------------------------


def test_siblings_are_told_what_is_taken_and_cannot_propose_it_again(
    client: TestClient, db_session: Session
) -> None:
    add_company(db_session, display_name="Déjà en base")
    _discovery(client, 3)
    first_token, first = _claim(client, db_session, "find_prospects")
    second_token, second = _claim(client, db_session, "find_prospects")
    assert first["known_values"]["already_proposed"] == []
    assert "Déjà en base" in first["known_values"]["companies_in_base"]

    too_many = _submit(client, first_token, first, _companies("Alpha", "Beta"))
    assert too_many["structuredContent"]["code"] == "too_many"
    empty = _submit(client, first_token, first, {"companies": [], "confidence": 10})
    assert empty["structuredContent"]["code"] == "empty"
    known = _submit(client, first_token, first, _companies("Déjà en base"))
    assert known["structuredContent"]["code"] == "already_known"
    assert _submit(client, first_token, first, _companies("Alpha SAS"))["isError"] is False

    duplicate = _submit(client, second_token, second, _companies("ALPHA"))
    assert duplicate["isError"] is True
    assert duplicate["structuredContent"]["code"] == "duplicate_sibling"
    held = db_session.get(AgentTask, uuid.UUID(second["task_id"]))
    assert held is not None and held.status is AgentTaskStatus.CLAIMED
    assert _submit(client, second_token, second, _companies("Beta"))["isError"] is False

    _, third = _claim(client, db_session, "find_prospects")
    assert sorted(third["known_values"]["already_proposed"]) == ["Alpha SAS", "Beta"]


def test_an_accepted_sibling_contact_cannot_be_proposed_again(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    create(
        client,
        kind=MissionType.PROSPECTION,
        result_kind="prospects",
        targets=[{"kind": "company", "id": str(company.id)}],
        run_now=True,
        task_count=2,
    )
    token, payload = _claim(client, db_session, "find_employees")
    submitted = _submit(client, token, payload, _person("Camille", "Exemple"))
    assert submitted["isError"] is False, submitted["structuredContent"]
    other_token, other = _claim(client, db_session, "find_employees")
    assert other["known_values"]["already_proposed"] == ["Camille Exemple"]

    pending = _submit(client, other_token, other, _person("camille", "EXEMPLE"))
    assert pending["structuredContent"]["code"] == "duplicate_sibling"
    _decide(client, submitted)
    in_base = _submit(client, other_token, other, _person("Camille", "Exemple"))
    assert in_base["structuredContent"]["code"] == "already_known"


def test_a_staged_duplicate_is_refused_while_another_can_still_be_staged(
    client: TestClient, db_session: Session
) -> None:
    _discovery(client, 2)
    first_token, first = _claim(client, db_session, "find_prospects")
    second_token, second = _claim(client, db_session, "find_prospects")

    def stage(token: str, payload: dict[str, Any], name: str) -> Any:
        return rpc(
            client,
            token,
            "viper_add_company",
            {
                "task_id": payload["task_id"],
                "claim_id": payload["claim_id"],
                "action_id": str(uuid.uuid4()),
                "company_data": _company(name),
            },
        )

    # Staged first, submitted by the sibling meanwhile: the stale action must not trap the task.
    assert stage(second_token, second, "Alpha")["isError"] is False
    assert _submit(client, first_token, first, _companies("Alpha"))["isError"] is False
    stuck = _submit(client, second_token, second, {})
    assert stuck["structuredContent"]["code"] == "duplicate_sibling"
    again = stage(second_token, second, "Alpha")
    assert again["structuredContent"]["code"] == "duplicate_sibling"
    replaced = stage(second_token, second, "Beta")
    assert replaced["isError"] is False, replaced["structuredContent"]
    assert _submit(client, second_token, second, {})["isError"] is False


# --- finishing ----------------------------------------------------------------------------------


def test_a_one_off_mission_closes_when_every_task_is_finished_and_spawns_nothing(
    client: TestClient, db_session: Session
) -> None:
    mission = _discovery(client, 4)
    token = mint(db_session, label="Agent découverte", scopes=["find_prospects"])

    def work(result: dict[str, Any]) -> Any:
        payload = rpc(client, token, "viper_claim_task", {})["structuredContent"]
        answer = _submit(client, token, payload, result)
        assert answer["isError"] is False, answer["structuredContent"]
        return answer

    _decide(client, work(_companies("Alpha")))
    _decide(client, work(_companies("Beta")), accept=False)
    work({"outcome": "not_found", "notes": "Annuaires consultés.", "confidence": 0})

    midway = _detail(client, mission)
    assert midway["card"]["status"] == "active"
    assert (midway["card"]["tasks_done"], midway["card"]["tasks_total"]) == (3, 4)
    assert midway["runs"][0]["tasks_finished"] == 3

    work({"outcome": "blocked", "notes": "Source fermée.", "confidence": 0})

    done = _detail(client, mission)
    assert done["card"]["status"] == "done"
    assert (done["card"]["tasks_done"], done["card"]["tasks_total"]) == (4, 4)
    ends = {(task["status"], task["failure_code"]) for task in done["tasks"]}
    assert ends == {
        ("accepted", None),
        ("accepted", "not_found"),
        ("failed", "blocked"),
        ("failed", "rejected"),
    }
    assert rpc(client, token, "viper_claim_task", {})["structuredContent"].get("task_id") is None


def test_rejecting_the_last_task_closes_the_mission_at_once(
    client: TestClient, db_session: Session
) -> None:
    mission = _discovery(client, 1)
    token, payload = _claim(client, db_session, "find_prospects")

    _decide(client, _submit(client, token, payload, _companies("Alpha")), accept=False)

    assert _detail(client, mission)["card"]["status"] == "done"
    assert len(db_session.scalars(select(AgentTask)).all()) == 1


def test_a_recurring_mission_stays_active_after_its_run(
    client: TestClient, db_session: Session
) -> None:
    mission = _discovery(client, 1, is_recurring=True, interval_unit="days")
    token, payload = _claim(client, db_session, "find_prospects")
    _decide(client, _submit(client, token, payload, _companies("Alpha")))

    after = _detail(client, mission)

    assert after["card"]["status"] == "active" and after["card"]["next_run_at"]
    assert after["runs"][0]["status"] == "done"


def test_editing_keeps_the_count_unless_one_is_sent(client: TestClient) -> None:
    mission = _discovery(client, 12)
    body = {
        "name": "Découverte",
        "type": "prospection",
        "prompt": "Autre consigne.",
        "result_kind": "companies",
    }
    path = f"{MISSIONS}/{mission['card']['id']}"

    assert client.put(path, json=body).json()["rule"]["task_count"] == 12
    assert client.put(path, json={**body, "task_count": 3}).json()["rule"]["task_count"] == 3


def test_unchanged_values_produce_no_diff(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN", website_url="https://2sn.fr")
    create(client, targets=[{"kind": "company", "id": str(company.id)}], run_now=True)
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
    after = _detail(client, detail)
    assert after["tasks"][0]["status"] == "accepted"
    assert after["card"]["status"] == "done"
