"""CIRCOE Toolbox OAuth client, token file and MCP mail client (S6) against the local fake
(`tests/fake_toolbox.py`): no network, no real Toolbox (Contact port P6)."""

import logging
import os
import stat
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from app.core.actor import ActorContext, ActorType
from app.services.errors import ToolboxError
from app.services.toolbox.mcp_client import DraftInput, McpMailToolbox, classify_tool_error
from app.services.toolbox.oauth import ToolboxAuth, pkce_challenge, same_url, well_known
from app.services.toolbox.token_store import (
    FileTokenStore,
    MemoryTokenStore,
    StoredToken,
    StoreFile,
)
from tests.fake_toolbox import MCP_URL, ORIGIN, FakeToolbox

REDIRECT = "http://localhost:5173/settings/connections"
PERSON = ActorContext(type=ActorType.HUMAN, id="user-1", display="Pilote Test")
OTHER = ActorContext(type=ActorType.HUMAN, id="user-2", display="Autre")
DRAFT = DraftInput(to=["jean@exemple.example"], subject="Objet", text="Corps")


class Clock:
    def __init__(self) -> None:
        self.at = datetime(2026, 10, 1, 9, 0, tzinfo=UTC)

    def __call__(self) -> datetime:
        return self.at


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def fake(clock: Clock) -> FakeToolbox:
    return FakeToolbox(now=clock)


def make_auth(
    fake: FakeToolbox, clock: Clock, store: MemoryTokenStore | None = None
) -> ToolboxAuth:
    return ToolboxAuth(
        mcp_url=MCP_URL,
        redirect_uri=REDIRECT,
        store=store or MemoryTokenStore(),
        timeout_seconds=5,
        transport=fake.transport,
        now=clock,
    )


def connect(auth: ToolboxAuth, fake: FakeToolbox, actor: ActorContext = PERSON) -> None:
    auth.complete(fake.authorize(auth.start(actor)), actor)


def client(auth: ToolboxAuth, fake: FakeToolbox) -> McpMailToolbox:
    return McpMailToolbox(mcp_url=MCP_URL, tokens=auth, timeout_seconds=5, transport=fake.transport)


class _Code:
    """`with refused("toolbox_x"):` — a ToolboxError with that code."""

    def __init__(self, code: str) -> None:
        self.code = code
        self.error: ToolboxError | None = None

    def __enter__(self) -> _Code:
        return self

    def __exit__(self, kind: object, error: BaseException | None, _: object) -> bool:
        assert isinstance(error, ToolboxError), f"expected {self.code}, got {error!r}"
        assert error.code == self.code, error.code
        self.error = error
        return True


def refused(code: str) -> _Code:
    return _Code(code)


# --- OAuth ------------------------------------------------------------------------------------


def test_the_connection_flow(fake: FakeToolbox, clock: Clock) -> None:
    store = MemoryTokenStore()
    auth = make_auth(fake, clock, store)
    assert auth.status().state == "disconnected"

    url = auth.start(PERSON)

    assert url.startswith(f"{ORIGIN}/authorize?")
    for part in ("code_challenge_method=S256", "scope=mail", "response_type=code"):
        assert part in url
    assert fake.registrations == [
        {
            "client_name": "VIPER",
            "redirect_uris": [REDIRECT],
            "response_types": ["code"],
            "grant_types": ["authorization_code"],
            "token_endpoint_auth_method": "none",
            "scope": "mail",
        }
    ]
    auth.complete(fake.authorize(url), PERSON)

    status = auth.status()
    assert (status.state, status.connected_by, status.scope) == ("connected", "Pilote Test", "mail")
    assert status.expires_at == clock.at + timedelta(days=30)
    assert store.read().token is not None
    # The registered client is reused for the next connection.
    connect(auth, fake)
    assert len(fake.registrations) == 1


def test_the_state_is_single_use_and_bound_to_the_person(fake: FakeToolbox, clock: Clock) -> None:
    auth = make_auth(fake, clock)
    params = fake.authorize(auth.start(PERSON))

    # Someone else's state is refused without being consumed…
    with refused("toolbox_state_invalid"):
        auth.complete(params, OTHER)
    with refused("toolbox_state_invalid"):
        auth.complete({"state": "forged", "code": "x"}, PERSON)
    assert auth.status().state == "disconnected"
    # …so its owner can still finish, once.
    auth.complete(params, PERSON)
    assert auth.status().state == "connected"
    with refused("toolbox_state_invalid"):
        auth.complete(params, PERSON)


