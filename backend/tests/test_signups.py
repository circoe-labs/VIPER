"""« Créer un compte »: a pending account, an e-mail to the platform admin, an approval link."""

import re
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.organizations import OrganizationRole
from app.models.users import User
from app.services.toolbox.mcp_client import DraftInput
from tests.builders import PILOT_PASSWORD, add_user

SIGNUP = "/api/auth/signup"
LOGIN = "/api/auth/login"
PASSWORD = "un mot de passe assez long"


@dataclass
class RecordingToolbox:
    drafts: list[DraftInput] = field(default_factory=list)
    sent: list[str] = field(default_factory=list)

    def create_draft(self, draft: DraftInput) -> str:
        self.drafts.append(draft)
        return f"d{len(self.drafts)}"

    def send_draft(self, draft_id: str) -> Any:
        self.sent.append(draft_id)
        return None


@dataclass
class StubIntegration:
    mail: RecordingToolbox

    def mail_toolbox(self) -> RecordingToolbox:
        return self.mail


def mailbox(app: FastAPI) -> RecordingToolbox:
    mail = RecordingToolbox()
    app.state.toolbox = StubIntegration(mail)
    return mail


def ask(client: TestClient, email: str = "nouveau@circoe.com", **extra: Any) -> Any:
    body = {"email": email, "display_name": "Nouveau Venu", "password": PASSWORD, **extra}
    return client.post(SIGNUP, json=body)


def make_superadmin(db_session: Session, email: str) -> None:
    user = db_session.scalar(select(User).where(User.email == email))
    assert user is not None
    user.is_superadmin = True
    db_session.flush()


def token_of(mail: RecordingToolbox) -> str:
    match = re.search(r"/inscriptions/([\w-]+)", mail.drafts[-1].text)
    assert match is not None
    return match.group(1)


def test_a_request_creates_a_pending_account_and_mails_the_admin(
    app: FastAPI,
    anonymous_client: TestClient,
    client: TestClient,
    db_session: Session,
    pilot_user: User,
) -> None:
    make_superadmin(db_session, pilot_user.email)
    mail = mailbox(app)

    response = ask(anonymous_client)
    assert response.status_code == 202, response.text

    (draft,) = mail.drafts
    assert draft.to == [pilot_user.email]
    assert "Nouveau Venu" in draft.subject
    assert mail.sent == ["d1"]
    user = db_session.scalar(select(User).where(User.email == "nouveau@circoe.com"))
    assert user is not None and user.is_active is False and user.role == OrganizationRole.MEMBER

    # Not before the admin says so.
    refused = anonymous_client.post(
        LOGIN, json={"email": "nouveau@circoe.com", "password": PASSWORD}
    )
    assert refused.status_code == 403
    assert refused.json()["detail"]["code"] == "pending"

    token = token_of(mail)
    shown = client.get(f"/api/auth/signups/{token}").json()
    assert (shown["email"], shown["display_name"]) == ("nouveau@circoe.com", "Nouveau Venu")
    assert client.post(f"/api/auth/signups/{token}/approve").status_code == 200

    signed_in = anonymous_client.post(
        LOGIN, json={"email": "nouveau@circoe.com", "password": PASSWORD}
    )
    assert signed_in.status_code == 200, signed_in.text
    # The link is single-use.
    assert client.get(f"/api/auth/signups/{token}").status_code == 404


def test_a_refused_request_is_deleted(
    app: FastAPI,
    anonymous_client: TestClient,
    client: TestClient,
    db_session: Session,
    pilot_user: User,
) -> None:
    make_superadmin(db_session, pilot_user.email)
    mail = mailbox(app)
    ask(anonymous_client)

    assert client.post(f"/api/auth/signups/{token_of(mail)}/refuse").status_code == 204
    assert db_session.scalar(select(User).where(User.email == "nouveau@circoe.com")) is None


def test_only_an_admin_decides(
    app: FastAPI,
    anonymous_client: TestClient,
    client: TestClient,
    db_session: Session,
    pilot_user: User,
) -> None:
    make_superadmin(db_session, pilot_user.email)
    mail = mailbox(app)
    ask(anonymous_client)
    token = token_of(mail)
    member = add_user(
        db_session, "membre@circoe.com", display_name="Membre", role=OrganizationRole.MEMBER
    )
    db_session.flush()
    login = anonymous_client.post(LOGIN, json={"email": member.email, "password": PILOT_PASSWORD})
    assert login.status_code == 200, login.text
    csrf = login.json()["csrf_token"]
    answer = anonymous_client.post(
        f"/api/auth/signups/{token}/approve", headers={"X-CSRF-Token": csrf}
    )
    assert answer.status_code == 403


def test_an_existing_address_gets_the_same_answer_and_no_mail(
    app: FastAPI, anonymous_client: TestClient, pilot_user: User
) -> None:
    mail = mailbox(app)
    response = ask(anonymous_client, email=pilot_user.email)
    assert response.status_code == 202
    assert mail.drafts == []


def test_other_domains_and_short_passwords_are_refused(
    app: FastAPI, anonymous_client: TestClient
) -> None:
    mailbox(app)
    other = ask(anonymous_client, email="quelqu.un@gmail.com")
    assert other.status_code == 422
    assert other.json()["detail"]["code"] == "domain"
    short = ask(anonymous_client, password="court")
    assert short.status_code == 422
    assert short.json()["detail"]["code"] == "password"


def test_the_request_stays_pending_when_the_mail_cannot_leave(
    app: FastAPI, anonymous_client: TestClient, db_session: Session
) -> None:
    app.state.toolbox = StubIntegration(None)  # type: ignore[arg-type]
    assert ask(anonymous_client).status_code == 202
    user = db_session.scalar(select(User).where(User.email == "nouveau@circoe.com"))
    assert user is not None and user.signup_requested_at is not None


def test_signing_in_with_an_address_outside_the_open_domains_says_not_allowed(
    anonymous_client: TestClient,
) -> None:
    response = anonymous_client.post(LOGIN, json={"email": "quelqu.un@gmail.com", "password": "x"})
    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "domain"
    assert "circoe" not in response.text.lower()
