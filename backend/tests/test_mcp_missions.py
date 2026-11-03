"""MCP mission actions (ChatGPT handoff, Slice 03): an assistant creates, modifies, launches,
pauses, resumes, cancels and deletes missions through the services the page uses, under the
capabilities of its delegated person's role. No tool creates a raw task.
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.api import mcp, mcp_missions
from app.api.routes.missions import MissionIn
from app.models.agent_missions import AgentTask
from app.models.audit import AuditLogEntry
from app.models.enums import AgentMode, AgentProvider, AgentTaskStatus, MissionType
from app.models.missions import Mission
from app.models.organizations import OrganizationRole
from app.services import agent_payloads, mcp_tokens
from tests.builders import add_company, add_user
from tests.test_mcp_tools import body, call
from tests.test_mcp_tools import mint as mint_worker

DESTRUCTIVE = {"readOnlyHint": False, "destructiveHint": True, "openWorldHint": False}
WRITE = {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": False}
READ = {"readOnlyHint": True, "destructiveHint": False, "openWorldHint": False}


def assistant(
    session: Session,
    role: OrganizationRole = OrganizationRole.MEMBER,
    capabilities: list[str] | None = None,
) -> str:
    """A ChatGPT-like assistant acting for a person of `role`."""
    email = f"{role.value}@circoe.com"
    add_user(session, email, display_name=f"Personne {role.value}", role=role)
    token, _ = mcp_tokens.mint(
        session,
        label=f"ChatGPT ({role.value})",
        scopes=["*"],
        owner_email=email,
        provider=AgentProvider.CHATGPT,
        mode=AgentMode.INTERACTIVE,
        capabilities=capabilities,
    )
    return token


def enrichment(company_id: Any, **extra: Any) -> dict[str, Any]:
    return {
        "name": "Compléter 2SN",
        "type": MissionType.ENRICHMENT.value,
        "prompt": "Complète le site web et le domaine e-mail.",
        "targets": [{"kind": "company", "id": str(company_id)}],
        "result_kind": "enrichment",
        **extra,
    }


def refused(answer: dict[str, Any], code: str) -> dict[str, Any]:
    assert answer["isError"] is True, answer
    content: dict[str, Any] = answer["structuredContent"]
    assert content["code"] == code, content
    return content


def missions_count(session: Session) -> int:
    return session.scalar(select(func.count()).select_from(Mission)) or 0


# --- catalogue -----------------------------------------------------------------------------------


def test_mission_tools_are_listed_with_their_annotations(
    client: TestClient, db_session: Session
) -> None:
    token = assistant(db_session)
    response = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={"Authorization": f"Bearer {token}"},
    )
    listed = {tool["name"]: tool for tool in response.json()["result"]["tools"]}

    assert {name: listed[name]["annotations"] for name in mcp_missions.BY_NAME} == {
        "viper_mission_options": READ,
        "viper_create_mission": WRITE,
        "viper_update_mission": WRITE,
        "viper_run_mission": WRITE,
        "viper_set_mission_status": DESTRUCTIVE,
        "viper_delete_mission": DESTRUCTIVE,
    }
    create_schema = listed["viper_create_mission"]["inputSchema"]
    assert set(create_schema["properties"]) == set(MissionIn.model_fields)
    assert create_schema["required"] == ["name", "type", "prompt"]
    assert "$ref" not in str(create_schema)
    assert create_schema["properties"]["type"]["enum"] == [kind.value for kind in MissionType]
    update_schema = listed["viper_update_mission"]["inputSchema"]
    assert update_schema["required"] == ["mission_id"]
    assert "run_now" not in update_schema["properties"]
    # Missions are created; tasks are VIPER's business.
    assert not any("create_task" in name for name in listed)


# --- creation ------------------------------------------------------------------------------------


def test_an_interactive_agent_creates_and_launches_a_mission_for_its_person(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    token = assistant(db_session)

    detail = body(call(client, token, "viper_create_mission", enrichment(company.id, run_now=True)))

    assert detail["card"]["status"] == "active"
    assert detail["card"]["runs_count"] == 1
    assert [target["label"] for target in detail["targets"]] == ["2SN"]
    assert [task["type"] for task in detail["tasks"]] == ["update_company"]
    mission = db_session.get(Mission, detail["card"]["id"])
    assert mission is not None
    assert mission.created_by_type == "agent"
    assert mission.created_by_display == "ChatGPT (member)"
    event = db_session.scalars(
        select(AuditLogEntry).where(AuditLogEntry.action == "mission.created")
    ).one()
    assert event.actor_type == "agent"
    assert event.context["on_behalf_of"]["display"] == "Personne member"


def test_a_worker_may_not_create_a_mission(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    worker = mint_worker(db_session)

    denied = refused(
        call(client, worker, "viper_create_mission", enrichment(company.id)), "capability_denied"
    )

    assert denied["capability"] == "missions.write"
    assert missions_count(db_session) == 0


def test_creating_and_launching_needs_missions_run_too(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    token = assistant(db_session, capabilities=["missions.read", "missions.write"])

    denied = refused(
        call(client, token, "viper_create_mission", enrichment(company.id, run_now=True)),
        "capability_denied",
    )

    assert denied["capability"] == "missions.run"
    assert missions_count(db_session) == 0
    # Without `run_now`, the same agent may create.
    assert body(call(client, token, "viper_create_mission", enrichment(company.id)))


def test_creation_refusals_come_from_the_input_model_and_the_service(
    client: TestClient, db_session: Session
) -> None:
    token = assistant(db_session)

    missing = refused(
        call(client, token, "viper_create_mission", {"type": "enrichment"}), "missing"
    )
    assert missing["field"] == "name"
    extra = refused(
        call(
            client,
            token,
            "viper_create_mission",
            {**enrichment(add_company(db_session).id), "priority": 1},
        ),
        "invalid",
    )
    assert extra["field"] == "priority"
    # A rule that could never produce a task: the service says why.
    no_target = refused(
        call(client, token, "viper_create_mission", {**enrichment(None), "targets": []}), "empty"
    )
    assert no_target["field"] == "targets"
    assert missions_count(db_session) == 0


# --- modification --------------------------------------------------------------------------------


def test_update_changes_only_what_is_sent_and_keeps_the_tasks_already_made(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    other = add_company(db_session, display_name="Nordis")
    token = assistant(db_session)
    created = body(
        call(client, token, "viper_create_mission", enrichment(company.id, run_now=True))
    )
    mission_id = created["card"]["id"]
    task = db_session.scalars(select(AgentTask)).one()
    lease = datetime.now(UTC) + timedelta(minutes=10)
    before = agent_payloads.build_payload(db_session, task, lease_expires_at=lease)

    updated = body(
        call(
            client,
            token,
            "viper_update_mission",
            {
                "mission_id": mission_id,
                "prompt": "Trouve aussi le numéro du standard.",
                "result_limit": 5,
                "targets": [{"kind": "company", "id": str(other.id)}],
            },
        )
    )

    assert updated["prompt"] == "Trouve aussi le numéro du standard."
    assert updated["result_limit"] == 5
    assert updated["card"]["name"] == "Compléter 2SN"
    assert [target["label"] for target in updated["targets"]] == ["Nordis"]
    # The task of the run already made keeps its subject and the rule it was created under.
    db_session.refresh(task)
    assert task.company_id == company.id
    assert task.status is AgentTaskStatus.PENDING
    after = agent_payloads.build_payload(db_session, task, lease_expires_at=lease)
    assert after == before
    # The next run follows the new rule.
    run = body(call(client, token, "viper_run_mission", {"mission_id": mission_id}))
    new_task = db_session.scalars(select(AgentTask).where(AgentTask.company_id == other.id)).one()
    assert str(new_task.run_id) == run["run_id"]
    payload = agent_payloads.build_payload(db_session, new_task, lease_expires_at=lease)
    assert payload["mission"]["prompt"] == "Trouve aussi le numéro du standard."


def test_update_refuses_run_now_and_an_unknown_mission(
    client: TestClient, db_session: Session
) -> None:
    token = assistant(db_session)
    unknown = "00000000-0000-0000-0000-000000000000"

    refused(call(client, token, "viper_update_mission", {"mission_id": unknown}), "not_found")
    refused(
        call(client, token, "viper_update_mission", {"mission_id": unknown, "run_now": True}),
        "invalid",
    )


# --- status: pause, resume, cancel; delete -------------------------------------------------------


def test_a_member_pauses_and_resumes_but_may_not_cancel_or_delete(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    token = assistant(db_session, OrganizationRole.MEMBER)
    mission_id = body(call(client, token, "viper_create_mission", enrichment(company.id)))["card"][
        "id"
    ]

    paused = body(
        call(
            client,
            token,
            "viper_set_mission_status",
            {"mission_id": mission_id, "status": "paused"},
        )
    )
    assert paused["card"]["status"] == "paused"
    resumed = body(
        call(
            client,
            token,
            "viper_set_mission_status",
            {"mission_id": mission_id, "status": "active"},
        )
    )
    assert resumed["card"]["status"] == "active"

    cancel = refused(
        call(
            client,
            token,
            "viper_set_mission_status",
            {"mission_id": mission_id, "status": "cancelled"},
        ),
        "capability_denied",
    )
    assert cancel["capability"] == "missions.cancel"
    delete = refused(
        call(client, token, "viper_delete_mission", {"mission_id": mission_id}),
        "capability_denied",
    )
    assert delete["capability"] == "missions.cancel"
    mission = db_session.get(Mission, mission_id)
    assert mission is not None
    db_session.refresh(mission)
    assert mission.status.value == "active"


def test_a_manager_cancels_and_deletes(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    token = assistant(db_session, OrganizationRole.MANAGER)
    first = body(call(client, token, "viper_create_mission", enrichment(company.id)))["card"]["id"]
    second = body(
        call(client, token, "viper_create_mission", enrichment(company.id, run_now=True))
    )["card"]["id"]

    cancelled = body(
        call(
            client, token, "viper_set_mission_status", {"mission_id": first, "status": "cancelled"}
        )
    )
    assert cancelled["card"]["status"] == "cancelled"
    # A closed mission is neither resumed nor modified.
    refused(
        call(client, token, "viper_set_mission_status", {"mission_id": first, "status": "active"}),
        "conflict",
    )
    refused(
        call(client, token, "viper_update_mission", {"mission_id": first, "name": "X"}), "conflict"
    )

    deleted = body(call(client, token, "viper_delete_mission", {"mission_id": second}))
    assert deleted == {"deleted": True, "mission_id": second}
    assert db_session.get(Mission, second) is None
    assert db_session.scalars(select(AgentTask)).one().status is AgentTaskStatus.CANCELLED


def test_status_must_be_one_an_assistant_may_set(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    token = assistant(db_session, OrganizationRole.MANAGER)
    mission_id = body(call(client, token, "viper_create_mission", enrichment(company.id)))["card"][
        "id"
    ]

    for status in ("done", "Cancelled", None):
        answer = call(
            client, token, "viper_set_mission_status", {"mission_id": mission_id, "status": status}
        )
        assert refused(answer, "format")["field"] == "status"


def test_run_refuses_a_paused_mission(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, display_name="2SN")
    token = assistant(db_session)
    mission_id = body(call(client, token, "viper_create_mission", enrichment(company.id)))["card"][
        "id"
    ]
    body(
        call(
            client,
            token,
            "viper_set_mission_status",
            {"mission_id": mission_id, "status": "paused"},
        )
    )

    refused(call(client, token, "viper_run_mission", {"mission_id": mission_id}), "conflict")


# --- options -------------------------------------------------------------------------------------


def test_options_list_the_form_choices_agents_and_targets(
    client: TestClient, db_session: Session
) -> None:
    add_company(db_session, display_name="2SN")
    token = assistant(db_session)

    answer = body(
        call(
            client,
            token,
            "viper_mission_options",
            {"target_kind": "company", "target_search": "2SN"},
        )
    )

    assert {row["value"] for row in answer["options"]["types"]} == {k.value for k in MissionType}
    assert "ChatGPT (member)" in {agent["label"] for agent in answer["agents"]}
    assert [target["label"] for target in answer["targets"]] == ["2SN"]
    assert "targets" not in body(call(client, token, "viper_mission_options", {}))
    refused(call(client, token, "viper_mission_options", {"target_kind": "x"}), "format")


def test_every_mission_tool_is_guarded(client: TestClient, db_session: Session) -> None:
    token, _ = mcp_tokens.mint(db_session, label="Sans droits", scopes=["*"], capabilities=[])

    for name in mcp_missions.BY_NAME:
        assert name in {tool["name"] for tool in mcp.TOOLS}
        refused(call(client, token, name, {}), "capability_denied")
