"""Organisations, roles and « Se connecter avec Infomaniak » (doc/architecture/organizations.md)."""

import uuid
from collections.abc import Iterator
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.api.session_cookie import CSRF_HEADER, SESSION_COOKIE
from app.core.security import csrf_token
from app.db.session import unit_of_work
from app.models.organizations import CIRCOE_ORGANIZATION_ID, OrganizationRole
from app.models.users import User
from app.services.auth import SessionPolicy, open_session
from tests.builders import PILOT_PASSWORD, add_user
from tests.support import TEST_BASE_URL

ORGS = "/api/organizations"
CIRCOE = str(CIRCOE_ORGANIZATION_ID)


class FakeInfomaniak:
    """Token and userinfo endpoints; `claims` is who signs in."""

    def __init__(self) -> None:
        self.claims: dict[str, Any] = {
            "sub": "1001",
            "email": "Marie.Durand@circoe.com",
            "email_verified": True,
            "name": "Marie Durand",
        }
        self.token_form: dict[str, list[str]] = {}

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        if request.url.path == "/token":
            self.token_form = parse_qs(request.content.decode())
            return httpx2.Response(200, json={"access_token": "at-1", "token_type": "Bearer"})
        if request.url.path == "/oauth2/userinfo":
            assert request.headers["authorization"] == "Bearer at-1"
            return httpx2.Response(200, json=self.claims)
        return httpx2.Response(404)


@pytest.fixture
def infomaniak(app: FastAPI) -> FakeInfomaniak:
    fake = FakeInfomaniak()
    app.state.settings = app.state.settings.model_copy(
        update={
            "infomaniak_login_enabled": True,
            "infomaniak_client_id": "viper-id",
            "infomaniak_client_secret": SecretStr("s3"),
        }
    )
    app.state.infomaniak_transport = httpx2.MockTransport(fake.handle)
    return fake


def sign_in(anonymous: TestClient) -> httpx2.Response:
    started = anonymous.get("/api/auth/infomaniak", follow_redirects=False)
    assert started.status_code == 302
    state = parse_qs(urlsplit(started.headers["location"]).query)["state"][0]
    return anonymous.get(
        "/api/auth/infomaniak/callback",
        params={"code": "code-1", "state": state},
        follow_redirects=False,
    )


def as_user(app: FastAPI, factory: sessionmaker[Session], user: User) -> TestClient:
    with unit_of_work(factory) as session:
        token = open_session(session, user, SessionPolicy.from_settings(app.state.settings)).token
    return TestClient(
        app,
        base_url=TEST_BASE_URL,
        cookies={SESSION_COOKIE: token},
        headers={CSRF_HEADER: csrf_token(token)},
    )


@pytest.fixture
def make_client(app: FastAPI, session_factory: sessionmaker[Session]) -> Iterator[Any]:
    def make(role: OrganizationRole, email: str, **extra: Any) -> tuple[TestClient, User]:
        with unit_of_work(session_factory) as session:
            user = add_user(session, email=email, display_name=email, role=role, **extra)
        return as_user(app, session_factory, user), user

    yield make


# --- Sign-in ------------------------------------------------------------------------------------


def test_the_first_infomaniak_sign_in_of_a_circoe_address_joins_circoe(
    anonymous_client: TestClient, infomaniak: FakeInfomaniak, db_session: Session
) -> None:
    started = anonymous_client.get("/api/auth/infomaniak", follow_redirects=False)
    query = parse_qs(urlsplit(started.headers["location"]).query)
    assert started.headers["location"].startswith("https://login.infomaniak.com/authorize?")
    assert (query["client_id"], query["code_challenge_method"]) == (["viper-id"], ["S256"])
    assert query["redirect_uri"][0].endswith("/api/auth/infomaniak/callback")

    back = anonymous_client.get(
        "/api/auth/infomaniak/callback",
        params={"code": "code-1", "state": query["state"][0]},
        follow_redirects=False,
    )

    assert (back.status_code, back.headers["location"]) == (302, "/")
    assert infomaniak.token_form["client_secret"] == ["s3"]
    assert infomaniak.token_form["code_verifier"]
    me = anonymous_client.get("/api/auth/session").json()["user"]
    assert (me["email"], me["role"], me["organization"]["name"]) == (
        "marie.durand@circoe.com",
        "member",
        "CIRCOE",
    )
    user = db_session.scalar(select(User).where(User.email == "marie.durand@circoe.com"))
    assert user is not None and user.infomaniak_sub == "1001" and user.password_hash is None


