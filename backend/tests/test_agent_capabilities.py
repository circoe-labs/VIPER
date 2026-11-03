"""Agent capabilities (ChatGPT handoff, Slice 01): the vocabulary, the intersection with the
delegated person's role, the single `require` guard, `viper_whoami`, the audit attribution
« agent X pour Y », the « Créer un jeton » route and migration 0025.
"""

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from alembic import command
from fastapi.testclient import TestClient
from sqlalchemy import Engine, select, text, update
from sqlalchemy.orm import Session

from app.api import mcp
from app.models import User
from app.models.audit import AuditLogEntry
from app.models.enums import AgentMode, AgentProvider
from app.models.mcp import McpCall, McpToken
from app.models.oauth import OAuthAuthorization
from app.models.organizations import CIRCOE_NAME, OrganizationRole
from app.services import agent_capabilities as caps
from app.services import mcp_tokens
from app.services.agent_capabilities import AgentGrant
from app.services.errors import CapabilityDeniedError
from tests.builders import PILOT_EMAIL, add_company, add_user
from tests.support import alembic_config, reset_database
from tests.test_mcp import call
from tests.test_oauth import connect

AGENTS = "/api/settings/mcp/agents"


def whoami(client: TestClient, token: str) -> dict[str, Any]:
    result = call(client, token, "viper_whoami", {})
    assert result["isError"] is False, result
    body: dict[str, Any] = result["structuredContent"]
    return body


def pilot(session: Session) -> User:
    return session.scalars(select(User).where(User.email == PILOT_EMAIL)).one()


# --- the vocabulary and the intersection --------------------------------------------------------


def test_the_vocabulary_is_closed_and_ordered() -> None:
    assert caps.normalize(["missions.run", "tasks.work", "missions.run"]) == [
        "tasks.work",
        "missions.run",
    ]
    with pytest.raises(ValueError, match=r"missions\.delete"):
        caps.normalize(["missions.delete"])
    assert set(caps.CAPABILITY_LABELS) == set(caps.CAPABILITIES)
    assert caps.defaults(AgentMode.WORKER) == ["tasks.work", "records.read", "records.propose"]
    assert "missions.write" not in caps.defaults(AgentMode.SCHEDULED)


def test_effective_capabilities_are_the_agent_and_the_role_intersected(
    db_session: Session,
) -> None:
    member = add_user(db_session, "membre@circoe.com", role=OrganizationRole.MEMBER)
    manager = add_user(db_session, "manager@circoe.com", role=OrganizationRole.MANAGER)
    everything = caps.CAPABILITIES

    assert caps.MISSIONS_CANCEL not in caps.intersect(everything, member)
    assert {caps.MISSIONS_WRITE, caps.MISSIONS_RUN, caps.MISSIONS_PAUSE} <= caps.intersect(
        everything, member
    )
    assert caps.MISSIONS_CANCEL in caps.intersect(everything, manager)
    # The role never adds what the agent does not have.
    assert caps.intersect(["tasks.work"], manager) == {"tasks.work"}
    # No delegated person: only the agent's own capabilities count.
    assert caps.intersect(["tasks.work", "missions.cancel"], None) == {
        "tasks.work",
        "missions.cancel",
    }
    member.is_active = False
    assert caps.intersect(everything, member) == frozenset()


def test_the_provider_is_read_from_the_oauth_client_name() -> None:
    assert caps.provider_for_client("ChatGPT") is AgentProvider.CHATGPT
    assert caps.provider_for_client("OpenAI connector") is AgentProvider.CHATGPT
    assert caps.provider_for_client("claude.ai") is AgentProvider.CLAUDE
    assert caps.provider_for_client("ChatX worker") is AgentProvider.CHATX
    assert caps.provider_for_client("Mon client") is AgentProvider.OTHER


# --- the guard ---------------------------------------------------------------------------------


def _grant(record: McpToken, capabilities: list[str]) -> AgentGrant:
    return AgentGrant(
        token=record, delegate=None, organization=None, capabilities=frozenset(capabilities)
    )


def test_require_refuses_missions_write_to_a_worker(db_session: Session) -> None:
    _, record = mcp_tokens.mint(db_session, label="Worker", scopes=["*"])
    assert record.mode is AgentMode.WORKER

    _, other = mcp_tokens.mint(db_session, label="Autre", scopes=["*"])

    with mcp.granted(caps.grant_for(db_session, record)):
        mcp.require(record, "tasks.work")
        with pytest.raises(CapabilityDeniedError) as refused:
            mcp.require(record, "missions.write")
        # The grant of this request never lends its rights to another agent.
        with pytest.raises(CapabilityDeniedError):
            mcp.require(other, "tasks.work")
    assert refused.value.capability == "missions.write"
    # Outside a request nothing is allowed, and a typo is a programming error.
    with pytest.raises(CapabilityDeniedError):
        mcp.require(record, "tasks.work")
    with mcp.granted(_grant(record, list(caps.CAPABILITIES))), pytest.raises(ValueError):
        mcp.require(record, "missions.delete")


