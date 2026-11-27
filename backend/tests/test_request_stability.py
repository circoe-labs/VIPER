"""The application must not freeze: no row lock nor pool connection held across a slow call, bounded
database waits, blocking work off the event loop, and evidence in the log."""

import asyncio
import json
import logging
from collections.abc import Iterator
from typing import Any

import httpx2
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import Engine, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.exc import TimeoutError as PoolTimeoutError

from app.api import request_watch
from app.api.session_cookie import CSRF_HEADER, SESSION_COOKIE
from app.core.config import Settings
from app.core.security import csrf_token
from app.db.session import create_db_engine, create_session_factory
from app.main import create_app
from app.services import audit, warehouse_import, warehouses
from app.services.auth import SessionPolicy, open_session
from app.services.errors import InvalidFieldError
from tests.builders import FIXTURE_ACTOR, add_company, add_prospect, add_user
from tests.support import TEST_BASE_URL, reset_database

ANSWER = {"score": 70, "rationale": "Adéquation correcte.", "criteria": []}


@pytest.fixture
def committed_app(engine: Engine, test_database_url: str, tmp_path: Any) -> Iterator[Any]:
    """The app on real transactions (locks and pool included), with a signed-in user and a prospect
    committed for real and removed afterwards."""
    app = create_app(
        Settings(
            database_url=test_database_url,
            openai_api_key="sk-fake",
            openai_model="fake-1",
            openai_base_url="http://127.0.0.1:9/v1",
            toolbox_mail_enabled=False,
            runtime_settings_path=tmp_path / "runtime-settings.json",
            toolbox_token_store_path=tmp_path / "toolbox-oauth.json",
        )
    )
    app.state.mission_scheduler = None
    with audit.attributed_unit_of_work(create_session_factory(engine), FIXTURE_ACTOR) as session:
        user = add_user(session)
        company = add_company(session)
        prospect = add_prospect(session, company)
        token = open_session(session, user, SessionPolicy.from_settings(app.state.settings)).token
        ids = {"u": user.id, "c": company.id, "p": prospect.id}
    try:
        yield app, token, ids
    finally:
        # Real commits (the app's startup writes too): back to an empty schema for the next tests.
        app.state.session_factory.kw["bind"].dispose()
        reset_database(engine, test_database_url)


def test_a_slow_ai_call_holds_no_lock_and_no_connection(committed_app: Any, engine: Engine) -> None:
    app, token, ids = committed_app
    with engine.begin() as connection:
        # The next request must write the last-seen stamp.
        connection.execute(
            text(
                "UPDATE user_sessions SET last_seen_at = now() - interval '5 minutes' "
                "WHERE user_id = :u"
            ),
            ids,
        )
    seen: dict[str, Any] = {}

    def during_the_call(request: httpx2.Request) -> httpx2.Response:
        seen["checked_out"] = app.state.session_factory.kw["bind"].pool.checkedout()
        with engine.begin() as other:
            # Raises at once if the request still holds the session row.
            seen["stamp_age"] = other.execute(
                text(
                    "SELECT extract(epoch FROM now() - last_seen_at) FROM user_sessions "
                    "WHERE user_id = :u FOR UPDATE NOWAIT"
                ),
                ids,
            ).scalar_one()
        output = [
            {"type": "message", "content": [{"type": "output_text", "text": json.dumps(ANSWER)}]}
        ]
        return httpx2.Response(200, json={"status": "completed", "model": "m", "output": output})

    app.state.openai_transport = httpx2.MockTransport(during_the_call)
    with TestClient(
        app,
        base_url=TEST_BASE_URL,
        cookies={SESSION_COOKIE: token},
        headers={CSRF_HEADER: csrf_token(token)},
    ) as client:
        response = client.post(f"/api/prospects/{ids['p']}/score/evaluate")

    assert response.status_code == 200, response.text
    assert response.json()["total"] == 70
    assert seen["checked_out"] == 0
    assert seen["stamp_age"] < 60


def test_database_waits_are_bounded(test_database_url: str) -> None:
    engine = create_db_engine(test_database_url)
    try:
        with engine.connect() as connection:
            assert connection.execute(text("SHOW lock_timeout")).scalar_one() == "15s"
            idle = "SHOW idle_in_transaction_session_timeout"
            assert connection.execute(text(idle)).scalar_one() == "10min"
    finally:
        engine.dispose()


class _LockNotAvailable(Exception):
    sqlstate = request_watch.LOCK_NOT_AVAILABLE


@pytest.mark.parametrize(
    ("error", "cause"),
    [
        (PoolTimeoutError("QueuePool limit reached"), "pool_exhausted"),
        (OperationalError("SELECT 1", None, _LockNotAvailable()), "lock_timeout"),
    ],
)
def test_a_busy_database_answers_503_and_says_so_in_the_log(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    error: Exception,
    cause: str,
) -> None:
    def busy(*args: Any) -> None:
        raise error

    monkeypatch.setattr(warehouses, "count_warehouses", busy)
    monkeypatch.setattr(request_watch, "pool_state", lambda app: "pool")

    response = client.get("/api/warehouses/counts")

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "database_busy"
    assert f"database.busy cause={cause} method=GET route=" in caplog.text


def test_a_slow_request_is_logged_by_route_never_by_its_query(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(request_watch, "SLOW_REQUEST_SECONDS", 0.0)
    monkeypatch.setattr(request_watch, "pool_state", lambda app: "pool")

    with caplog.at_level(logging.WARNING, logger=request_watch.__name__):
        client.get("/api/search?q=confidentiel")

    lines = [
        record.getMessage() for record in caplog.records if record.name == request_watch.__name__
    ]
    assert any(line.startswith("request.slow method=GET route=") for line in lines)
    assert any("search" in line and "status=200" in line for line in lines)
    assert "confidentiel" not in " ".join(lines)


def test_the_warehouse_import_does_not_block_the_event_loop(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    on_loop: list[bool] = []

    def spy(*args: Any) -> warehouse_import.ImportPreview:
        try:
            asyncio.get_running_loop()
            on_loop.append(True)
        except RuntimeError:
            on_loop.append(False)
        raise InvalidFieldError("file", "stop")

    monkeypatch.setattr(warehouse_import, "preview", spy)
    monkeypatch.setattr(warehouse_import, "import_workbook", spy)

    for path in ("/api/warehouses/import-preview", "/api/warehouses/import"):
        client.post(path, files={"file": ("a.xlsx", b"x")})

    assert on_loop == [False, False]
