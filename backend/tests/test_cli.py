"""`python -m app.cli`: bootstrap or reset a login account without committed secrets; provision the
SQL console's reader role."""

import getpass
import io
import threading
import time
from datetime import timedelta

import pytest
import sqlalchemy as sa
from sqlalchemy import Engine, select
from sqlalchemy.orm import Session, sessionmaker

from app import cli
from app.cli import main
from app.core.actor import ActorType
from app.core.config import Settings
from app.core.security import verify_password
from app.db.session import create_session_factory
from app.models import User, UserSession
from app.services.auth import SessionPolicy, open_session, resolve_session
from app.services.explorer import sql_reader
from app.services.explorer.sql_reader import (
    PROVISIONING_LOCK_KEY,
    ProvisioningReport,
    provisioning_lock,
)
from tests.builders import PILOT_EMAIL, PILOT_PASSWORD, audit_events

NEW_PASSWORD = "nouveau-mot-de-passe-synthetique"
POLICY = SessionPolicy(idle_timeout=timedelta(hours=2), absolute_timeout=timedelta(hours=12))


def run(
    session_factory: sessionmaker[Session],
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    *args: str,
    stdin: str = f"{NEW_PASSWORD}\n",
) -> tuple[int, str]:
    monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    code = main(["create-user", *args, "--password-stdin"], session_factory=session_factory)
    captured = capsys.readouterr()
    return code, captured.out + captured.err


def users(session: Session) -> list[User]:
    session.expire_all()
    return list(session.scalars(select(User)))


