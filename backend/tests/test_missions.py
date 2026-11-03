"""Missions: create the rule, launch a run, and let an agent work it over MCP.

The chain under test is the product's: a person writes « Complète ces fiches », the run creates one
task per linked record, an agent claims it with the mission's consigne, and the result waits for
the person's review. Nothing is written before that review.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Company, Mission, Prospect, ProspectSource
from app.models.agent_missions import AgentTask
from app.models.audit import AuditLogEntry
from app.models.enums import (
    MissionRunStatus,
    MissionRunTrigger,
    MissionStatus,
    MissionType,
    ProspectSourceType,
)
from app.models.prospects import ProspectNote
from app.services import mcp_tokens, missions
from tests.builders import add_company, add_email, add_phone, add_prospect, add_role

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
    assert listed["total"] == 1
    assert listed["items"][0]["targets_count"] == 1
    assert listed["items"][0]["runs_count"] == 0


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

    assert rpc(client, other, "viper_claim_task", {})["structuredContent"] == {"task": None}
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
    mission = db_session.scalar(select(Mission))
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

    assert created.status_code == 201, created.text
    mission_id = created.json()["card"]["id"]
    launched = client.post(f"{MISSIONS}/{mission_id}/run")

    assert launched.status_code == 422
    assert launched.json()["detail"]["field"] == "targets"
    assert launched.json()["detail"]["reason"] == "empty"


def test_a_mission_without_targets_cannot_run(client: TestClient, db_session: Session) -> None:
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

    assert response.status_code == 422
    assert response.json()["detail"]["field"] == "targets"
    db_session.expire_all()
    assert db_session.scalar(select(Mission)) is None


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


def test_the_scheduler_pauses_a_type_it_cannot_run(client: TestClient, db_session: Session) -> None:
    created = client.post(
        MISSIONS,
        json={
            "name": "Veille",
            "type": "signals",
            "prompt": "Trouve les nouveaux entrepôts.",
            "result_kind": "signals",
            "is_recurring": True,
            "interval_count": 1,
            "interval_unit": "days",
        },
    )
    assert created.status_code == 201, created.text
    mission = db_session.get(Mission, uuid.UUID(created.json()["card"]["id"]))
    assert mission is not None
    mission.next_run_at = datetime.now(UTC) - timedelta(minutes=5)
    db_session.flush()

    started = missions.run_due(db_session, now=datetime.now(UTC))

    assert started == []
    db_session.refresh(mission)
    assert mission.status is MissionStatus.PAUSED
    assert mission.next_run_at is None


def test_a_recurring_mission_starting_now_is_due_immediately(
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
    mission = db_session.get(Mission, uuid.UUID(detail["card"]["id"]))
    assert mission is not None
    assert mission.next_run_at is not None

    started = missions.run_due(db_session, now=datetime.now(UTC))

    assert len(started) == 1


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
    proposal = client.get(f"/api/agents/results/{result_id}").json()["proposal"]
    assert len(proposal["items"]) == 1
    assert proposal["refused"][0]["reason"] == "already_known"

    accepted = client.post(f"/api/agents/results/{result_id}/accept", json={})

    assert accepted.status_code == 200, accepted.text
    db_session.expire_all()
    created = db_session.scalar(select(Company).where(Company.display_name == "Logistique Y"))
    assert created is not None
    assert created.siren == "732829320"
    assert created.website_url == "https://logistique-y.fr"


def test_a_discovery_with_a_contacts_expectation_is_refused(
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

    assert response.status_code == 422
    assert response.json()["detail"]["field"] == "targets"


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


def test_a_signals_mission_without_companies_cannot_run(
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

    assert response.status_code == 422
    assert response.json()["detail"]["field"] == "targets"


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
    assert client.get(MISSIONS).json()["total"] == 0
    db_session.expire_all()
    # The task stays, cancelled and detached from the deleted run; the company is untouched.
    task = db_session.scalars(select(AgentTask)).one()
    assert (task.status.value, task.run_id, task.claim_id) == ("cancelled", None, None)
    assert db_session.get(Company, company.id) is not None
    actions = set(db_session.scalars(select(AuditLogEntry.action)).all())
    assert {"mission.deleted", "agent_task.cancelled"} <= actions
    # Already gone: a second delete is a 404, not a silent success.
    assert client.delete(f"{MISSIONS}/{mission_id}").status_code == 404