def test_every_tool_but_whoami_requires_a_capability(
    client: TestClient, db_session: Session
) -> None:
    token, _ = mcp_tokens.mint(db_session, label="Sans droits", scopes=["*"], capabilities=[])

    for tool in mcp.TOOLS:
        result = call(client, token, tool["name"], {})
        if tool["name"] == "viper_whoami":
            assert result["isError"] is False
            continue
        assert result["isError"] is True, tool["name"]
        assert result["structuredContent"]["code"] == "capability_denied", tool["name"]


def test_a_refusal_is_explicit_and_kept_in_the_call_history(
    client: TestClient, db_session: Session
) -> None:
    token, record = mcp_tokens.mint(
        db_session, label="Lecteur", scopes=["*"], capabilities=["records.read"]
    )

    refused = call(client, token, "viper_claim_task", {})

    assert refused["isError"] is True
    body = refused["structuredContent"]
    assert body["code"] == "capability_denied"
    assert body["capability"] == "tasks.work"
    assert "viper_whoami" in body["message"]
    row = db_session.scalars(select(McpCall).where(McpCall.token_id == record.id)).one()
    assert (row.outcome, row.error_code) == ("refused", "capability_denied")


def test_a_worker_keeps_its_tools(client: TestClient, db_session: Session) -> None:
    token, _ = mcp_tokens.mint(db_session, label="Worker", scopes=["*"])
    company = add_company(db_session, display_name="2SN")

    assert call(client, token, "viper_task_queue", {})["isError"] is False
    assert (
        call(client, token, "viper_get_company", {"company_id": str(company.id)})["isError"]
        is False
    )
    proposed = call(
        client,
        token,
        "viper_update_company",
        {"company_id": str(company.id), "result": {"legal_name": "2SN SAS", "confidence": 80}},
    )
    assert proposed["structuredContent"].get("code") != "capability_denied"


# --- viper_whoami -------------------------------------------------------------------------------


def test_whoami_for_a_bearer_worker(client: TestClient, db_session: Session) -> None:
    token, record = mcp_tokens.mint(db_session, label="Agent claude-01", scopes=["update_company"])

    me = whoami(client, token)

    assert me["agent_id"] == str(record.id)
    assert (me["label"], me["provider"], me["mode"]) == ("Agent claude-01", "other", "worker")
    # A worker without owner acts for nobody: only its own capabilities count.
    assert me["delegated_user"] is None
    assert me["organization"]["name"] == CIRCOE_NAME
    assert me["capabilities"] == ["tasks.work", "records.read", "records.propose"]
    assert me["task_types"] == ["update_company"]
    assert me["restriction"] is None
    assert me["version"] == mcp.SERVER_INFO["version"]


def test_whoami_for_an_interactive_bearer_token_bounded_by_its_owner(
    client: TestClient, db_session: Session
) -> None:
    add_user(db_session, "membre@circoe.com", display_name="Marie", role=OrganizationRole.MEMBER)
    token, _ = mcp_tokens.mint(
        db_session,
        label="ChatGPT de Marie",
        scopes=["*"],
        owner_email="membre@circoe.com",
        provider=AgentProvider.CHATGPT,
        mode=AgentMode.INTERACTIVE,
    )

    me = whoami(client, token)

    assert me["delegated_user"]["email"] == "membre@circoe.com"
    assert me["delegated_user"]["role"] == "member"
    assert "missions.cancel" not in me["capabilities"]
    assert "missions.write" in me["capabilities"]


# --- an owner's rights end with the owner (every mode) ------------------------------------------


def test_a_worker_made_by_a_member_stops_when_the_member_is_deactivated(
    client: TestClient, db_session: Session
) -> None:
    person = pilot(db_session)
    person.role = OrganizationRole.MEMBER
    db_session.flush()
    company = add_company(db_session, display_name="2SN")
    created = client.post(AGENTS, json={"label": "Worker", "mode": "worker"}).json()
    token = created["token"]
    read = {"company_id": str(company.id)}
    assert call(client, token, "viper_get_company", read)["isError"] is False
    assert whoami(client, token)["delegated_user"]["email"] == PILOT_EMAIL

    person.is_active = False
    db_session.flush()

    refused = call(client, token, "viper_get_company", read)
    assert refused["structuredContent"]["code"] == "capability_denied"
    me = whoami(client, token)
    assert me["capabilities"] == []
    assert me["restriction"] == "delegated_user_inactive"


