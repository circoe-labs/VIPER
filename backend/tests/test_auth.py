"""Sign-in, sessions, cookie flags, CSRF and credential handling (ADR-0004)."""

import json
import logging
from datetime import UTC, datetime, timedelta
from http.cookies import Morsel, SimpleCookie
from typing import Any

import httpx2
import pytest
from argon2 import PasswordHasher
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from sqlalchemy.orm import Session, sessionmaker

from app.api.dependencies import require_session
from app.api.session_cookie import CSRF_HEADER, SESSION_COOKIE
from app.core.actor import ActorType
from app.core.config import Settings
from app.core.security import (
    csrf_token,
    hash_password,
    new_session_token,
    session_token_hash,
    verify_password,
)
from app.main import create_app
from app.models import User, UserSession
from tests.builders import PILOT_EMAIL, PILOT_PASSWORD, audit_events
from tests.support import TEST_BASE_URL

LOGIN = "/api/auth/login"
SESSION = "/api/auth/session"
LOGOUT = "/api/auth/logout"
WRONG_PASSWORD = "pas-le-bon-mot-de-passe"
INVALID_CREDENTIALS = {"detail": "Invalid email or password."}


def login(
    client: TestClient, email: str = PILOT_EMAIL, password: str = PILOT_PASSWORD
) -> httpx2.Response:
    return client.post(LOGIN, json={"email": email, "password": password})


def session_cookie(response: httpx2.Response) -> Morsel[str]:
    return SimpleCookie(response.headers["set-cookie"])[SESSION_COOKIE]


def set_session_times(session: Session, **values: Any) -> None:
    session.execute(update(UserSession).values(**values))


def now() -> datetime:
    return datetime.now(UTC)


# --- sign-in ---------------------------------------------------------------------------------


def test_login_opens_a_session_and_returns_the_user_with_its_csrf_token(
    anonymous_client: TestClient, pilot_user: User, db_session: Session
) -> None:
    response = login(anonymous_client, email="  Pilote.Test@Example.COM ")

    assert response.status_code == 200
    token = anonymous_client.cookies[SESSION_COOKIE]
    assert response.json() == {
        "user": {"id": str(pilot_user.id), "email": PILOT_EMAIL, "display_name": "Pilote Test"},
        "csrf_token": csrf_token(token),
    }
    stored = db_session.execute(select(UserSession.token_hash)).scalar_one()
    assert stored == session_token_hash(token) != token
    assert anonymous_client.get(SESSION).json() == response.json()


def test_session_cookie_is_httponly_strict_secure_and_scoped_to_the_api(
    anonymous_client: TestClient, pilot_user: User
) -> None:
    cookie = session_cookie(login(anonymous_client))

    assert cookie["httponly"] is True
    assert cookie["secure"] is True
    assert cookie["samesite"] == "strict"
    assert cookie["path"] == "/api"
    assert cookie["max-age"] == str(12 * 3600)


def test_secure_flag_can_be_turned_off_for_plain_http(
    test_database_url: str, session_factory: sessionmaker[Session], pilot_user: User
) -> None:
    app = create_app(Settings(database_url=test_database_url, session_cookie_secure=False))
    app.state.session_factory = session_factory
    with TestClient(app) as plain_http_client:
        response = login(plain_http_client)

        assert "secure" not in response.headers["set-cookie"].lower()
        assert plain_http_client.get(SESSION).status_code == 200


