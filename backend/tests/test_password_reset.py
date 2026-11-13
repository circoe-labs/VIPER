"""« Mot de passe oublié ? »: single-use hashed token, one hour, no enumeration, admin-sent link."""

import re
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.api.session_cookie import CSRF_HEADER, SESSION_COOKIE
from app.core.security import csrf_token, verify_password
from app.db.session import unit_of_work
from app.models.organizations import Organization, OrganizationRole
from app.models.users import User
from app.services import password_reset
from app.services.auth import SessionPolicy, open_session
from tests.builders import PILOT_PASSWORD, add_user, audit_events
from tests.support import TEST_BASE_URL
from tests.test_signups import RecordingToolbox, StubIntegration, mailbox

FORGOT = "/api/auth/forgot-password"
RESET = "/api/auth/reset-password"
LOGIN = "/api/auth/login"
NEW_PASSWORD = "un autre mot de passe long"
MEMBER_EMAIL = "membre@circoe.com"


def token_of(mail: RecordingToolbox) -> str:
    match = re.search(r"/reinitialisation/([\w-]+)", mail.drafts[-1].text)
    assert match is not None
    return match.group(1)


def forgot(client: TestClient, email: str) -> Any:
    return client.post(FORGOT, json={"email": email})


def reload(db_session: Session, email: str) -> User:
    user = db_session.scalar(select(User).where(User.email == email))
    assert user is not None
    db_session.refresh(user)
    return user


def test_a_request_mails_a_link_and_stores_only_its_hash(
    app: FastAPI, anonymous_client: TestClient, db_session: Session, pilot_user: User
) -> None:
    mail = mailbox(app)

    response = forgot(anonymous_client, pilot_user.email.upper())

    assert response.status_code == 202 and response.json() == {"status": "sent"}
    (draft,) = mail.drafts
    assert draft.to == [pilot_user.email]
    assert draft.subject == "VIPER — réinitialisation de votre mot de passe"
    assert "1 heure" in draft.text and "Ignorez ce message" in draft.text
    token = token_of(mail)
    user = reload(db_session, pilot_user.email)
    assert user.password_reset_token_hash not in (None, token)
    assert user.password_reset_token_hash == password_reset._token_hash(token)
    assert user.password_reset_expires_at is not None
    delta = user.password_reset_expires_at - datetime.now(UTC)
    assert timedelta(minutes=59) < delta <= timedelta(hours=1)
    reasons = [e.context.get("reason") for e in audit_events(db_session, entity_type="user")]
    assert "password reset requested by the account" in reasons


def test_the_answer_and_the_mailbox_do_not_reveal_whether_an_account_exists(
    app: FastAPI, anonymous_client: TestClient, db_session: Session, pilot_user: User
) -> None:
    mail = mailbox(app)
    add_user(db_session, "inactif@circoe.com", is_active=False)
    add_user(db_session, "attente@circoe.com", is_active=False, signup_token_hash="a" * 64)

    known = forgot(anonymous_client, pilot_user.email)
    answers = [
        forgot(anonymous_client, email)
        for email in ("inconnu@circoe.com", "inactif@circoe.com", "attente@circoe.com")
    ]

    assert all(a.status_code == known.status_code and a.json() == known.json() for a in answers)
    assert len(mail.drafts) == 1  # only the active account
    assert reload(db_session, "inactif@circoe.com").password_reset_token_hash is None
    assert reload(db_session, "attente@circoe.com").password_reset_token_hash is None


def test_a_new_request_replaces_the_previous_token(
    app: FastAPI, anonymous_client: TestClient, pilot_user: User
) -> None:
    mail = mailbox(app)
    forgot(anonymous_client, pilot_user.email)
    first = token_of(mail)
    forgot(anonymous_client, pilot_user.email)
    second = token_of(mail)

    assert first != second
    refused = anonymous_client.post(RESET, json={"token": first, "password": NEW_PASSWORD})
    assert refused.status_code == 422 and refused.json()["detail"]["code"] == "token"
    assert (
        anonymous_client.post(RESET, json={"token": second, "password": NEW_PASSWORD}).status_code
        == 204
    )


