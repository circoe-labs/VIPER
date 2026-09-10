"""Operator commands. Run from `backend/`:

    python -m app.cli create-user --email pilot@example.com --display-name "Prénom Nom"

`create-user` creates the login account, or — when the email already exists — resets its password
and signs out all its sessions. The password is prompted twice, or read from the first line of
stdin with `--password-stdin` (automation). It is never a command-line argument, so it cannot end
up in shell history or process listings. Target database: `VIPER_DATABASE_URL`.
"""

import argparse
import getpass
import sys

from sqlalchemy.orm import Session, sessionmaker

from app.core.actor import ActorContext, ActorType
from app.core.config import get_settings
from app.db.session import create_db_engine, create_session_factory
from app.services.audit import attributed_unit_of_work
from app.services.auth import create_or_reset_user
from app.services.errors import DomainError

# Whoever runs the command on the server; the OS account is not known to VIPER.
CLI_ACTOR = ActorContext(type=ActorType.SYSTEM, display="Ligne de commande", id="app.cli")


def read_password(from_stdin: bool) -> str:
    if from_stdin:
        return sys.stdin.readline().rstrip("\r\n")
    password = getpass.getpass("Password: ")
    if getpass.getpass("Repeat password: ") != password:
        raise DomainError("The passwords do not match.")
    return password


def create_user(
    session_factory: sessionmaker[Session], args: argparse.Namespace, password: str
) -> str:
    with attributed_unit_of_work(session_factory, CLI_ACTOR) as session:
        user, created = create_or_reset_user(
            session, CLI_ACTOR, args.email, password, args.display_name
        )
        return f"{'Created' if created else 'Password reset for'} user {user.email}."


def main(
    argv: list[str] | None = None, session_factory: sessionmaker[Session] | None = None
) -> int:
    parser = argparse.ArgumentParser(description="VIPER operator commands.")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-user", help="create a login account or reset its password")
    create.add_argument("--email", required=True)
    create.add_argument("--display-name", help="required when creating; kept on reset if omitted")
    create.add_argument(
        "--password-stdin", action="store_true", help="read the password from stdin"
    )
    args = parser.parse_args(argv)

    engine = None
    if session_factory is None:
        engine = create_db_engine(get_settings().database_url)
        session_factory = create_session_factory(engine)
    try:
        print(create_user(session_factory, args, read_password(args.password_stdin)))
    except DomainError as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1
    finally:
        if engine is not None:
            engine.dispose()
    return 0


if __name__ == "__main__":
    sys.exit(main())