def test_create_user_stores_only_an_argon2id_hash(
    session_factory: sessionmaker[Session],
    db_session: Session,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    code, output = run(
        session_factory,
        capsys,
        monkeypatch,
        "--email",
        " Nouvelle.Pilote@Example.com ",
        "--display-name",
        "Nouvelle Pilote",
    )

    assert (code, output) == (0, "Created user nouvelle.pilote@example.com.\n")
    [user] = users(db_session)
    assert (user.email, user.display_name) == ("nouvelle.pilote@example.com", "Nouvelle Pilote")
    assert user.password_hash.startswith("$argon2id$")
    assert verify_password(user.password_hash, NEW_PASSWORD)
    assert NEW_PASSWORD not in user.password_hash + output
    [event] = audit_events(db_session)
    assert (event.action, event.entity_id, event.changes) == ("auth.user_created", user.id, {})
    assert (event.actor_type, event.actor_display, event.context) == (
        ActorType.SYSTEM,
        "Ligne de commande",
        {"source": "cli"},
    )


def test_create_user_on_an_existing_email_resets_the_password_and_signs_out(
    session_factory: sessionmaker[Session],
    db_session: Session,
    pilot_user: User,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    token = open_session(db_session, pilot_user, POLICY).token

    code, output = run(session_factory, capsys, monkeypatch, "--email", PILOT_EMAIL)

    assert (code, output) == (0, f"Password reset for user {PILOT_EMAIL}.\n")
    [user] = users(db_session)
    assert user.display_name == "Pilote Test"
    assert verify_password(user.password_hash, NEW_PASSWORD)
    assert not verify_password(user.password_hash, PILOT_PASSWORD)
    assert resolve_session(db_session, token, POLICY) is None
    assert db_session.execute(select(UserSession.revoked_at)).scalar_one() is not None
    assert [event.action for event in audit_events(db_session)] == [
        "auth.login",
        "auth.password_reset",
    ]


def test_create_user_prompts_twice_and_rejects_a_mismatch(
    session_factory: sessionmaker[Session],
    db_session: Session,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    answers = iter([NEW_PASSWORD, "une-autre-saisie-differente"])
    monkeypatch.setattr(getpass, "getpass", lambda prompt: next(answers))

    code = main(
        ["create-user", "--email", "x.test@example.com", "--display-name", "X"],
        session_factory=session_factory,
    )

    assert code == 1
    assert "do not match" in capsys.readouterr().err
    assert users(db_session) == []


@pytest.mark.parametrize(
    ("args", "stdin", "message"),
    [
        (["--email", "x.test@example.com", "--display-name", "X"], "trop-court\n", "12 to 1024"),
        (["--email", "pas-une-adresse", "--display-name", "X"], f"{NEW_PASSWORD}\n", "not valid"),
        (["--email", "x.test@example.com"], f"{NEW_PASSWORD}\n", "display name is required"),
    ],
)
def test_create_user_refuses_invalid_input(
    session_factory: sessionmaker[Session],
    db_session: Session,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    args: list[str],
    stdin: str,
    message: str,
) -> None:
    code, output = run(session_factory, capsys, monkeypatch, *args, stdin=stdin)

    assert code == 1
    assert message in output
    assert users(db_session) == []


def test_provision_sql_reader_aligns_the_role_and_its_grants(
    session_factory: sessionmaker[Session], capsys: pytest.CaptureFixture[str]
) -> None:
    code = main(["provision-sql-reader"], session_factory=session_factory)

    output = capsys.readouterr().out
    assert code == 0
    assert output.startswith("Created role viper_sql_reader") or output.startswith(
        "Updated role viper_sql_reader"
    )
    assert output.rstrip().endswith("SELECT on 16 exposed tables.")


def databases_holding_the_provisioning_lock(engine: Engine) -> set[str]:
    with engine.connect() as connection:
        return set(
            connection.scalars(
                sa.text(
                    "SELECT d.datname FROM pg_locks l JOIN pg_database d ON d.oid = l.database"
                    " WHERE l.locktype = 'advisory' AND l.granted AND l.objid::bigint = :key"
                ),
                {"key": PROVISIONING_LOCK_KEY},
            )
        )


def test_the_provisioning_lock_is_held_in_the_maintenance_database_or_else_the_target_one(
    engine: Engine, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Advisory locks are per database: only the maintenance database is shared by every checkout.
    with provisioning_lock(engine.url):
        assert "postgres" in databases_holding_the_provisioning_lock(engine)

    monkeypatch.setattr(sql_reader, "MAINTENANCE_DATABASE", "viper_absent_maintenance_probe")
    with provisioning_lock(engine.url):
        assert engine.url.database in databases_holding_the_provisioning_lock(engine)
    assert engine.url.database not in databases_holding_the_provisioning_lock(engine)


def a_lock_request_waits(engine: Engine) -> bool:
    """True once some session of the cluster waits for a lock (within 10 s)."""
    deadline = time.monotonic() + 10
    waiting = sa.text("SELECT EXISTS (SELECT 1 FROM pg_locks WHERE NOT granted)")
    with engine.connect() as connection:
        while time.monotonic() < deadline:
            if connection.scalar(waiting):
                return True
            time.sleep(0.02)
    return False


def test_two_provisioning_runs_at_once_take_turns(
    engine: Engine, test_database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Parallel checkouts provision the one reader role of the cluster: a run started while another
    one is in progress waits for its commit instead of failing with "tuple concurrently updated"."""
    settings = Settings(database_url=test_database_url)
    factory = create_session_factory(engine)
    first_run_wrote = threading.Event()
    second_run_waited: list[bool] = []
    provision = sql_reader.provision_sql_reader

    def provision_then_let_the_other_run_start(
        connection: sa.Connection, role: str, password: str
    ) -> ProvisioningReport:
        report = provision(connection, role, password)
        if not first_run_wrote.is_set():
            first_run_wrote.set()
            second_run_waited.append(a_lock_request_waits(engine))
        return report

    monkeypatch.setattr("app.cli.provision_sql_reader", provision_then_let_the_other_run_start)
    outcomes: list[str | Exception] = []

    def run_command() -> None:
        try:
            outcomes.append(cli.provision_reader(factory, settings))
        except Exception as error:
            outcomes.append(error)

    first = threading.Thread(target=run_command)
    first.start()
    assert first_run_wrote.wait(10)
    second = threading.Thread(target=run_command)
    second.start()
    first.join(30)
    second.join(30)

    assert second_run_waited == [True]
    assert [type(outcome) for outcome in outcomes] == [str, str], outcomes
