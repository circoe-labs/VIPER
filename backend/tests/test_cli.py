"""`python -m app.cli create-user`: bootstrap or reset a login account without committed secrets."""

import getpass
import io
from datetime import timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session, sessionmaker

from app.cli import main
from app.core.security import verify_password
from app.models import User, UserSession
from app.services.auth import SessionPolicy, open_session, resolve_session
from tests.builders import PILOT_EMAIL, PILOT_PASSWORD

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