def test_a_pending_authorization_expires(fake: FakeToolbox, clock: Clock) -> None:
    auth = make_auth(fake, clock)
    params = fake.authorize(auth.start(PERSON))
    clock.at += timedelta(minutes=31)

    with refused("toolbox_state_invalid"):
        auth.complete(params, PERSON)


@pytest.mark.parametrize(
    ("change", "code"),
    [
        ({"error": "access_denied"}, "toolbox_access_denied"),
        ({"error": "server_error"}, "toolbox_authorization_failed"),
        ({"iss": "https://evil.example.test"}, "toolbox_issuer_mismatch"),
        ({"iss": ""}, "toolbox_issuer_mismatch"),
        ({"code": ""}, "toolbox_authorization_failed"),
        ({"code": "unknown-code"}, "toolbox_token_exchange_failed"),
    ],
)
def test_a_refused_return_says_why(
    fake: FakeToolbox, clock: Clock, change: dict[str, str], code: str
) -> None:
    auth = make_auth(fake, clock)
    params = fake.authorize(auth.start(PERSON)) | change

    with refused(code):
        auth.complete(params, PERSON)
    assert auth.status().state == "disconnected"


def test_discovery_failures(fake: FakeToolbox, clock: Clock) -> None:
    wrong = ToolboxAuth(
        mcp_url=f"{ORIGIN}/other",
        redirect_uri=REDIRECT,
        store=MemoryTokenStore(),
        timeout_seconds=5,
        transport=fake.transport,
        now=clock,
    )
    with refused("toolbox_not_configured"):
        wrong.start(PERSON)
    fake.mode.unreachable = True
    with refused("toolbox_unavailable"):
        make_auth(fake, clock).start(PERSON)


def test_expiry_and_a_revoked_token_ask_to_reconnect(fake: FakeToolbox, clock: Clock) -> None:
    auth = make_auth(fake, clock)
    connect(auth, fake)
    mail = client(auth, fake)
    mail.create_draft(DRAFT)

    fake.revoke_all()
    with refused("toolbox_auth_expired"):
        mail.create_draft(DRAFT)
    assert auth.status().state == "expired"
    assert auth.status().last_error is not None
    with refused("toolbox_not_connected"):
        mail.create_draft(DRAFT)

    connect(auth, fake)
    assert auth.status().state == "connected"
    clock.at += timedelta(days=30)
    assert auth.status().state == "expired"
    with refused("toolbox_not_connected"):
        mail.list_drafts()


def test_a_refresh_token_is_used_when_the_server_offers_one(clock: Clock) -> None:
    fake = FakeToolbox(now=clock, refresh=True, token_ttl=timedelta(hours=1))
    auth = make_auth(fake, clock)
    connect(auth, fake)
    mail = client(auth, fake)
    clock.at += timedelta(hours=2)

    assert auth.status().state == "connected"  # refreshable
    mail.create_draft(DRAFT)

    assert fake.token_requests == ["authorization_code", "refresh_token"]
    fake.revoke_all()
    mail.create_draft(DRAFT)  # 401, refreshed once, replayed
    assert fake.token_requests[-1] == "refresh_token"


def test_forget_drops_the_token_and_keeps_the_client(fake: FakeToolbox, clock: Clock) -> None:
    store = MemoryTokenStore()
    auth = make_auth(fake, clock, store)
    connect(auth, fake)

    assert auth.forget() is True
    assert auth.status().state == "disconnected"
    assert store.read().client is not None
    assert auth.forget() is False


def test_helpers() -> None:
    assert same_url("https://a.test/mcp/", "https://A.test/mcp")
    assert not same_url("https://a.test/mcp", "https://a.test/other")
    assert well_known("https://a.test/tenant/", "x") == "https://a.test/.well-known/x/tenant"
    # RFC 7636 appendix B.
    assert (
        pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    )


# --- the token file ---------------------------------------------------------------------------


def test_the_token_file_is_private_and_atomic(tmp_path: Path) -> None:
    path = tmp_path / "private" / "toolbox-oauth.json"
    store = FileTokenStore(path)
    assert store.read() == StoreFile()

    token = StoredToken(
        access_token="at-secret",
        expires_at=None,
        scope="mail",
        issuer=ORIGIN,
        resource=MCP_URL,
        token_endpoint=f"{ORIGIN}/token",
        client_id="c",
        refresh_supported=False,
        obtained_at=datetime.now(UTC),
    )
    store.write(StoreFile(token=token))

    assert store.read().token == token
    assert "at-secret" not in repr(store.read())
    assert [p.name for p in path.parent.iterdir()] == ["toolbox-oauth.json"]
    if os.name != "nt":  # Windows ignores the mode: the profile's ACL applies (documented)
        assert stat.S_IMODE(path.stat().st_mode) == 0o600
    path.write_text("{not json", encoding="utf-8")
    assert store.read() == StoreFile()