def test_an_address_outside_circoe_is_refused(
    anonymous_client: TestClient, infomaniak: FakeInfomaniak, db_session: Session
) -> None:
    infomaniak.claims["email"] = "someone@gmail.com"

    back = sign_in(anonymous_client)

    assert back.headers["location"] == "/login?erreur=domain"
    assert anonymous_client.get("/api/auth/session").status_code == 401
    assert db_session.scalar(select(User).where(User.email == "someone@gmail.com")) is None


def test_a_forged_state_or_a_deactivated_account_does_not_sign_in(
    anonymous_client: TestClient, infomaniak: FakeInfomaniak, db_session: Session
) -> None:
    anonymous_client.get("/api/auth/infomaniak", follow_redirects=False)
    forged = anonymous_client.get(
        "/api/auth/infomaniak/callback",
        params={"code": "c", "state": "attacker"},
        follow_redirects=False,
    )
    assert forged.headers["location"] == "/login?erreur=expired"

    add_user(db_session, email="marie.durand@circoe.com", is_active=False)
    assert sign_in(anonymous_client).headers["location"] == "/login?erreur=inactive"


def test_infomaniak_replaces_the_password_once_configured(
    anonymous_client: TestClient, app: FastAPI, pilot_user: User
) -> None:
    credentials = {"email": pilot_user.email, "password": PILOT_PASSWORD}
    assert anonymous_client.get("/api/auth/methods").json() == {
        "infomaniak": False,
        "password": True,
    }
    assert anonymous_client.post("/api/auth/login", json=credentials).status_code == 200

    app.state.settings = app.state.settings.model_copy(
        update={
            "infomaniak_login_enabled": True,
            "infomaniak_client_id": "id",
            "infomaniak_client_secret": SecretStr("s"),
        }
    )

    assert anonymous_client.get("/api/auth/methods").json() == {
        "infomaniak": True,
        "password": False,
    }
    assert anonymous_client.post("/api/auth/login", json=credentials).status_code == 403


def test_the_configured_address_becomes_the_single_platform_admin(
    anonymous_client: TestClient, infomaniak: FakeInfomaniak, db_session: Session
) -> None:
    infomaniak.claims["email"] = "e.debazelaire@circoe.com"

    sign_in(anonymous_client)

    me = anonymous_client.get("/api/auth/session").json()["user"]
    assert (me["is_superadmin"], me["role"]) == (True, "admin")


# --- Rights -------------------------------------------------------------------------------------


def test_only_the_platform_admin_creates_organisations(make_client: Any) -> None:
    root, _ = make_client(OrganizationRole.ADMIN, "root@circoe.com", is_superadmin=True)
    admin, _ = make_client(OrganizationRole.ADMIN, "admin@circoe.com")

    body = {"name": "Acme", "email_domain": "acme.fr"}
    assert admin.post(ORGS, json=body).status_code == 403
    created = root.post(ORGS, json=body)
    assert created.status_code == 201, created.text
    assert created.json()["organization"]["email_domain"] == "acme.fr"
    assert {item["name"] for item in root.get(ORGS).json()["organizations"]} == {"Acme", "CIRCOE"}
    # An admin only sees their own organisation, and not another one's members.
    assert [item["name"] for item in admin.get(ORGS).json()["organizations"]] == ["CIRCOE"]
    other = created.json()["organization"]["id"]
    assert admin.get(f"{ORGS}/{other}").status_code == 404
    assert root.post(ORGS, json={"name": "acme"}).json()["detail"]["field"] == "name"


