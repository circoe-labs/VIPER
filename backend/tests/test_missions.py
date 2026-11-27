"""Missions: create the rule, launch a run, and let an agent work it over MCP.

The chain under test is the product's: a person writes « Complète ces fiches », the run creates one
task per linked record, an agent claims it with the mission's consigne, and the result waits for
the person's review. Nothing is written before that review.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import delete as sql_delete
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Company, Mission, Prospect, ProspectSource
from app.models.agent_missions import AgentTask, AgentTaskResult
from app.models.audit import AuditLogEntry
from app.models.enums import (
    MissionRunStatus,
    MissionRunTrigger,
    MissionStatus,
    MissionType,
    ProspectSourceType,
)
from app.models.missions import MissionRun, MissionTarget
from app.models.prospects import ProspectNote
from app.services import mcp_tokens, missions
from tests.builders import (
    FIXTURE_ACTOR,
    add_company,
    add_email,
    add_phone,
    add_prospect,
    add_role,
)

MISSIONS = "/api/missions"


def mint(session: Session, label: str = "Agent claude-01", scopes: list[str] | None = None) -> str:
    token, _ = mcp_tokens.mint(session, label=label, scopes=scopes or ["*"])
    return token


def rpc(client: TestClient, token: str, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
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


def allow_list(session: Session, mission_id: str, items: int = 20) -> None:
    """Make the runs already started take a list per task, as a run migrated from the list mode
    (migration 0065) or a « Dépôt » drop does."""
    for run in session.scalars(
        select(MissionRun).where(MissionRun.mission_id == uuid.UUID(mission_id))
    ):
        assert run.config is not None
        run.config = {**run.config, "items_per_task": items}
    session.flush()


def create(
    client: TestClient,
    *,
    name: str = "Compléter les fiches",
    kind: MissionType = MissionType.ENRICHMENT,
    prompt: str = "Complète le site web et le domaine e-mail de ces sociétés.",
    targets: list[dict[str, str]] | None = None,
    run_now: bool = False,
    **extra: Any,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "name": name,
        "type": kind.value,
        "prompt": prompt,
        "targets": targets or [],
        "result_kind": "enrichment",
        "run_now": run_now,
        **extra,
    }
    response = client.post(MISSIONS, json=body)
    assert response.status_code == 201, response.text
    detail: dict[str, Any] = response.json()
    return detail


def test_create_a_mission_and_list_its_card(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")

    detail = create(
        client,
        targets=[{"kind": "company", "id": str(company.id)}],
    )

    assert detail["card"]["name"] == "Compléter les fiches"
    assert detail["card"]["targets_count"] == 1
    assert detail["targets"][0]["label"] == "2SN"
    listed = client.get(MISSIONS).json()
    assert listed["total"] == 2  # + the permanent Dépôt
    created_card = next(item for item in listed["items"] if not item["is_deposit"])
    assert created_card["targets_count"] == 1
    # Active from its creation: the first run and its task are open to the agents right away.
    assert listed["items"][0]["runs_count"] == 1


def test_a_run_creates_one_task_per_linked_company(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")

    detail = create(
        client,
        targets=[{"kind": "company", "id": str(company.id)}],
        run_now=True,
    )

    assert detail["runs"][0]["status"] == "running"
    assert len(detail["tasks"]) == 1
    task = detail["tasks"][0]
    assert task["type"] == "update_company"
    assert task["company_id"] == str(company.id)
    assert detail["card"]["last_run_at"]
    # A one-off launched now has no next execution.
    assert detail["card"]["next_run_at"] is None


def test_the_agent_receives_the_mission_consigne(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    create(
        client,
        prompt="Trouve le site web et le SIREN de cette société.",
        targets=[{"kind": "company", "id": str(company.id)}],
        run_now=True,
    )
    token = mint(db_session)

    answer = rpc(client, token, "viper_claim_task", {"task_types": ["update_company"]})

    assert answer["isError"] is False, answer["structuredContent"]
    payload = answer["structuredContent"]
    assert payload["mission"]["name"] == "Compléter les fiches"
    assert payload["mission"]["prompt"] == "Trouve le site web et le SIREN de cette société."
    assert payload["mission"]["result_kind"] == "enrichment"
    assert payload["company_data"]["display_name"] == "2SN"
    assert payload["thread"] is None


def test_a_prospect_target_creates_an_employee_task(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    role = add_role(db_session, label="RH")
    prospect = add_prospect(
        db_session, company, first_name="Marie", last_name="Dupont", role_id=role.id
    )
    add_email(db_session, prospect, "marie@2sn.fr", is_primary=True, is_active=True)
    add_phone(db_session, prospect, "+33600000000", is_primary=True, is_active=True)
    create(
        client,
        targets=[{"kind": "prospect", "id": str(prospect.id)}],
        run_now=True,
    )
    token = mint(db_session, scopes=["update_employee"])

    payload = rpc(client, token, "viper_claim_task", {})["structuredContent"]

    assert payload["task"] == "update_employee"
    assert payload["user_data"]["first_name"] == "Marie"
    assert payload["user_data"]["role"] == "RH"
    assert payload["subject"]["company_id"] == str(company.id)


def test_the_mission_agent_is_the_only_one_that_can_claim(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    chosen = mint(db_session, label="Agent choisi", scopes=["update_company"])
    other = mint(db_session, label="Autre agent", scopes=["update_company"])
    token_record = db_session.scalar(
        select(mcp_tokens.McpToken).where(mcp_tokens.McpToken.label == "Agent choisi")
    )
    assert token_record is not None
    create(
        client,
        targets=[{"kind": "company", "id": str(company.id)}],
        run_now=True,
        agent_id=str(token_record.id),
    )

    idle = rpc(client, other, "viper_claim_task", {})["structuredContent"]
    assert idle["task"] is None
    # « Nothing to claim » says why: the open missions, their state and next run.
    assert idle["hint"]
    assert [mission["name"] for mission in idle["missions"]] == ["Compléter les fiches"]
    claimed = rpc(client, chosen, "viper_claim_task", {})["structuredContent"]
    assert claimed["task"] == "update_company"
    assert claimed["mission"]["id"]


def test_accepting_the_result_writes_the_company(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    create(
        client,
        targets=[{"kind": "company", "id": str(company.id)}],
        run_now=True,
    )
    token = mint(db_session)
    payload = rpc(client, token, "viper_claim_task", {})["structuredContent"]
    submitted = rpc(
        client,
        token,
        "viper_submit_task_result",
        {
            "task_id": payload["task_id"],
            "claim_id": payload["claim_id"],
            "result": {"legal_name": "2SN SAS", "confidence": 80},
        },
    )
    assert submitted["isError"] is False
    result_id = submitted["structuredContent"]["result_id"]

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    db_session.expire_all()
    saved = db_session.get(Company, company.id)
    assert saved is not None
    assert saved.legal_name == "2SN SAS"
    mission = db_session.scalar(select(Mission).where(Mission.is_deposit.is_(False)))
    assert mission is not None
    detail = client.get(f"{MISSIONS}/{mission.id}").json()
    assert detail["card"]["tasks_done"] == 1


def test_a_recurring_mission_gets_its_next_run(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    starts = datetime.now(UTC) + timedelta(hours=1)

    detail = create(
        client,
        targets=[{"kind": "company", "id": str(company.id)}],
        is_recurring=True,
        interval_count=24,
        interval_unit="hours",
        starts_at=starts.isoformat(),
    )

    next_run = datetime.fromisoformat(detail["card"]["next_run_at"])
    assert next_run == starts


def test_a_signals_mission_needs_a_company(client: TestClient, db_session: Session) -> None:
    created = client.post(
        MISSIONS,
        json={
            "name": "Nouveaux entrepôts",
            "type": "signals",
            "prompt": "Trouve les nouveaux entrepôts en Normandie.",
            "result_kind": "signals",
        },
    )

    # No linked record is required: the mission works from its consigne.
    assert created.status_code == 201, created.text
    company = add_company(db_session, display_name="2SN")
    accepted = client.post(
        MISSIONS,
        json={
            "name": "Nouveaux entrepôts",
            "type": "signals",
            "prompt": "Surveille les annonces d’entrepôt.",
            "result_kind": "signals",
            "targets": [{"kind": "company", "id": str(company.id)}],
        },
    )
    assert accepted.status_code == 201, accepted.text


def test_a_mission_without_targets_can_run(client: TestClient, db_session: Session) -> None:
    response = client.post(
        MISSIONS,
        json={
            "name": "Sans données",
            "type": "enrichment",
            "prompt": "Complète.",
            "result_kind": "enrichment",
            "run_now": True,
        },
    )

    assert response.status_code == 201, response.text
    db_session.expire_all()
    assert db_session.scalar(select(Mission)) is not None


def test_target_search_returns_companies_and_prospects(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="Transports X")
    add_prospect(db_session, company, first_name="Jean", last_name="Dupont")

    companies = client.get(f"{MISSIONS}/targets", params={"kind": "company", "q": "Transports"})
    prospects = client.get(f"{MISSIONS}/targets", params={"kind": "prospect", "q": "Dupont"})

    assert companies.status_code == 200
    assert companies.json()[0]["label"] == "Transports X"
    assert prospects.status_code == 200
    assert prospects.json()[0]["label"] == "Jean Dupont"
    assert prospects.json()[0]["hint"] == "Transports X"


def test_options_flag_the_executable_types(client: TestClient) -> None:
    options = client.get(f"{MISSIONS}/options").json()

    types = {item["value"]: item["executable"] for item in options["types"]}
    assert types["enrichment"] is True
    assert types["signals"] is True


def due_mission(client: TestClient, db_session: Session, company: Company, **extra: Any) -> Mission:
    detail = create(
        client,
        targets=[{"kind": "company", "id": str(company.id)}],
        is_recurring=True,
        interval_count=1,
        interval_unit="hours",
        # A future start: nothing runs at creation; the test then makes it due.
        starts_at=(datetime.now(UTC) + timedelta(hours=1)).isoformat(),
        **extra,
    )
    mission = db_session.get(Mission, uuid.UUID(detail["card"]["id"]))
    assert mission is not None
    mission.next_run_at = datetime.now(UTC) - timedelta(minutes=5)
    db_session.flush()
    return mission


def test_the_scheduler_starts_a_due_run(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    mission = due_mission(client, db_session, company)
    now = datetime.now(UTC)

    started = missions.run_due(db_session, now=now)

    assert len(started) == 1
    assert started[0].trigger is MissionRunTrigger.SCHEDULE
    assert started[0].status is MissionRunStatus.RUNNING
    db_session.refresh(mission)
    assert mission.next_run_at is not None
    assert mission.next_run_at > now


def test_the_scheduler_closes_an_exhausted_recurrence(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    mission = due_mission(client, db_session, company, end_kind="after", max_runs=1)
    now = datetime.now(UTC)

    assert len(missions.run_due(db_session, now=now)) == 1
    db_session.refresh(mission)
    assert mission.status is MissionStatus.DONE
    assert mission.next_run_at is None
    # A closed mission is never picked again.
    assert missions.run_due(db_session, now=now + timedelta(hours=2)) == []


def test_a_signals_rule_with_the_wrong_result_is_refused_when_saved(client: TestClient) -> None:
    created = client.post(
        MISSIONS,
        json={
            "name": "Veille",
            "type": "signals",
            "prompt": "Trouve les nouveaux entrepôts.",
            "result_kind": "companies",
            "is_recurring": True,
            "interval_count": 1,
            "interval_unit": "days",
        },
    )

    assert created.status_code == 422, created.text


def test_a_recurring_mission_starting_now_is_open_to_agents_at_once(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")

    detail = create(
        client,
        targets=[{"kind": "company", "id": str(company.id)}],
        is_recurring=True,
        interval_count=24,
        interval_unit="hours",
    )

    # No « Lancer maintenant »: active from its creation, its first tasks already wait.
    assert len(detail["runs"]) == 1
    assert len(detail["tasks"]) == 1
    mission = db_session.get(Mission, uuid.UUID(detail["card"]["id"]))
    assert mission is not None
    assert mission.next_run_at is not None and mission.next_run_at > datetime.now(UTC)
    assert missions.run_due(db_session, now=datetime.now(UTC)) == []


def test_activating_a_mission_before_its_first_run_opens_it_to_agents(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    mission = due_mission(client, db_session, company)
    mission_id = str(mission.id)
    assert client.patch(f"{MISSIONS}/{mission_id}", json={"status": "paused"}).status_code == 200
    db_session.expire_all()
    mission = db_session.get(Mission, mission.id)
    assert mission is not None
    mission.starts_at = datetime.now(UTC) - timedelta(minutes=1)
    db_session.flush()

    activated = client.patch(f"{MISSIONS}/{mission_id}", json={"status": "active"})

    assert activated.status_code == 200, activated.text
    detail = client.get(f"{MISSIONS}/{mission_id}").json()
    assert len(detail["runs"]) == 1
    assert len(detail["tasks"]) == 1


def test_a_prospection_mission_finds_new_contacts(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    add_prospect(db_session, company, first_name="Jean", last_name="Test")
    detail = create(
        client,
        name="Responsables 2SN",
        kind=MissionType.PROSPECTION,
        prompt="Cherche un responsable d’exploitation pour cette société.",
        targets=[{"kind": "company", "id": str(company.id)}],
        result_kind="prospects",
        run_now=True,
    )
    allow_list(db_session, detail["card"]["id"])
    token = mint(db_session, label="Agent contacts", scopes=["find_employees"])

    payload = rpc(client, token, "viper_claim_task", {})["structuredContent"]

    assert detail["tasks"][0]["type"] == "find_employees"
    assert payload["task"] == "find_employees"
    assert payload["known_values"]["people"][0]["name"] == "Jean Test"
    assert payload["output_schema"]["properties"]["people"]

    submitted = rpc(
        client,
        token,
        "viper_submit_task_result",
        {
            "task_id": payload["task_id"],
            "claim_id": payload["claim_id"],
            "result": {
                "people": [
                    {
                        "first_name": "Marie",
                        "last_name": "Dupont",
                        "exact_job_title": "Directrice RH",
                        "role": "RH",
                        "email": "marie@2sn.fr",
                        "confidence": 80,
                        "evidence": [
                            {
                                "field": "email",
                                "source": "https://2sn.fr/equipe",
                                "quote": "Marie Dupont, Directrice RH",
                            }
                        ],
                    },
                    {
                        "first_name": "Jean",
                        "last_name": "Test",
                        "confidence": 50,
                        "evidence": [{"field": "first_name", "source": "https://2sn.fr"}],
                    },
                ],
                "confidence": 80,
            },
        },
    )
    assert submitted["isError"] is False, submitted["structuredContent"]
    result_id = submitted["structuredContent"]["result_id"]
    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]
    assert len(proposal["items"]) == 1
    assert proposal["refused"][0]["reason"] == "already_known"

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    db_session.expire_all()
    marie = db_session.scalar(select(Prospect).where(Prospect.first_name == "Marie"))
    assert marie is not None
    assert marie.company_id == company.id
    assert {email.address for email in marie.emails} == {"marie@2sn.fr"}
    assert marie.employment_verified_at is not None
    source = db_session.scalar(select(ProspectSource).where(ProspectSource.prospect_id == marie.id))
    assert source is not None
    assert source.source_type is ProspectSourceType.FUTURE_AGENT
    assert source.source_reference == "https://2sn.fr/equipe"


def test_a_prospection_without_companies_cannot_run(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    prospect = add_prospect(db_session, company, first_name="Marie", last_name="Dupont")

    response = client.post(
        MISSIONS,
        json={
            "name": "Sans société",
            "type": "prospection",
            "prompt": "Trouve des contacts.",
            "targets": [{"kind": "prospect", "id": str(prospect.id)}],
            "result_kind": "prospects",
            "run_now": True,
        },
    )

    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "empty"


def test_a_discovery_mission_finds_new_companies(client: TestClient, db_session: Session) -> None:
    add_company(db_session, display_name="Transports X")
    detail = create(
        client,
        name="Commissaires Normandie",
        kind=MissionType.PROSPECTION,
        prompt="Trouve les commissaires au transport de matières dangereuses en Normandie.",
        result_kind="companies",
        run_now=True,
    )
    allow_list(db_session, detail["card"]["id"])
    token = mint(db_session, label="Agent découverte", scopes=["find_prospects"])

    payload = rpc(client, token, "viper_claim_task", {})["structuredContent"]

    assert detail["tasks"][0]["type"] == "find_prospects"
    assert payload["task"] == "find_prospects"
    assert "Normandie" in payload["mission"]["prompt"]
    assert payload["output_schema"]["properties"]["companies"]

    submitted = rpc(
        client,
        token,
        "viper_submit_task_result",
        {
            "task_id": payload["task_id"],
            "claim_id": payload["claim_id"],
            "result": {
                "companies": [
                    {
                        "display_name": "Logistique Y",
                        "siren": "732829320",
                        "website_url": "https://logistique-y.fr",
                        "email_domain": "logistique-y.fr",
                        "size_label": "50-99 salariés",
                        "commercial_segment": "Segment inconnu",
                        "activity_categories": ["Catégorie inconnue"],
                        "confidence": 80,
                        "evidence": [
                            {
                                "field": "siren",
                                "source": "https://annuaire.example/logistique-y",
                                "quote": "Logistique Y — SIREN 732 829 320",
                            }
                        ],
                    },
                    {
                        "display_name": "Transports X",
                        "confidence": 50,
                        "evidence": [{"field": "display_name", "source": "https://example.test/x"}],
                    },
                ],
                "confidence": 80,
            },
        },
    )
    assert submitted["isError"] is False, submitted["structuredContent"]
    result_id = submitted["structuredContent"]["result_id"]
    review = client.get(f"/api/agents/results/{result_id}").json()
    proposal = review["proposal"]
    assert len(proposal["items"]) == 1
    assert {item["reason"] for item in proposal["refused"]} == {"unknown", "already_known"}
    assert review["raw"]["companies"][0]["commercial_segment"] == "Segment inconnu"
    assert db_session.scalar(select(Company).where(Company.display_name == "Logistique Y")) is None

    # An older pending result can be rebuilt from its saved JSON without rerunning the agent.
    stored = db_session.get(AgentTaskResult, uuid.UUID(result_id))
    assert stored is not None
    stored.proposal = {**stored.proposal, "items": []}
    db_session.flush()
    rebuilt = client.post(f"/api/agents/results/{result_id}/rebuild")
    assert rebuilt.status_code == 200, rebuilt.text
    assert len(rebuilt.json()["proposal"]["items"]) == 1
    assert db_session.scalar(select(Company).where(Company.display_name == "Logistique Y")) is None

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    db_session.expire_all()
    created = db_session.scalar(select(Company).where(Company.display_name == "Logistique Y"))
    assert created is not None
    assert created.siren == "732829320"
    assert created.website_url == "https://logistique-y.fr"


def test_task_actions_form_one_review_without_writes_before_acceptance(
    client: TestClient, db_session: Session
) -> None:
    existing = add_company(db_session, display_name="Société existante")
    prospect = add_prospect(db_session, existing, first_name="Marie", last_name="Dupont")
    detail = create(
        client,
        name="Découverte",
        kind=MissionType.PROSPECTION,
        prompt="Cherche des entreprises",
        result_kind="companies",
        run_now=True,
    )
    allow_list(db_session, detail["card"]["id"])
    token = mint(db_session)
    claim = rpc(client, token, "viper_claim_task", {})["structuredContent"]
    base = {"task_id": claim["task_id"], "claim_id": claim["claim_id"]}
    action_id = str(uuid.uuid4())
    add_args = {
        **base,
        "action_id": action_id,
        "company_data": {
            "display_name": "Nouvelle entreprise",
            "confidence": 80,
            "commercial_segment": "Segment inconnu",
            "evidence": [{"field": "display_name", "source": "https://example.test"}],
        },
    }
    first = rpc(client, token, "viper_add_company", add_args)
    retry = rpc(client, token, "viper_add_company", add_args)
    assert first["isError"] is False and retry["structuredContent"]["staged_count"] == 1
    second = rpc(
        client,
        token,
        "viper_add_company",
        {
            **add_args,
            "action_id": str(uuid.uuid4()),
            "company_data": {**add_args["company_data"], "display_name": "Autre entreprise"},
        },
    )
    assert second["isError"] is False
    bad_claim = rpc(client, token, "viper_add_company", {**add_args, "claim_id": str(uuid.uuid4())})
    assert bad_claim["isError"] is True
    released = rpc(client, token, "viper_release_task", base)
    assert released["isError"] is False
    resumed = rpc(client, token, "viper_claim_task", {})["structuredContent"]
    assert len(resumed["staged_actions"]) == 2
    base = {"task_id": resumed["task_id"], "claim_id": resumed["claim_id"]}
    # Inside a mission run a discovery task proposes companies only: an update of another record
    # is not the output contract of this task (Slice 07), whatever the record.
    for name, target, data in [
        (
            "viper_update_company",
            {"company_id": str(existing.id)},
            {"legal_name": "Existante SAS", "confidence": 80},
        ),
        (
            "viper_update_prospect",
            {"prospect_id": str(prospect.id)},
            {"exact_job_title": "Directrice", "confidence": 80},
        ),
    ]:
        answer = rpc(
            client, token, name, {**base, **target, "action_id": str(uuid.uuid4()), "result": data}
        )
        assert answer["isError"] is True, answer
        assert answer["structuredContent"]["code"] == "wrong_target"
    submitted = rpc(client, token, "viper_submit_task_result", {**base, "result": {}})
    assert submitted["isError"] is False, submitted
    result_id = submitted["structuredContent"]["result_id"]
    review = client.get(f"/api/agents/results/{result_id}").json()
    assert len(review["raw"]["actions"]) == 2
    assert len(review["proposal"]["items"]) == 2
    db_session.expire_all()
    assert (
        db_session.scalar(select(Company).where(Company.display_name == "Nouvelle entreprise"))
        is None
    )
    selected = [item["key"] for item in review["proposal"]["items"]]
    accepted = client.post(
        f"/api/agents/results/{result_id}/accept", json={"accepted_items": selected}
    )
    assert accepted.status_code == 200, accepted.text
    db_session.expire_all()
    assert db_session.scalar(select(Company).where(Company.display_name == "Nouvelle entreprise"))
    assert db_session.scalar(select(Company).where(Company.display_name == "Autre entreprise"))
    assert db_session.get(Company, existing.id).legal_name is None
    assert db_session.get(Prospect, prospect.id).exact_job_title is None


def test_a_discovery_with_a_contacts_expectation_is_accepted(
    client: TestClient, db_session: Session
) -> None:
    response = client.post(
        MISSIONS,
        json={
            "name": "Découverte incohérente",
            "type": "prospection",
            "prompt": "Trouve des contacts.",
            "result_kind": "prospects",
            "run_now": True,
        },
    )

    assert response.status_code == 201, response.text


def test_a_signals_mission_stores_dated_sourced_signals(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    marie = add_prospect(db_session, company, first_name="Marie", last_name="Dupont")
    detail = create(
        client,
        name="Veille 2SN",
        kind=MissionType.SIGNALS,
        prompt="Trouve les signaux récents de cette société.",
        targets=[{"kind": "company", "id": str(company.id)}],
        result_kind="signals",
        run_now=True,
    )
    token = mint(db_session, label="Agent veille", scopes=["surveil_signals"])

    payload = rpc(client, token, "viper_claim_task", {})["structuredContent"]

    assert detail["tasks"][0]["type"] == "surveil_signals"
    assert payload["task"] == "surveil_signals"
    assert payload["known_signals"] == []
    assert payload["output_schema"]["properties"]["signals"]

    submitted = rpc(
        client,
        token,
        "viper_submit_task_result",
        {
            "task_id": payload["task_id"],
            "claim_id": payload["claim_id"],
            "result": {
                "signals": [
                    {
                        "subject": {"type": "company"},
                        "kind": "hiring",
                        "signal": "2SN recrute son premier responsable commercial.",
                        "score": 15,
                        "score_reason": "Un premier commercial annonce un budget outillage.",
                        "source": "https://example.test/2sn-recrutement",
                        "source_channel": "web",
                        "observed_on": "2026-10-25",
                        "relevance": 80,
                        "sentiment": "positive",
                    },
                    {
                        "subject": {"type": "person", "name": "Marie Dupont"},
                        "kind": "need_expressed",
                        "signal": "Marie Dupont publie sur la souveraineté des données.",
                        "score": 20,
                        "score_reason": "Le besoin est exprimé par la décideuse.",
                        "source": "https://linkedin.test/marie-dupont",
                        "source_channel": "linkedin",
                        "observed_on": "2026-10-26",
                        "relevance": 90,
                        "sentiment": "positive",
                    },
                    {
                        "subject": {"type": "company"},
                        "kind": "hiring",
                        "signal": "Doublon.",
                        "score": 5,
                        "score_reason": "Doublon.",
                        "source": "https://example.test/2sn-recrutement",
                        "observed_on": "2026-10-25",
                        "relevance": 10,
                    },
                ],
                "confidence": 80,
            },
        },
    )
    assert submitted["isError"] is False, submitted["structuredContent"]
    result_id = submitted["structuredContent"]["result_id"]
    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]
    assert len(proposal["items"]) == 2
    assert proposal["refused"][0]["reason"] == "already_known"

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    db_session.expire_all()
    notes = db_session.scalars(
        select(ProspectNote).where(ProspectNote.task_result_id == uuid.UUID(result_id))
    ).all()
    assert len(notes) == 2
    assert all(note.origin.value == "agent" for note in notes)
    assert all(note.source_url for note in notes)
    assert all(note.valid_until is not None for note in notes)
    person_note = next(note for note in notes if note.prospect_id is not None)
    assert person_note.prospect_id == marie.id
    company_note = next(note for note in notes if note.company_id is not None)
    assert company_note.company_id == company.id
    scored = client.get(f"/api/prospects/{marie.id}").json()["score"]
    # Base 50 + the person's signal (+20) + the company's signal (+15).
    assert scored["total"] == 85
    assert any(line["reason"].startswith("Signal société") for line in scored["contributions"])
    # The company page can read the signals, with the person one attached to its subject.
    listed = client.get(f"/api/companies/{company.id}/signals").json()
    assert len(listed) == 2
    assert {row["subject"] for row in listed} == {"2SN", "Marie Dupont"}
    assert all(row["source_url"] for row in listed)


def test_a_signals_mission_without_companies_can_run(
    client: TestClient, db_session: Session
) -> None:
    response = client.post(
        MISSIONS,
        json={
            "name": "Veille sans société",
            "type": "signals",
            "prompt": "Trouve des signaux.",
            "result_kind": "signals",
            "run_now": True,
        },
    )

    assert response.status_code == 201, response.text


def test_delete_a_mission_cancels_its_open_tasks(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    detail = create(client, targets=[{"kind": "company", "id": str(company.id)}], run_now=True)
    mission_id = detail["card"]["id"]
    token = mint(db_session)
    claimed = rpc(client, token, "viper_claim_task", {"task_types": ["update_company"]})
    assert claimed["isError"] is False

    response = client.delete(f"{MISSIONS}/{mission_id}")

    assert response.status_code == 204, response.text
    assert client.get(f"{MISSIONS}/{mission_id}").status_code == 404
    assert client.get(MISSIONS).json()["total"] == 1  # the Dépôt stays
    db_session.expire_all()
    # The task stays, cancelled and detached from the deleted run; the company is untouched.
    task = db_session.scalars(select(AgentTask)).one()
    assert (task.status.value, task.run_id, task.claim_id) == ("cancelled", None, None)
    assert db_session.get(Company, company.id) is not None
    actions = set(db_session.scalars(select(AuditLogEntry.action)).all())
    assert {"mission.deleted", "agent_task.cancelled"} <= actions
    # Already gone: a second delete is a 404, not a silent success.
    assert client.delete(f"{MISSIONS}/{mission_id}").status_code == 404


def test_edit_a_mission_rewrites_the_rule_and_its_linked_data(
    client: TestClient, db_session: Session
) -> None:
    first = add_company(db_session, display_name="2SN")
    second = add_company(db_session, display_name="Transports X")
    detail = create(client, targets=[{"kind": "company", "id": str(first.id)}])
    mission_id = detail["card"]["id"]
    assert detail["rule"]["end_kind"] == "never"

    response = client.put(
        f"{MISSIONS}/{mission_id}",
        json={
            "name": "Fiches Normandie",
            "type": "enrichment",
            "prompt": "Trouve le SIREN.",
            "targets": [{"kind": "company", "id": str(second.id)}],
            "result_kind": "enrichment",
            "task_count": 5,
            "is_recurring": True,
            "interval_count": 2,
            "interval_unit": "days",
            "geography": "  Normandie ",
        },
    )

    assert response.status_code == 200, response.text
    edited = response.json()
    assert edited["card"]["name"] == "Fiches Normandie"
    assert edited["prompt"] == "Trouve le SIREN."
    # One linked company to update: one task, whatever was typed.
    assert edited["rule"]["task_count"] == 1
    assert [target["label"] for target in edited["targets"]] == ["Transports X"]
    assert edited["card"]["is_recurring"] is True
    assert edited["card"]["next_run_at"] is not None
    assert edited["rule"]["geography"] == "Normandie"
    entry = db_session.scalars(
        select(AuditLogEntry).where(AuditLogEntry.action == "mission.updated")
    ).one()
    assert entry.changes is not None
    assert entry.changes["name"] == {"before": "Compléter les fiches", "after": "Fiches Normandie"}


def test_a_run_keeps_the_rule_it_started_under(client: TestClient, db_session: Session) -> None:
    """HANDOFF §15 / PM decision 4: an edit applies to the next runs; a task already made is
    claimed with the consigne of its run."""
    company = add_company(db_session, display_name="2SN")
    targets = [{"kind": "company", "id": str(company.id)}]
    mission_id = create(client, targets=targets, run_now=True)["card"]["id"]
    token = mint(db_session)

    edited = client.put(
        f"{MISSIONS}/{mission_id}",
        json={
            "name": "Compléter les fiches",
            "type": "enrichment",
            "prompt": "Trouve le SIREN.",
            "targets": targets,
            "result_kind": "enrichment",
        },
    )
    assert edited.status_code == 200, edited.text
    claimed = rpc(client, token, "viper_claim_task", {})["structuredContent"]

    assert (
        claimed["mission"]["prompt"] == "Complète le site web et le domaine e-mail de ces sociétés."
    )
    assert claimed["mission"]["task_count"] == 1
    # The next run follows the new rule.
    missions.run_mission(db_session, FIXTURE_ACTOR, uuid.UUID(mission_id))
    run = db_session.scalars(
        select(MissionRun)
        .where(MissionRun.mission_id == uuid.UUID(mission_id))
        .order_by(MissionRun.created_at.desc(), MissionRun.id.desc())
    ).first()
    assert run is not None and run.config is not None
    assert run.config["prompt"] == "Trouve le SIREN."


def test_a_run_made_before_snapshots_reads_the_live_rule(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    mission_id = create(client, targets=[{"kind": "company", "id": str(company.id)}], run_now=True)[
        "card"
    ]["id"]
    run = db_session.scalars(select(MissionRun)).one()
    run.config = None  # a run made before migration 0027
    db_session.get_one(Mission, uuid.UUID(mission_id)).prompt = "Consigne du jour."
    db_session.flush()

    claimed = rpc(client, mint(db_session), "viper_claim_task", {})["structuredContent"]

    assert claimed["mission"]["prompt"] == "Consigne du jour."


def test_a_one_off_mission_with_an_end_date_and_no_date_is_a_422(
    client: TestClient, db_session: Session
) -> None:
    """The end rule binds a one-off mission too (`ck_missions_end_date_required`): a refusal on
    the field, never a 500 from the constraint."""
    company = add_company(db_session, display_name="2SN")

    response = client.post(
        MISSIONS,
        json={
            "name": "Compléter les fiches",
            "type": "enrichment",
            "prompt": "Complète ces fiches.",
            "targets": [{"kind": "company", "id": str(company.id)}],
            "result_kind": "enrichment",
            "end_kind": "date",
        },
    )

    assert response.status_code == 422, response.text
    detail = response.json()["detail"]
    assert (detail["field"], detail["reason"]) == ("ends_at", "missing")
    assert db_session.scalars(select(Mission).where(Mission.is_deposit.is_(False))).first() is None


def test_edit_refuses_a_closed_or_unknown_mission(client: TestClient, db_session: Session) -> None:
    targets = [{"kind": "company", "id": str(add_company(db_session, display_name="2SN").id)}]
    detail = create(client, targets=targets)
    mission_id = detail["card"]["id"]
    body = {
        "name": "X",
        "type": "enrichment",
        "prompt": "Y",
        "result_kind": "enrichment",
        "targets": targets,
    }
    assert client.patch(f"{MISSIONS}/{mission_id}", json={"status": "done"}).status_code == 200

    assert client.put(f"{MISSIONS}/{mission_id}", json=body).status_code == 409
    assert client.put(f"{MISSIONS}/{uuid.uuid4()}", json=body).status_code == 404
    assert client.put(f"{MISSIONS}/{mission_id}", json={**body, "name": ""}).status_code == 422


def test_a_saved_link_is_kept_once_and_reused_by_another_mission(client: TestClient) -> None:
    first = client.post(
        f"{MISSIONS}/sources",
        json={"url": " https://www.example.com/annuaire ", "label": "Annuaire"},
    )
    again = client.post(f"{MISSIONS}/sources", json={"url": "https://www.example.com/annuaire"})
    assert first.status_code == 201
    assert again.json()["id"] == first.json()["id"]
    source_id = first.json()["id"]

    one = create(
        client,
        name="Mission A",
        kind=MissionType.PROSPECTION,
        result_kind="companies",
        source_ids=[source_id],
    )
    two = create(
        client,
        name="Mission B",
        kind=MissionType.PROSPECTION,
        result_kind="companies",
        source_ids=[source_id],
    )

    assert [row["url"] for row in one["sources"]] == ["https://www.example.com/annuaire"]
    assert [row["url"] for row in two["sources"]] == ["https://www.example.com/annuaire"]
    saved = client.get(f"{MISSIONS}/sources").json()
    assert len(saved) == 1
    assert saved[0]["missions_count"] == 2


def test_a_link_must_be_a_full_http_address(client: TestClient) -> None:
    for bad in ("example.com", "javascript:alert(1)", "https://", "ftp://example.com/x"):
        response = client.post(f"{MISSIONS}/sources", json={"url": bad})
        assert response.status_code == 422, bad


def test_the_agent_receives_the_mission_links(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    source = client.post(
        f"{MISSIONS}/sources", json={"url": "https://www.example.com/annuaire", "label": "Annuaire"}
    ).json()
    create(
        client,
        targets=[{"kind": "company", "id": str(company.id)}],
        source_ids=[source["id"]],
        run_now=True,
    )

    answer = rpc(client, mint(db_session), "viper_claim_task", {"task_types": ["update_company"]})

    assert answer["structuredContent"]["mission"]["sources"] == [
        {"url": "https://www.example.com/annuaire", "label": "Annuaire", "description": None}
    ]


def test_forgetting_a_link_removes_it_from_its_missions(client: TestClient) -> None:
    source = client.post(f"{MISSIONS}/sources", json={"url": "https://www.example.com/a"}).json()
    mission = create(
        client, kind=MissionType.PROSPECTION, result_kind="companies", source_ids=[source["id"]]
    )

    assert client.delete(f"{MISSIONS}/sources/{source['id']}").status_code == 204

    assert client.get(f"{MISSIONS}/{mission['card']['id']}").json()["sources"] == []
    assert client.delete(f"{MISSIONS}/sources/{source['id']}").status_code == 404


def test_patch_changes_only_the_sources_of_a_mission(client: TestClient) -> None:
    first = client.post(f"{MISSIONS}/sources", json={"url": "https://www.example.com/a"}).json()
    second = client.post(f"{MISSIONS}/sources", json={"url": "https://www.other.org/b"}).json()
    mission = create(
        client,
        name="Sources éditables",
        kind=MissionType.PROSPECTION,
        result_kind="companies",
        source_ids=[first["id"]],
    )
    url = f"{MISSIONS}/{mission['card']['id']}"

    own = client.patch(url, json={"source_ids": [first["id"], second["id"]]})
    assert own.status_code == 200, own.text
    assert {row["id"] for row in own.json()["sources"]} == {first["id"], second["id"]}
    assert own.json()["card"]["name"] == "Sources éditables"

    none = client.patch(url, json={"source_ids": []})
    assert none.json()["sources"] == []
    assert none.json()["inheritance"]["sources_inherited"] is False

    back = client.patch(url, json={"source_ids": None})
    assert back.json()["inheritance"]["sources_inherited"] is True


def test_patch_refuses_an_empty_body_a_closed_mission_or_unknown_source(client: TestClient) -> None:
    mission = create(client, kind=MissionType.PROSPECTION, result_kind="companies")
    url = f"{MISSIONS}/{mission['card']['id']}"
    assert client.patch(url, json={}).status_code == 422
    assert client.patch(url, json={"source_ids": [str(uuid.uuid4())]}).status_code in (404, 422)
    assert client.patch(url, json={"status": "cancelled"}).status_code == 200
    assert client.patch(url, json={"source_ids": []}).status_code == 409
