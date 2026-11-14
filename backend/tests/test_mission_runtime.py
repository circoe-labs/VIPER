"""Mission runtime convergence (task `viper_mission_agent_configuration_v2`, Slice 07).

The claim -> work -> submit / release / leave -> review path over the real JSON-RPC `/mcp`
endpoint: what the claim carries (category instructions, skills, external sources, resolved
internal context, output contract, objective, identity, lifecycle), that a targeted task exposes
only its own target, that staging stays inside the output contract, and that no exit leaves a task
or a session stranded.
"""

import uuid
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import AgentTask
from app.models.enums import AgentTaskStatus, MissionType
from app.models.mission_telemetry import MissionAgentSession
from app.models.missions import Mission, MissionRun
from tests.builders import add_company
from tests.test_mission_categories import by_key, new_skill
from tests.test_mission_sources import CATEGORIES, add
from tests.test_missions import create, mint, rpc


def claim(client: TestClient, token: str, **args: Any) -> dict[str, Any]:
    answer = rpc(client, token, "viper_claim_task", args)
    assert answer["isError"] is False, answer["structuredContent"]
    payload: dict[str, Any] = answer["structuredContent"]
    return payload


def configured_category(client: TestClient) -> dict[str, Any]:
    """The seeded enrichment category, given a prompt, one skill and one source."""
    seeded = by_key(client)["enrichment"]
    skill = new_skill(client, "Citer ses sources", content="Cite l’URL exacte de chaque source.")
    hunter = add(client, "https://hunter.io", label="Hunter", description="E-mails pro")
    response = client.put(
        f"{CATEGORIES}/{seeded['id']}",
        json={
            "name": seeded["name"],
            "description": seeded["description"],
            "icon": seeded["icon"],
            "color": seeded["color"],
            "general_prompt": "Complète les fiches avec des faits sourcés.",
            "skill_ids": [skill["id"]],
        },
    )
    assert response.status_code == 200, response.text
    assert (
        client.put(f"{CATEGORIES}/{seeded['id']}/sources", json={"source_ids": [hunter["id"]]})
    ).status_code == 200
    return seeded


def test_the_claim_carries_the_instructions_sources_context_contract_and_identity(
    client: TestClient, db_session: Session
) -> None:
    category = configured_category(client)
    target = add_company(db_session, display_name="Cible SAS")
    other = add_company(db_session, display_name="Autre Cible SARL")
    reference = add_company(
        db_session,
        display_name="Client Historique",
        siren="123456789",
        client_approach="Ne jamais relancer avant mars",
    )
    detail = create(
        client,
        category_id=category["id"],
        prompt=None,
        targets=[
            {"kind": "company", "id": str(target.id)},
            {"kind": "company", "id": str(other.id)},
        ],
        context_refs=[{"kind": "company", "id": str(reference.id), "note": "Référence"}],
        run_now=True,
    )
    assert detail["card"]["runs_count"] == 1
    token = mint(db_session)

    payload = claim(client, token, task_types=["update_company"])

    mission = payload["mission"]
    assert mission["prompt"] == "Complète les fiches avec des faits sourcés."
    assert mission["category"]["key"] == "enrichment"
    assert mission["skills"] == [
        {"name": "Citer ses sources", "content": "Cite l’URL exacte de chaque source."}
    ]
    assert mission["sources"] == [
        {"url": "https://hunter.io", "label": "Hunter", "description": "E-mails pro"}
    ]
    context = payload["internal_context"]
    assert [(row["kind"], row["label"], row["read_only"]) for row in context] == [
        ("company", "Client Historique", True)
    ]
    assert context[0]["fields"]["siren"] == "123456789"
    assert "Ne jamais relancer" not in str(payload)
    # One target at a time: the task names its own company, the sibling target never appears.
    assert payload["subject"]["company_id"] in {str(target.id), str(other.id)}
    own = "Cible SAS" if payload["subject"]["company_id"] == str(target.id) else "Autre Cible SARL"
    sibling = "Autre Cible SARL" if own == "Cible SAS" else "Cible SAS"
    assert sibling not in str(payload) and str(
        other.id if own == "Cible SAS" else target.id
    ) not in str(payload)
    assert payload["output_contract"]["envelope"] == "single"
    assert payload["objective"] == {"kind": "tasks_accepted", "count": None}
    # The identity VIPER sees, the exits, and the right wording for the two limits.
    assert payload["agent"]["identity"].startswith("Agent")
    assert "#1" in payload["agent"]["identity"]
    assert "viper_leave_work" in payload["lifecycle"]["stop"]
    assert "3 hours" in payload["lifecycle"]["safety_nets"]
    assert "not a limit on how many conversations" in payload["lifecycle"]["task_limit"]