def test_the_link_sets_the_password_once_and_signs_the_account_out(
    app: FastAPI,
    anonymous_client: TestClient,
    client: TestClient,
    db_session: Session,
    pilot_user: User,
) -> None:
    mail = mailbox(app)
    assert client.get("/api/auth/session").status_code == 200
    forgot(anonymous_client, pilot_user.email)
    token = token_of(mail)

    done = anonymous_client.post(RESET, json={"token": token, "password": NEW_PASSWORD})

    assert done.status_code == 204
    user = reload(db_session, pilot_user.email)
    assert verify_password(user.password_hash, NEW_PASSWORD)
    assert user.password_reset_token_hash is None and user.password_reset_expires_at is None
    assert client.get("/api/auth/session").status_code == 401  # existing sessions revoked
    assert (
        anonymous_client.post(
            LOGIN, json={"email": pilot_user.email, "password": NEW_PASSWORD}
        ).status_code
        == 200
    )
    assert (
        anonymous_client.post(
            LOGIN, json={"email": pilot_user.email, "password": PILOT_PASSWORD}
        ).status_code
        == 401
    )
    # Single use.
    again = anonymous_client.post(RESET, json={"token": token, "password": NEW_PASSWORD})
    assert again.status_code == 422 and again.json()["detail"]["code"] == "token"
    assert "auth.password_reset" in [e.action for e in audit_events(db_session)]


def test_an_expired_token_is_refused(
    app: FastAPI, anonymous_client: TestClient, db_session: Session, pilot_user: User
) -> None:
    mail = mailbox(app)
    forgot(anonymous_client, pilot_user.email)
    user = reload(db_session, pilot_user.email)
    user.password_reset_expires_at = datetime.now(UTC) - timedelta(seconds=1)
    db_session.flush()

    response = anonymous_client.post(
        RESET, json={"token": token_of(mail), "password": NEW_PASSWORD}
    )

    assert response.status_code == 422 and response.json()["detail"]["code"] == "token"
    assert verify_password(reload(db_session, pilot_user.email).password_hash, PILOT_PASSWORD)


def test_a_weak_password_is_refused_and_keeps_the_token(
    app: FastAPI, anonymous_client: TestClient, pilot_user: User
) -> None:
    mail = mailbox(app)
    forgot(anonymous_client, pilot_user.email)
    token = token_of(mail)

    weak = anonymous_client.post(RESET, json={"token": token, "password": "court"})

    assert weak.status_code == 422 and weak.json()["detail"]["code"] == "password"
    ok = anonymous_client.post(RESET, json={"token": token, "password": NEW_PASSWORD})
    assert ok.status_code == 204


def test_an_unknown_token_is_refused(anonymous_client: TestClient) -> None:
    response = anonymous_client.post(RESET, json={"token": "nope", "password": NEW_PASSWORD})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "token"


def test_requests_are_throttled(
    app: FastAPI, anonymous_client: TestClient, pilot_user: User
) -> None:
    mailbox(app)
    codes = [forgot(anonymous_client, pilot_user.email).status_code for _ in range(12)]
    assert codes[0] == 202 and codes[-1] == 429
    assert "Retry-After" in forgot(anonymous_client, pilot_user.email).headers


def test_token_guessing_is_throttled(anonymous_client: TestClient) -> None:
    codes = [
        anonymous_client.post(RESET, json={"token": f"x{i}", "password": NEW_PASSWORD}).status_code
        for i in range(30)
    ]
    assert codes[0] == 422 and codes[-1] == 429


def test_a_mail_failure_does_not_undo_the_request(
    app: FastAPI, anonymous_client: TestClient, db_session: Session, pilot_user: User
) -> None:
    class Broken(RecordingToolbox):
        def send_draft(self, draft_id: str) -> Any:
            raise RuntimeError("toolbox down")

    app.state.toolbox = StubIntegration(Broken())

    response = forgot(anonymous_client, pilot_user.email)

    assert response.status_code == 202
    assert reload(db_session, pilot_user.email).password_reset_token_hash is not None


# --- the admin's button -------------------------------------------------------------------------


def signed_in(app: FastAPI, session_factory: sessionmaker[Session], **extra: Any) -> TestClient:
    with unit_of_work(session_factory) as session:
        viewer = add_user(session, "viewer@circoe.com", **extra)
        token = open_session(session, viewer, SessionPolicy.from_settings(app.state.settings)).token
    return TestClient(
        app,
        base_url=TEST_BASE_URL,
        cookies={SESSION_COOKIE: token},
        headers={CSRF_HEADER: csrf_token(token)},
    )


def admin_url(user: User) -> str:
    return f"/api/organizations/{user.organization_id}/members/{user.id}/password-reset"