# --- MCP --------------------------------------------------------------------------------------


@pytest.fixture
def mail(fake: FakeToolbox, clock: Clock) -> McpMailToolbox:
    auth = make_auth(fake, clock)
    connect(auth, fake)
    return client(auth, fake)


def test_the_draft_tools(fake: FakeToolbox, mail: McpMailToolbox) -> None:
    draft_id = mail.create_draft(
        DraftInput(to=["jean@exemple.example"], cc=["c@exemple.example"], subject="S", text="T")
    )

    assert fake.drafts[draft_id].cc == ["c@exemple.example"]
    assert [call[0] for call in fake.calls[-3:]] == [
        "initialize",
        "notifications/initialized",
        "tools/call",
    ]
    assert [d.draft_id for d in mail.list_drafts()] == [draft_id]
    assert mail.delete_draft(draft_id) is True
    # Idempotent: an already-gone draft is not an error.
    assert mail.delete_draft(draft_id) is False
    other = mail.create_draft(DRAFT)
    assert mail.send_draft(other).draft_id == other
    assert fake.sent == [other]
    with refused("toolbox_draft_not_found"):
        mail.send_draft(other)


def test_sse_answers(clock: Clock) -> None:
    fake = FakeToolbox(now=clock, sse=True)
    auth = make_auth(fake, clock)
    connect(auth, fake)
    assert client(auth, fake).create_draft(DRAFT) in fake.drafts


def test_tool_errors_are_classified_and_never_kept(
    fake: FakeToolbox, mail: McpMailToolbox, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    fake.allowlist = ["@circoe.example"]

    with refused("toolbox_outbound_blocked") as blocked:
        mail.create_draft(DRAFT)

    assert blocked.error is not None
    assert "jean@" not in str(blocked.error)
    assert "jean@" not in caplog.text


@pytest.mark.parametrize(
    ("text", "code"),
    [
        ("Brouillon introuvable : d-1", "toolbox_draft_not_found"),
        ("L'API Infomaniak Mail a répondu 503", "toolbox_unavailable"),
        ("Aucune connexion Infomaniak pour ce membre", "toolbox_auth_expired"),
        ("Paramètres invalides : to", "toolbox_invalid_input"),
        ("Autre chose", "toolbox_rejected"),
    ],
)
def test_classification(text: str, code: str) -> None:
    assert classify_tool_error(text) == code


def test_transport_failures(fake: FakeToolbox, mail: McpMailToolbox) -> None:
    fake.mode.http_status = 503
    with refused("toolbox_unavailable") as unavailable:
        mail.create_draft(DRAFT)
    assert unavailable.error is not None and unavailable.error.retryable
    fake.mode.http_status = None

    fake.mode.hang_tool = "infomaniak.mail.send_draft"
    draft_id = mail.create_draft(DRAFT)
    with refused("toolbox_timeout") as timeout:
        mail.send_draft(draft_id)
    # A send that may have happened is never replayed blindly.
    assert timeout.error is not None and timeout.error.outcome_unknown
    fake.mode.hang_tool = None

    fake.mode.unreachable = True
    with refused("toolbox_unavailable"):
        mail.list_drafts()


def test_inputs_are_checked_before_any_call(fake: FakeToolbox, mail: McpMailToolbox) -> None:
    calls = len(fake.calls)
    for draft in (
        DraftInput(to=[], subject="S", text="T"),
        DraftInput(to=["not-an-address"], subject="S", text="T"),
        DraftInput(to=["a@exemple.example"], subject="x" * 501, text="T"),
        DraftInput(to=["a@exemple.example"], subject="S", text=" "),
    ):
        with refused("toolbox_invalid_input"):
            mail.create_draft(draft)
    assert len(fake.calls) == calls


def test_no_token_in_the_logs(
    fake: FakeToolbox, clock: Clock, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)
    store = MemoryTokenStore()
    auth = make_auth(fake, clock, store)
    connect(auth, fake)
    client(auth, fake).create_draft(DRAFT)

    token = store.read().token
    assert token is not None
    assert token.access_token not in caplog.text
    assert "code-" not in caplog.text
