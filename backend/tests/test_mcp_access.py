"""Who may see and revoke an agent credential (`app.services.mcp_access`, mcp-server.md §4.8).

The owner (the agent's delegated person), an admin of its organisation, or the platform admin.
Anything else answers 404 `not_found`, like an unknown id, and stays out of the lists.
"""

import uuid
from collections.abc import Iterator

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.db.session import unit_of_work
from app.models.organizations import Organization, OrganizationRole
from app.models.users import User
from app.services import mcp_tokens
from tests.builders import add_user
from tests.test_mcp import call
from tests.test_oauth import connect, mcp
from tests.test_organizations import as_user

AGENTS = "/api/settings/mcp/agents"
CALLS = "/api/settings/mcp/calls"


def revoke(client: TestClient, agent_id: uuid.UUID | str) -> int:
    return client.post(f"{AGENTS}/{agent_id}/revoke").status_code


def alive(anonymous: TestClient, token: str) -> bool:
    return bool(mcp(anonymous, token).status_code == 200)


class People:
    """Two CIRCOE members, the pilot admin (`client`), an admin of another organisation and the
    platform admin, each with a signed-in client."""

    def __init__(self, app: FastAPI, factory: sessionmaker[Session], admin: TestClient) -> None:
        with unit_of_work(factory) as session:
            other = Organization(name="Autre SAS", email_domain="autre.fr")
            session.add(other)
            session.flush()
            self.other_organization_id = other.id
            self.marie = add_user(session, "marie@circoe.com", role=OrganizationRole.MEMBER)
            self.paul = add_user(session, "paul@circoe.com", role=OrganizationRole.MEMBER)
            outsider = add_user(
                session, "zoe@autre.fr", role=OrganizationRole.ADMIN, organization_id=other.id
            )
            root = add_user(
                session, "root@circoe.com", role=OrganizationRole.MEMBER, is_superadmin=True
            )
        self.clients = [as_user(app, factory, user) for user in (self.marie, self.paul)]
        self.clients += [as_user(app, factory, outsider), as_user(app, factory, root)]
        self.as_marie, self.as_paul, self.as_outsider, self.as_root = self.clients
        self.as_admin = admin

    def close(self) -> None:
        for client in self.clients:
            client.close()


@pytest.fixture
def people(
    app: FastAPI, session_factory: sessionmaker[Session], client: TestClient
) -> Iterator[People]:
    crowd = People(app, session_factory, client)
    yield crowd
    crowd.close()


def mint(session: Session, label: str, owner: User | None) -> tuple[str, uuid.UUID]:
    token, record = mcp_tokens.mint(
        session, label=label, scopes=["*"], owner_email=owner.email if owner else None
    )
    session.flush()
    return token, record.id


def test_a_member_revokes_their_own_agent(
    people: People, db_session: Session, anonymous_client: TestClient
) -> None:
    token, agent_id = mint(db_session, "Claude de Marie", people.marie)

    assert revoke(people.as_marie, agent_id) == 200
    assert not alive(anonymous_client, token)


def test_a_member_cannot_revoke_someone_elses_agent(
    people: People, db_session: Session, anonymous_client: TestClient, pilot_user: User
) -> None:
    paul_token, paul_agent = mint(db_session, "Claude de Paul", people.paul)
    admin_token, admin_agent = mint(db_session, "Claude du pilote", pilot_user)
    _, answer = connect(anonymous_client, people.as_paul)
    (oauth_agent,) = [a for a in people.as_paul.get(AGENTS).json() if a["origin"] == "oauth"]

    for agent_id in (paul_agent, admin_agent, oauth_agent["id"], uuid.uuid4()):
        response = people.as_marie.post(f"{AGENTS}/{agent_id}/revoke")
        # Same answer as an unknown id: a member cannot tell which agents exist.
        assert response.status_code == 404
        assert response.json()["detail"]["code"] == "not_found"

    assert alive(anonymous_client, paul_token)
    assert alive(anonymous_client, admin_token)
    assert alive(anonymous_client, answer["access_token"])


def test_an_admin_revokes_an_agent_of_their_organisation(
    people: People, db_session: Session, anonymous_client: TestClient
) -> None:
    token, agent_id = mint(db_session, "Claude de Marie", people.marie)
    _, answer = connect(anonymous_client, people.as_paul)
    (oauth_agent,) = [a for a in people.as_admin.get(AGENTS).json() if a["origin"] == "oauth"]

    assert revoke(people.as_admin, agent_id) == 200
    assert revoke(people.as_admin, oauth_agent["id"]) == 200
    assert not alive(anonymous_client, token)
    assert not alive(anonymous_client, answer["access_token"])


def test_an_admin_of_another_organisation_cannot_revoke(
    people: People, db_session: Session, anonymous_client: TestClient
) -> None:
    token, agent_id = mint(db_session, "Claude de Marie", people.marie)
    _, ownerless = mint(db_session, "Worker", None)

    assert revoke(people.as_outsider, agent_id) == 404
    assert revoke(people.as_outsider, ownerless) == 404
    assert people.as_outsider.get(AGENTS).json() == []
    assert alive(anonymous_client, token)