def test_an_admin_sends_a_link_to_a_member(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    mail = mailbox(app)
    member = add_user(db_session, MEMBER_EMAIL, role=OrganizationRole.MEMBER)

    response = client.post(admin_url(member))

    assert response.status_code == 200
    assert response.json() == {"sent": True, "email": MEMBER_EMAIL}
    assert mail.drafts[0].to == [MEMBER_EMAIL]
    assert reload(db_session, MEMBER_EMAIL).password_reset_token_hash is not None
    reasons = [e.context.get("reason") for e in audit_events(db_session, entity_type="user")]
    assert "password reset link sent by an administrator" in reasons


def test_sent_is_false_when_the_mail_cannot_leave(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    member = add_user(db_session, MEMBER_EMAIL, role=OrganizationRole.MEMBER)
    app.state.toolbox = StubIntegration(None)  # type: ignore[arg-type]  # not connected

    response = client.post(admin_url(member))

    assert response.status_code == 200
    assert response.json() == {"sent": False, "email": MEMBER_EMAIL}
    assert reload(db_session, MEMBER_EMAIL).password_reset_token_hash is not None


def test_sent_is_false_when_the_toolbox_fails(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    class Broken(RecordingToolbox):
        def create_draft(self, draft: Any) -> str:
            raise RuntimeError("toolbox down")

    app.state.toolbox = StubIntegration(Broken())
    member = add_user(db_session, MEMBER_EMAIL, role=OrganizationRole.MEMBER)

    assert client.post(admin_url(member)).json()["sent"] is False


def test_unknown_member_is_404(app: FastAPI, client: TestClient, pilot_user: User) -> None:
    mailbox(app)
    url = (
        f"/api/organizations/{pilot_user.organization_id}"
        "/members/00000000-0000-0000-0000-000000000001/password-reset"
    )
    assert client.post(url).status_code == 404


def _other_org_member(db_session: Session) -> User:
    org = Organization(name="Autre", email_domain="autre.fr")
    db_session.add(org)
    db_session.flush()
    return add_user(db_session, "x@autre.fr", role=OrganizationRole.MEMBER, organization_id=org.id)


@pytest.mark.parametrize(
    ("viewer_role", "target", "allowed"),
    [
        (OrganizationRole.ADMIN, OrganizationRole.MEMBER, True),
        (OrganizationRole.ADMIN, OrganizationRole.MANAGER, True),
        (OrganizationRole.ADMIN, OrganizationRole.ADMIN, True),
        (OrganizationRole.MANAGER, OrganizationRole.MEMBER, True),
        (OrganizationRole.MANAGER, OrganizationRole.MANAGER, False),
        (OrganizationRole.MANAGER, OrganizationRole.ADMIN, False),
        (OrganizationRole.MEMBER, OrganizationRole.MEMBER, False),
        (OrganizationRole.MEMBER, OrganizationRole.ADMIN, False),
    ],
)
def test_permission_matrix_follows_can_edit_member(
    app: FastAPI,
    session_factory: sessionmaker[Session],
    db_session: Session,
    viewer_role: OrganizationRole,
    target: OrganizationRole,
    allowed: bool,
) -> None:
    mailbox(app)
    viewer = signed_in(app, session_factory, role=viewer_role)
    member = add_user(db_session, MEMBER_EMAIL, role=target)

    response = viewer.post(admin_url(member))

    assert response.status_code == (200 if allowed else 403), response.text
    assert (reload(db_session, MEMBER_EMAIL).password_reset_token_hash is not None) is allowed


def test_nobody_resets_themselves_or_the_platform_admin_from_here(
    app: FastAPI, client: TestClient, db_session: Session, pilot_user: User
) -> None:
    mailbox(app)
    assert client.post(admin_url(pilot_user)).status_code == 403
    boss = add_user(db_session, "boss@circoe.com", is_superadmin=True)
    assert client.post(admin_url(boss)).status_code == 403


def test_an_org_admin_cannot_reach_another_organisation(
    app: FastAPI, client: TestClient, db_session: Session
) -> None:
    mailbox(app)
    outsider = _other_org_member(db_session)
    assert client.post(admin_url(outsider)).status_code == 403


def test_the_platform_admin_reaches_every_organisation(
    app: FastAPI, session_factory: sessionmaker[Session], db_session: Session
) -> None:
    mailbox(app)
    root = signed_in(app, session_factory, is_superadmin=True)
    outsider = _other_org_member(db_session)
    assert root.post(admin_url(outsider)).status_code == 200


def test_the_admin_route_needs_a_session(
    app: FastAPI, anonymous_client: TestClient, pilot_user: User
) -> None:
    mailbox(app)
    assert anonymous_client.post(admin_url(pilot_user)).status_code == 401