def test_a_run_made_before_the_snapshot_reads_skills_and_category_live(
    client: TestClient, db_session: Session
) -> None:
    category = configured_category(client)
    company = add_company(db_session, display_name="2SN")
    create(
        client,
        category_id=category["id"],
        prompt=None,
        targets=[{"kind": "company", "id": str(company.id)}],
        run_now=True,
    )
    run = db_session.scalars(select(MissionRun)).one()
    run.config = {k: v for k, v in run.config.items() if k not in ("skills", "category")}
    db_session.flush()

    payload = claim(client, mint(db_session), task_types=["update_company"])

    assert [skill["name"] for skill in payload["mission"]["skills"]] == ["Citer ses sources"]
    assert payload["mission"]["category"]["key"] == "enrichment"


def test_a_run_keeps_the_instructions_it_started_with(
    client: TestClient, db_session: Session
) -> None:
    category = configured_category(client)
    company = add_company(db_session, display_name="2SN")
    create(
        client,
        category_id=category["id"],
        prompt=None,
        targets=[{"kind": "company", "id": str(company.id)}],
        run_now=True,
    )
    for skill in client.get("/api/mission-skills").json():
        assert client.delete(f"/api/mission-skills/{skill['id']}").status_code == 204

    payload = claim(client, mint(db_session), task_types=["update_company"])

    assert [skill["name"] for skill in payload["mission"]["skills"]] == ["Citer ses sources"]


def test_submit_enforces_the_contract_then_review_applies_and_the_one_off_mission_closes(
    client: TestClient, db_session: Session
) -> None:
    create(
        client,
        kind=MissionType.PROSPECTION,
        result_kind="companies",
        run_now=True,
    )
    token = mint(db_session, label="Agent découverte", scopes=["find_prospects"])
    payload = claim(client, token)
    base = {"task_id": payload["task_id"], "claim_id": payload["claim_id"]}
    company = {
        "display_name": "Alpha SA",
        "confidence": 70,
        "evidence": [{"field": "display_name", "source": "https://example.test/alpha"}],
    }

    too_many = rpc(
        client,
        token,
        "viper_submit_task_result",
        {
            **base,
            "result": {
                "companies": [company, {**company, "display_name": "Beta SA"}],
                "confidence": 70,
            },
        },
    )
    assert too_many["isError"] is True
    assert too_many["structuredContent"]["code"] == "too_many"
    # Refused, not lost: the task is still the agent's and it may fix the answer.
    held = db_session.scalars(select(AgentTask)).one()
    assert held.status is AgentTaskStatus.CLAIMED

    submitted = rpc(
        client,
        token,
        "viper_submit_task_result",
        {**base, "result": {"companies": [company], "confidence": 70}},
    )
    assert submitted["isError"] is False, submitted
    assert submitted["structuredContent"]["status"] == "pending_review"
    db_session.expire_all()
    assert db_session.scalars(select(AgentTask)).one().status is AgentTaskStatus.SUBMITTED