def test_wrong_password_and_unknown_email_get_the_same_answer_and_cost(
    anonymous_client: TestClient, pilot_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    verified_hashes: list[str] = []
    real_verify = PasswordHasher.verify

    def spy(self: PasswordHasher, hash: str | bytes, password: str | bytes) -> bool:
        verified_hashes.append(str(hash))
        return real_verify(self, hash, password)

    monkeypatch.setattr(PasswordHasher, "verify", spy)

    wrong_password = login(anonymous_client, password=WRONG_PASSWORD)
    unknown_email = login(anonymous_client, email="inconnu.test@example.com")

    assert wrong_password.status_code == unknown_email.status_code == 401
    assert wrong_password.json() == unknown_email.json() == INVALID_CREDENTIALS
    # One argon2id verification each: an unknown account is checked against a dummy hash.
    assert [value[:10] for value in verified_hashes] == ["$argon2id$"] * 2
    assert SESSION_COOKIE not in anonymous_client.cookies


def test_login_only_accepts_json_so_cross_site_forms_cannot_post_it(
    anonymous_client: TestClient, pilot_user: User
) -> None:
    credentials = {"email": PILOT_EMAIL, "password": PILOT_PASSWORD}
    form = anonymous_client.post(LOGIN, data=credentials)
    text_plain = anonymous_client.post(
        LOGIN, content=json.dumps(credentials), headers={"Content-Type": "text/plain"}
    )

    assert form.status_code == text_plain.status_code == 422
    assert SESSION_COOKIE not in anonymous_client.cookies


def test_login_rotates_the_token_and_ends_the_previous_session(
    anonymous_client: TestClient, app: FastAPI, pilot_user: User
) -> None:
    login(anonymous_client)
    first = anonymous_client.cookies[SESSION_COOKIE]
    login(anonymous_client)
    second = anonymous_client.cookies[SESSION_COOKIE]

    assert first != second
    with TestClient(app, base_url=TEST_BASE_URL, cookies={SESSION_COOKIE: first}) as stale:
        assert stale.get(SESSION).status_code == 401
    assert anonymous_client.get(SESSION).status_code == 200


def test_login_upgrades_a_hash_made_with_older_parameters(
    anonymous_client: TestClient, db_session: Session
) -> None:
    weak = PasswordHasher(time_cost=1, memory_cost=8 * 1024, parallelism=1).hash(PILOT_PASSWORD)
    user = User(email=PILOT_EMAIL, display_name="Pilote Test", password_hash=weak)
    db_session.add(user)
    db_session.flush()

    assert login(anonymous_client).status_code == 200

    db_session.refresh(user)
    assert user.password_hash.startswith("$argon2id$v=19$m=65536,t=3,p=4$")
    assert verify_password(user.password_hash, PILOT_PASSWORD)


# --- throttling ------------------------------------------------------------------------------


def test_repeated_failures_lock_the_account_even_for_the_right_password(
    anonymous_client: TestClient, pilot_user: User
) -> None:
    for _ in range(5):
        assert login(anonymous_client, password=WRONG_PASSWORD).status_code == 401

    locked = login(anonymous_client)

    assert locked.status_code == 429
    assert 0 < int(locked.headers["retry-after"]) <= 15 * 60
    assert SESSION_COOKIE not in anonymous_client.cookies


def test_unknown_emails_are_throttled_exactly_like_existing_ones(
    anonymous_client: TestClient,
) -> None:
    for _ in range(5):
        assert login(anonymous_client, email="inconnu.test@example.com").status_code == 401

    assert login(anonymous_client, email="inconnu.test@example.com").status_code == 429


def test_a_successful_login_clears_the_account_failures(
    anonymous_client: TestClient, pilot_user: User
) -> None:
    for _ in range(4):
        login(anonymous_client, password=WRONG_PASSWORD)
    assert login(anonymous_client).status_code == 200

    for _ in range(4):
        assert login(anonymous_client, password=WRONG_PASSWORD).status_code == 401


# --- expiry and logout -----------------------------------------------------------------------


def test_session_expires_after_the_idle_timeout(client: TestClient, db_session: Session) -> None:
    assert client.get(SESSION).status_code == 200
    set_session_times(db_session, last_seen_at=now() - timedelta(minutes=121))

    response = client.get(SESSION)

    assert response.status_code == 401
    assert session_cookie(response)["max-age"] == "0"


def test_activity_keeps_the_session_alive(client: TestClient, db_session: Session) -> None:
    set_session_times(db_session, last_seen_at=now() - timedelta(minutes=119))

    assert client.get(SESSION).status_code == 200

    last_seen = db_session.execute(select(UserSession.last_seen_at)).scalar_one()
    assert now() - last_seen < timedelta(minutes=1)


def test_last_seen_is_written_at_most_once_a_minute(
    client: TestClient, db_session: Session
) -> None:
    recent = now() - timedelta(seconds=30)
    set_session_times(db_session, last_seen_at=recent)

    assert client.get(SESSION).status_code == 200

    assert db_session.execute(select(UserSession.last_seen_at)).scalar_one() == recent


def test_session_expires_at_the_absolute_limit_despite_activity(
    client: TestClient, db_session: Session
) -> None:
    set_session_times(db_session, expires_at=now() - timedelta(seconds=1), last_seen_at=now())

    assert client.get(SESSION).status_code == 401


def test_timeouts_come_from_settings(
    test_database_url: str, session_factory: sessionmaker[Session], pilot_user: User
) -> None:
    settings = Settings(
        database_url=test_database_url,
        session_idle_timeout_minutes=5,
        session_absolute_timeout_hours=1,
    )
    app = create_app(settings)
    app.state.session_factory = session_factory
    with TestClient(app, base_url=TEST_BASE_URL) as short_lived:
        assert session_cookie(login(short_lived))["max-age"] == "3600"
        with session_factory() as session:
            set_session_times(session, last_seen_at=now() - timedelta(minutes=6))
            session.commit()

        assert short_lived.get(SESSION).status_code == 401


def test_logout_revokes_the_session_server_side(
    anonymous_client: TestClient, app: FastAPI, pilot_user: User, db_session: Session
) -> None:
    csrf = login(anonymous_client).json()["csrf_token"]
    token = anonymous_client.cookies[SESSION_COOKIE]

    response = anonymous_client.post(LOGOUT, headers={CSRF_HEADER: csrf})

    assert response.status_code == 204
    assert session_cookie(response)["max-age"] == "0"
    assert db_session.execute(select(UserSession.revoked_at)).scalar_one() is not None
    with TestClient(app, base_url=TEST_BASE_URL, cookies={SESSION_COOKIE: token}) as replay:
        assert replay.get(SESSION).status_code == 401


def test_an_unknown_cookie_is_rejected_and_expired(anonymous_client: TestClient) -> None:
    anonymous_client.cookies.set(SESSION_COOKIE, new_session_token())

    response = anonymous_client.get(SESSION)

    assert response.status_code == 401
    assert session_cookie(response)["max-age"] == "0"


# --- CSRF ------------------------------------------------------------------------------------


@pytest.mark.parametrize("method", ["POST", "PUT", "PATCH", "DELETE"])
def test_unsafe_methods_require_the_session_csrf_token(
    app: FastAPI, client: TestClient, method: str
) -> None:
    probe = APIRouter(dependencies=[Depends(require_session)])
    probe.add_api_route("/api/csrf-probe", lambda: None, methods=[method], status_code=204)
    app.include_router(probe)
    other_session_token = csrf_token(new_session_token())

    assert client.request(method, "/api/csrf-probe").status_code == 204
    for header in ("", "forged", other_session_token):
        response = client.request(method, "/api/csrf-probe", headers={CSRF_HEADER: header})
        assert response.status_code == 403
    del client.headers[CSRF_HEADER]
    assert client.request(method, "/api/csrf-probe").status_code == 403


def test_safe_methods_do_not_need_the_csrf_token(client: TestClient) -> None:
    del client.headers[CSRF_HEADER]

    assert client.get(SESSION).status_code == 200


def test_logout_without_the_csrf_token_is_refused(client: TestClient, db_session: Session) -> None:
    response = client.post(LOGOUT, headers={CSRF_HEADER: "forged"})

    assert response.status_code == 403
    assert db_session.execute(select(UserSession.revoked_at)).scalar_one() is None


# --- credentials never leak ------------------------------------------------------------------


def test_passwords_are_hashed_with_argon2id_rfc_9106_low_memory() -> None:
    stored = hash_password(PILOT_PASSWORD)

    assert stored.startswith("$argon2id$v=19$m=65536,t=3,p=4$")
    assert verify_password(stored, PILOT_PASSWORD)
    assert not verify_password(stored, WRONG_PASSWORD)
    assert not verify_password(None, PILOT_PASSWORD)
    assert not verify_password("not-an-argon2-hash", PILOT_PASSWORD)


def test_password_and_hash_are_never_serialized_or_logged(
    anonymous_client: TestClient, pilot_user: User, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG, logger="app")
    responses = [
        login(anonymous_client, password=WRONG_PASSWORD),
        login(anonymous_client),
        anonymous_client.get(SESSION),
    ]
    exposed = "".join(response.text + str(response.headers) for response in responses)
    exposed += caplog.text + repr(pilot_user)

    for secret in (PILOT_PASSWORD, WRONG_PASSWORD, pilot_user.password_hash, "argon2"):
        assert secret not in exposed


# --- security trail --------------------------------------------------------------------------


def test_sign_in_and_sign_out_are_audited_without_credentials_or_client_details(
    anonymous_client: TestClient, pilot_user: User, db_session: Session
) -> None:
    assert login(anonymous_client, password=WRONG_PASSWORD).status_code == 401
    assert login(anonymous_client, email="inconnu.test@example.com").status_code == 401
    assert audit_events(db_session) == []

    csrf = login(anonymous_client).json()["csrf_token"]
    token = anonymous_client.cookies[SESSION_COOKIE]
    assert anonymous_client.post(LOGOUT, headers={CSRF_HEADER: csrf}).status_code == 204

    signed_in, signed_out = audit_events(db_session)
    assert [signed_in.action, signed_out.action] == ["auth.login", "auth.logout"]
    for entry in (signed_in, signed_out):
        assert (entry.actor_type, entry.actor_id, entry.actor_display) == (
            ActorType.HUMAN,
            str(pilot_user.id),
            "Pilote Test",
        )
        assert (entry.entity_type, entry.entity_id) == ("user", pilot_user.id)
        assert entry.changes == {}
    assert signed_in.context == {"source": "ui"}
    assert set(signed_out.context) == {"source", "request_id"}
    stored = str([(entry.changes, entry.context) for entry in (signed_in, signed_out)])
    for leaked in (
        token,
        csrf,
        session_token_hash(token),
        PILOT_PASSWORD,
        PILOT_EMAIL,
        "testclient",
    ):
        assert leaked not in stored