def test_a_worker_loses_what_its_demoted_owner_may_no_longer_lend(
    client: TestClient, db_session: Session
) -> None:
    created = client.post(
        AGENTS,
        json={
            "label": "Worker",
            "mode": "worker",
            "capabilities": ["records.read", "missions.cancel"],
        },
    ).json()
    token = created["token"]
    assert whoami(client, token)["capabilities"] == ["records.read", "missions.cancel"]

    pilot(db_session).role = OrganizationRole.MEMBER
    db_session.flush()

    me = whoami(client, token)
    assert me["capabilities"] == ["records.read"]
    assert me["restriction"] is None


@pytest.mark.parametrize("mode", list(AgentMode))
def test_a_token_whose_owner_has_no_account_may_do_nothing(
    client: TestClient, db_session: Session, mode: AgentMode
) -> None:
    token, _ = mcp_tokens.mint(
        db_session, label="Fantôme", scopes=["*"], owner_email="ghost@x.com", mode=mode
    )

    me = whoami(client, token)

    assert me["capabilities"] == []
    assert me["delegated_user"] is None
    assert me["restriction"] == "delegated_user_missing"
    refused = call(client, token, "viper_list_companies", {})
    assert refused["structuredContent"]["code"] == "capability_denied"


def test_an_oauth_connector_whose_approver_is_gone_may_do_nothing(
    anonymous_client: TestClient, client: TestClient, db_session: Session
) -> None:
    _, answer = connect(anonymous_client, client)
    access = answer["access_token"]
    assert whoami(anonymous_client, access)["capabilities"] == list(caps.CAPABILITIES)

    # What `ON DELETE SET NULL` leaves when the approving account is deleted.
    db_session.execute(update(OAuthAuthorization).values(user_id=None))
    db_session.flush()

    me = whoami(anonymous_client, access)
    assert me["capabilities"] == []
    assert me["delegated_user"] is None
    assert me["restriction"] == "delegated_user_missing"
    refused = call(anonymous_client, access, "viper_list_companies", {})
    assert refused["structuredContent"]["code"] == "capability_denied"


def test_whoami_for_an_oauth_connector(
    anonymous_client: TestClient, client: TestClient, db_session: Session
) -> None:
    _, answer = connect(anonymous_client, client)
    access = answer["access_token"]

    me = whoami(anonymous_client, access)

    assert (me["provider"], me["mode"]) == ("chatgpt", "interactive")
    assert me["label"] == "ChatGPT (OAuth)"
    assert me["delegated_user"]["email"] == PILOT_EMAIL
    assert me["delegated_user"]["role"] == "admin"
    assert me["capabilities"] == list(caps.CAPABILITIES)

    # The role is read at each call: a person demoted to member loses `missions.cancel`.
    person = pilot(db_session)
    person.role = OrganizationRole.MEMBER
    db_session.flush()
    assert "missions.cancel" not in whoami(anonymous_client, access)["capabilities"]

    # A deactivated person lends no right at all.
    person.is_active = False
    db_session.flush()
    me = whoami(anonymous_client, access)
    assert me["capabilities"] == []
    assert me["restriction"] == "delegated_user_inactive"
    claimed = call(anonymous_client, access, "viper_task_queue", {})
    assert claimed["structuredContent"]["code"] == "capability_denied"


# --- audit: « agent X pour Y » -----------------------------------------------------------------


def test_an_agent_acting_for_a_person_stays_the_actor_and_carries_that_person(
    anonymous_client: TestClient, client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, display_name="2SN")
    _, answer = connect(anonymous_client, client)

    proposed = call(
        anonymous_client,
        answer["access_token"],
        "viper_update_company",
        {"company_id": str(company.id), "result": {"legal_name": "2SN SAS", "confidence": 80}},
    )
    assert proposed["isError"] is False, proposed

    events = db_session.scalars(
        select(AuditLogEntry).where(AuditLogEntry.action == "agent_task.created")
    ).all()
    assert events
    event = events[-1]
    assert event.actor_type == "agent"
    assert event.actor_display == "ChatGPT (OAuth)"
    assert event.context["source"] == "agent"
    assert event.context["on_behalf_of"]["display"] == "Pilote Test"
    assert event.context["on_behalf_of"]["type"] == "human"


# --- Paramètres > MCP ---------------------------------------------------------------------------


def test_settings_list_the_vocabulary_and_each_agent_mode(
    client: TestClient, db_session: Session
) -> None:
    mcp_tokens.mint(db_session, label="Worker", scopes=["*"])

    settings = client.get("/api/settings/mcp").json()
    assert [item["name"] for item in settings["capabilities"]] == list(caps.CAPABILITIES)
    assert settings["mode_defaults"]["worker"] == caps.defaults(AgentMode.WORKER)

    agent = client.get(AGENTS).json()[0]
    assert (agent["mode"], agent["provider"]) == ("worker", "other")
    assert agent["capabilities"] == caps.defaults(AgentMode.WORKER)