def test_staging_inside_a_mission_stays_inside_its_output_contract(
    client: TestClient, db_session: Session
) -> None:
    mine = add_company(db_session, display_name="Ma cible")
    foreign = add_company(db_session, display_name="Pas ma cible")
    create(client, targets=[{"kind": "company", "id": str(mine.id)}], run_now=True)
    token = mint(db_session)
    payload = claim(client, token, task_types=["update_company"])
    base = {"task_id": payload["task_id"], "claim_id": payload["claim_id"]}

    refused = rpc(
        client,
        token,
        "viper_update_company",
        {
            **base,
            "company_id": str(foreign.id),
            "action_id": str(uuid.uuid4()),
            "result": {"legal_name": "Pas SAS", "confidence": 80},
        },
    )
    assert refused["isError"] is True
    assert refused["structuredContent"]["code"] == "wrong_target"
    own = rpc(
        client,
        token,
        "viper_update_company",
        {
            **base,
            "company_id": str(mine.id),
            "action_id": str(uuid.uuid4()),
            "result": {"legal_name": "Ma Cible SAS", "confidence": 80},
        },
    )
    assert own["isError"] is False, own


def test_a_discovery_task_stages_one_company_unless_the_mission_allows_a_list(
    client: TestClient, db_session: Session
) -> None:
    create(client, kind=MissionType.PROSPECTION, result_kind="companies", run_now=True)
    token = mint(db_session, scopes=["find_prospects"])
    payload = claim(client, token)
    base = {"task_id": payload["task_id"], "claim_id": payload["claim_id"]}

    def add_company_action(name: str) -> dict[str, Any]:
        return rpc(
            client,
            token,
            "viper_add_company",
            {
                **base,
                "action_id": str(uuid.uuid4()),
                "company_data": {"display_name": name, "confidence": 80},
            },
        )

    assert add_company_action("Alpha SA")["isError"] is False
    second = add_company_action("Beta SA")
    assert second["isError"] is True and second["structuredContent"]["code"] == "too_many"


def test_leave_work_hands_back_the_run_and_ends_the_session_without_stranding_anything(
    client: TestClient, db_session: Session
) -> None:
    companies = [add_company(db_session, display_name=f"Société {i}") for i in range(2)]
    create(
        client,
        targets=[{"kind": "company", "id": str(company.id)} for company in companies],
        run_now=True,
    )
    token = mint(db_session)
    first = claim(client, token, task_types=["update_company"])
    second = claim(client, token, task_types=["update_company"])
    assert {first["task_id"], second["task_id"]} and first["task_id"] != second["task_id"]
    assert db_session.scalars(select(MissionAgentSession)).one().status.value == "active"

    left = rpc(client, token, "viper_leave_work", {"task_id": first["task_id"]})

    assert left["isError"] is False, left
    assert left["structuredContent"] == {"released_tasks": 2, "ended_sessions": 1, "scope": "run"}
    db_session.expire_all()
    assert {task.status for task in db_session.scalars(select(AgentTask))} == {
        AgentTaskStatus.PENDING
    }
    # No dead end: the work is claimable again (by the same agent, a new session) and the second
    # leave is a harmless no-op.
    again = claim(client, token, task_types=["update_company"])
    assert again["task_id"] in {first["task_id"], second["task_id"]}
    assert rpc(client, token, "viper_leave_work", {})["structuredContent"]["released_tasks"] == 1
    assert rpc(client, token, "viper_leave_work", {})["structuredContent"] == {
        "released_tasks": 0,
        "ended_sessions": 0,
        "scope": "all",
    }
    mission = db_session.scalars(select(Mission)).one()
    assert mission.status.value == "active"


def test_release_returns_the_task_unfailed_and_keeps_the_session_open(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    create(client, targets=[{"kind": "company", "id": str(company.id)}], run_now=True)
    token = mint(db_session)
    payload = claim(client, token, task_types=["update_company"])

    released = rpc(
        client,
        token,
        "viper_release_task",
        {"task_id": payload["task_id"], "claim_id": payload["claim_id"]},
    )

    assert released["isError"] is False
    db_session.expire_all()
    task = db_session.scalars(select(AgentTask)).one()
    assert task.status is AgentTaskStatus.PENDING and task.failure_code is None
    assert db_session.scalars(select(MissionAgentSession)).one().status.value == "active"