def test_the_platform_admin_revokes_any_agent(
    people: People, db_session: Session, anonymous_client: TestClient
) -> None:
    token, agent_id = mint(db_session, "Claude de Marie", people.marie)
    worker, ownerless = mint(db_session, "Worker", None)

    assert revoke(people.as_root, agent_id) == 200
    assert revoke(people.as_root, ownerless) == 200
    assert not alive(anonymous_client, token)
    assert not alive(anonymous_client, worker)


def test_an_agent_acting_for_nobody_is_revoked_by_an_admin_only(
    people: People, db_session: Session, anonymous_client: TestClient
) -> None:
    worker, ownerless = mint(db_session, "Worker", None)
    # An `owner_email` of no account: acting for nobody too.
    _, unowned = mcp_tokens.mint(
        db_session, label="Fantôme", scopes=["*"], owner_email="gone@circoe.com"
    )
    db_session.flush()

    assert revoke(people.as_marie, ownerless) == 404
    assert revoke(people.as_marie, unowned.id) == 404
    assert alive(anonymous_client, worker)
    assert revoke(people.as_admin, ownerless) == 200
    assert revoke(people.as_admin, unowned.id) == 200
    assert not alive(anonymous_client, worker)


def test_the_lists_follow_the_same_rule(
    people: People, db_session: Session, client: TestClient, pilot_user: User
) -> None:
    marie_token, marie_agent = mint(db_session, "Claude de Marie", people.marie)
    paul_token, paul_agent = mint(db_session, "Claude de Paul", people.paul)
    _, admin_agent = mint(db_session, "Claude du pilote", pilot_user)
    _, ownerless = mint(db_session, "Worker", None)
    call(client, marie_token, "viper_list_companies", {})
    call(client, paul_token, "viper_list_companies", {})

    def agents(viewer: TestClient) -> set[str]:
        return {agent["id"] for agent in viewer.get(AGENTS).json()}

    everyone = {str(i) for i in (marie_agent, paul_agent, admin_agent, ownerless)}
    assert agents(people.as_marie) == {str(marie_agent)}
    assert agents(people.as_admin) == everyone
    assert agents(people.as_root) == everyone

    mine = people.as_marie.get(CALLS).json()
    assert [row["agent"] for row in mine["calls"]] == ["Claude de Marie"]
    # The filters do not leak the other people of the history either.
    assert mine["emails"] == ["marie@circoe.com"]
    asked_for_paul = people.as_marie.get(CALLS, params={"agent_id": str(paul_agent)}).json()
    assert asked_for_paul["calls"] == []
    assert people.as_outsider.get(CALLS).json()["calls"] == []
    assert len(people.as_admin.get(CALLS).json()["calls"]) == 2
    assert len(people.as_root.get(CALLS).json()["calls"]) == 2


def test_a_deactivated_admin_manages_nothing(
    app: FastAPI, session_factory: sessionmaker[Session], db_session: Session, people: People
) -> None:
    with unit_of_work(session_factory) as session:
        former = add_user(session, "ancien@circoe.com", role=OrganizationRole.ADMIN)
    as_former = as_user(app, session_factory, former)
    _, agent_id = mint(db_session, "Claude de Marie", people.marie)
    stored = db_session.get(User, former.id)
    assert stored is not None
    # The session stays open: the service itself must refuse an inactive admin.
    stored.is_active = False
    db_session.flush()

    with as_former:
        assert as_former.get(AGENTS).json() == []
        assert revoke(as_former, agent_id) == 404


def test_an_admin_manages_the_agents_of_their_own_members_elsewhere(
    db_session: Session, people: People, anonymous_client: TestClient
) -> None:
    # The token row keeps the default organisation (CIRCOE): the agent's organisation is its
    # owner's, not the token's `organization_id`.
    member = add_user(
        db_session,
        "luc@autre.fr",
        role=OrganizationRole.MEMBER,
        organization_id=people.other_organization_id,
    )
    token, agent_id = mint(db_session, "Claude de Luc", member)

    assert {agent["id"] for agent in people.as_outsider.get(AGENTS).json()} == {str(agent_id)}
    assert revoke(people.as_admin, agent_id) == 404
    assert revoke(people.as_outsider, agent_id) == 200
    assert not alive(anonymous_client, token)


def test_the_tool_filter_lists_only_the_tools_of_managed_agents(
    people: People, db_session: Session, client: TestClient
) -> None:
    marie_token, _ = mint(db_session, "Claude de Marie", people.marie)
    paul_token, _ = mint(db_session, "Claude de Paul", people.paul)
    call(client, marie_token, "viper_list_companies", {})
    call(client, paul_token, "viper_list_prospects", {})

    assert people.as_marie.get(CALLS).json()["tools"] == ["viper_list_companies"]
    assert people.as_paul.get(CALLS).json()["tools"] == ["viper_list_prospects"]
    assert people.as_admin.get(CALLS).json()["tools"] == [
        "viper_list_companies",
        "viper_list_prospects",
    ]