def test_create_a_token_with_its_mode_and_capabilities(
    client: TestClient, db_session: Session
) -> None:
    response = client.post(
        AGENTS,
        json={
            "label": "ChatGPT planifié",
            "provider": "chatgpt",
            "mode": "scheduled",
            "capabilities": ["missions.read", "records.read"],
        },
    )

    assert response.status_code == 201, response.text
    created = response.json()
    assert created["token"].startswith(mcp_tokens.TOKEN_PREFIX)
    assert created["agent"]["mode"] == "scheduled"
    assert created["agent"]["capabilities"] == ["records.read", "missions.read"]
    assert created["agent"]["owner_email"] == PILOT_EMAIL
    me = whoami(client, created["token"])
    assert me["capabilities"] == ["records.read", "missions.read"]
    # Shown once: the list never carries it.
    assert "token" not in client.get(AGENTS).json()[0]

    defaults = client.post(AGENTS, json={"label": "Worker", "mode": "worker"}).json()
    assert defaults["agent"]["capabilities"] == caps.defaults(AgentMode.WORKER)


def test_nobody_grants_more_than_their_role(client: TestClient, db_session: Session) -> None:
    pilot(db_session).role = OrganizationRole.MEMBER
    db_session.flush()

    refused = client.post(
        AGENTS, json={"label": "Worker", "mode": "worker", "capabilities": ["missions.cancel"]}
    )
    assert refused.status_code == 403, refused.text
    assert refused.json()["detail"]["code"] == "forbidden"

    unknown = client.post(AGENTS, json={"label": "X", "capabilities": ["missions.delete"]})
    assert unknown.status_code == 422
    assert unknown.json()["detail"]["field"] == "capabilities"


# --- migration 0025 -----------------------------------------------------------------------------


@pytest.fixture
def migration_database(engine: Engine, test_database_url: str) -> Iterator[str]:
    try:
        yield test_database_url
    finally:
        reset_database(engine, test_database_url)


def test_0025_backfills_workers_and_oauth_connectors_and_downgrades(
    engine: Engine, migration_database: str
) -> None:
    config = alembic_config(migration_database)
    command.downgrade(config, "0024")
    worker, connector = uuid.uuid4(), uuid.uuid4()
    with engine.begin() as connection:
        assert (
            connection.execute(
                text(
                    "SELECT count(*) FROM information_schema.columns "
                    "WHERE table_name = 'mcp_tokens' AND column_name = 'capabilities'"
                )
            ).scalar_one()
            == 0
        )
        user = connection.execute(
            text(
                "INSERT INTO users (email, display_name) "
                "VALUES ('pilote@circoe.com', 'Pilote') RETURNING id"
            )
        ).scalar_one()
        client_pk = connection.execute(
            text(
                "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, auth_method) "
                "VALUES ('c1', 'ChatGPT', '[]'::jsonb, 'none') RETURNING id"
            )
        ).scalar_one()
        for token_id, label in ((worker, "Worker"), (connector, "ChatGPT (OAuth)")):
            connection.execute(
                text(
                    "INSERT INTO mcp_tokens (id, label, token_hash, scopes) "
                    "VALUES (:id, :label, :hash, '[\"*\"]'::jsonb)"
                ),
                {"id": token_id, "label": label, "hash": uuid.uuid4().hex * 2},
            )
        connection.execute(
            text(
                "INSERT INTO oauth_authorizations (client_pk, redirect_uri, code_challenge, "
                "status, code_hash, user_id, mcp_token_id, expires_at) VALUES (:client, "
                "'https://chatgpt.com/cb', 'x', 'used', :hash, :user, :token, now())"
            ),
            {"client": client_pk, "hash": uuid.uuid4().hex * 2, "user": user, "token": connector},
        )

    command.upgrade(config, "0025")

    with engine.connect() as connection:
        rows = {
            row.id: row
            for row in connection.execute(
                text("SELECT id, provider, mode, capabilities FROM mcp_tokens")
            )
        }
    assert (rows[worker].provider, rows[worker].mode) == ("other", "worker")
    assert rows[worker].capabilities == caps.defaults(AgentMode.WORKER)
    assert (rows[connector].provider, rows[connector].mode) == ("chatgpt", "interactive")
    assert rows[connector].capabilities == list(caps.CAPABILITIES)

    command.downgrade(config, "0024")
    with engine.connect() as connection:
        columns = connection.execute(
            text(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = 'mcp_tokens' AND column_name IN "
                "('provider', 'mode', 'capabilities')"
            )
        ).all()
    assert columns == []