def test_what_each_role_may_do_with_members(make_client: Any) -> None:
    admin, admin_user = make_client(OrganizationRole.ADMIN, "admin@circoe.com")
    manager, manager_user = make_client(OrganizationRole.MANAGER, "manager@circoe.com")
    member, _ = make_client(OrganizationRole.MEMBER, "member@circoe.com")
    members = f"{ORGS}/{CIRCOE}/members"

    def add(client: TestClient, email: str, role: str) -> Any:
        return client.post(members, json={"email": email, "display_name": email, "role": role})

    assert member.get(f"{ORGS}/{CIRCOE}").json()["assignable_roles"] == []
    assert add(member, "a@circoe.com", "member").status_code == 403
    assert manager.get(f"{ORGS}/{CIRCOE}").json()["assignable_roles"] == ["member"]
    assert add(manager, "b@circoe.com", "admin").status_code == 403
    added = add(manager, "c@circoe.com", "member")
    assert added.status_code == 201, added.text
    newcomer = added.json()["id"]
    # A manager (de)activates a member but does not change roles.
    assert manager.patch(f"{members}/{newcomer}", json={"role": "manager"}).status_code == 403
    assert manager.patch(f"{members}/{newcomer}", json={"is_active": False}).status_code == 200
    assert manager.patch(f"{members}/{admin_user.id}", json={"is_active": False}).status_code == 403
    # An admin gives any role; nobody changes themselves.
    promoted = admin.patch(f"{members}/{newcomer}", json={"role": "manager", "is_active": True})
    assert promoted.json()["role"] == "manager"
    assert admin.patch(f"{members}/{admin_user.id}", json={"role": "member"}).status_code == 403
    assert add(admin, "c@circoe.com", "member").status_code == 409
    listed = {row["email"]: row for row in admin.get(f"{ORGS}/{CIRCOE}").json()["members"]}
    assert listed["manager@circoe.com"]["can_change_role"] is True
    assert listed["admin@circoe.com"]["can_edit"] is False
    assert manager_user.id


def test_deactivating_a_member_ends_their_sessions(make_client: Any) -> None:
    admin, _ = make_client(OrganizationRole.ADMIN, "admin@circoe.com")
    member, member_user = make_client(OrganizationRole.MEMBER, "member@circoe.com")
    assert member.get("/api/auth/session").status_code == 200

    response = admin.patch(f"{ORGS}/{CIRCOE}/members/{member_user.id}", json={"is_active": False})

    assert response.status_code == 200
    assert member.get("/api/auth/session").status_code == 401


def test_an_organisation_keeps_an_active_admin(make_client: Any) -> None:
    root, _ = make_client(OrganizationRole.ADMIN, "root@circoe.com", is_superadmin=True)
    acme = root.post(ORGS, json={"name": "Acme"}).json()["organization"]["id"]
    boss = root.post(
        f"{ORGS}/{acme}/members",
        json={"email": "boss@acme.fr", "display_name": "Boss", "role": "admin"},
    ).json()["id"]

    demoted = root.patch(f"{ORGS}/{acme}/members/{boss}", json={"role": "member"})

    assert (demoted.status_code, demoted.json()["detail"]["code"]) == (409, "conflict")


def test_the_platform_admin_is_out_of_reach(make_client: Any) -> None:
    admin, _ = make_client(OrganizationRole.ADMIN, "admin@circoe.com")
    _, root_user = make_client(OrganizationRole.ADMIN, "root@circoe.com", is_superadmin=True)

    refused = admin.patch(f"{ORGS}/{CIRCOE}/members/{root_user.id}", json={"is_active": False})

    assert refused.status_code == 403


def test_only_an_admin_resets_the_prospecting_data(make_client: Any) -> None:
    manager, _ = make_client(OrganizationRole.MANAGER, "manager@circoe.com")

    refused = manager.post(
        "/api/database/reset-prospecting", json={"confirmation": "RESET_PROSPECTING_DATA"}
    )

    assert refused.status_code == 403


def test_every_record_belongs_to_circoe(client: TestClient, db_session: Session) -> None:
    from tests.builders import add_company

    company = add_company(db_session, display_name="2SN")
    db_session.refresh(company)

    assert company.organization_id == CIRCOE_ORGANIZATION_ID
    assert uuid.UUID(client.get("/api/auth/session").json()["user"]["organization"]["id"]) == (
        CIRCOE_ORGANIZATION_ID
    )
