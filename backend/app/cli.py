"""Operator commands. Run from `backend/`:

    python -m app.cli create-user --email pilot@example.com --display-name "Prénom Nom"
    python -m app.cli provision-sql-reader

`create-user` creates the login account, or — when the email already exists — resets its password
and signs out all its sessions. The password is prompted twice, or read from the first line of
stdin with `--password-stdin` (automation). It is never a command-line argument, so it cannot end
up in shell history or process listings.

`provision-sql-reader` creates or aligns the SQL console's read-only role (`VIPER_SQL_READER_ROLE`,
password `VIPER_SQL_READER_PASSWORD`) and resets its grants to the explorer's exposed tables. Run it
after every migration. Target database of both: `VIPER_DATABASE_URL`.

`toolbox-cleanup --once` runs one pass of the CIRCOE Toolbox remote-draft cleanup queue (S6) —
the same pass the API's worker runs every `VIPER_TOOLBOX_CLEANUP_INTERVAL_MS` — and prints its
counts. It uses the token file of the API (`VIPER_TOOLBOX_TOKEN_STORE_PATH`): connect from the
Settings page first. Exit code 1 when the Toolbox is disabled, not configured, not connected, or
the pass was stopped by the connection (`blocked`).

`contact-dispatch --once` runs one pass of the scheduled sending (S7) — the pass the API's worker
runs every `VIPER_CONTACT_DISPATCH_INTERVAL_MS` — and prints its counts; same Toolbox requirements
and exit code as `toolbox-cleanup`. `contact-dispatch --hold-scheduled` puts every scheduled,
unclaimed message back to « Validé » (`dispatch_held`, audited): run it after restoring a backup
(and before starting the API), so nothing restored as « Programmé » leaves again unreviewed.
"""

import argparse
import getpass
import sys

import sqlalchemy as sa
from sqlalchemy.orm import Session, sessionmaker

from app.core.actor import ActorContext, ActorType
from app.core.config import Settings, get_settings
from app.db.session import create_db_engine, create_session_factory
from app.services import contact_dispatch
from app.services.audit import attributed_unit_of_work
from app.services.auth import create_or_reset_user
from app.services.contact_dispatch import DispatchConfig, Dispatcher
from app.services.contact_remote_drafts import process_cleanups
from app.services.errors import DomainError
from app.services.explorer.sql_reader import provision_sql_reader, provisioning_lock
from app.services.runtime_settings import RuntimeSettings
from app.services.toolbox.integration import ToolboxIntegration

# Whoever runs the command on the server; the OS account is not known to VIPER.
CLI_ACTOR = ActorContext(type=ActorType.SYSTEM, display="Ligne de commande", id="app.cli")


def read_password(from_stdin: bool) -> str:
    if from_stdin:
        # Windows PowerShell 5.1 pipes a UTF-8 byte-order mark before the text.
        return sys.stdin.readline().removeprefix("\ufeff").rstrip("\r\n")
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


def provision_reader(session_factory: sessionmaker[Session], settings: Settings) -> str:
    with (
        provisioning_lock(sa.make_url(settings.database_url)),
        session_factory.begin() as session,
    ):
        report = provision_sql_reader(
            session.connection(),
            settings.sql_reader_role,
            settings.sql_reader_password.get_secret_value(),
        )
    action = "Created" if report.created else "Updated"
    return f"{action} role {settings.sql_reader_role}: SELECT on {report.tables} exposed tables."


def toolbox_cleanup(session_factory: sessionmaker[Session], integration: ToolboxIntegration) -> str:
    toolbox = integration.required_mail_toolbox()
    report = process_cleanups(session_factory, toolbox)
    summary = (
        f"Toolbox cleanup: processed {report.processed}, deleted {report.deleted}, already absent "
        f"{report.already_absent}, failed {report.failed}, skipped {report.skipped}."
    )
    if report.blocked:
        raise DomainError(f"{summary} Stopped: {report.blocked} (reconnect the Toolbox).")
    return summary


def contact_dispatch_pass(
    session_factory: sessionmaker[Session], integration: ToolboxIntegration, settings: Settings
) -> str:
    toolbox = integration.required_mail_toolbox()
    report = Dispatcher(session_factory, DispatchConfig.from_settings(settings)).run_pass(toolbox)
    return f"Contact dispatch: {report.summary}."


def hold_scheduled(session_factory: sessionmaker[Session]) -> str:
    with attributed_unit_of_work(session_factory, CLI_ACTOR) as session:
        hold = contact_dispatch.hold_scheduled(session, CLI_ACTOR)
    return (
        f"Scheduled messages put back to Validé: {hold.held}; "
        f"left claimed (settle them in the Contact page): {hold.claimed}."
    )


def main(
    argv: list[str] | None = None,
    session_factory: sessionmaker[Session] | None = None,
    toolbox: ToolboxIntegration | None = None,
) -> int:
    parser = argparse.ArgumentParser(description="VIPER operator commands.")
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create-user", help="create a login account or reset its password")
    create.add_argument("--email", required=True)
    create.add_argument("--display-name", help="required when creating; kept on reset if omitted")
    create.add_argument(
        "--password-stdin", action="store_true", help="read the password from stdin"
    )
    commands.add_parser(
        "provision-sql-reader", help="create/align the SQL console's read-only role and its grants"
    )
    cleanup = commands.add_parser(
        "toolbox-cleanup", help="delete the obsolete Infomaniak drafts queued by VIPER (one pass)"
    )
    cleanup.add_argument(
        "--once", action="store_true", required=True, help="one pass, then exit (no loop)"
    )
    dispatch = commands.add_parser(
        "contact-dispatch", help="scheduled sending of Contact messages (one pass, or hold all)"
    )
    mode = dispatch.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="one pass, then exit (no loop)")
    mode.add_argument(
        "--hold-scheduled",
        action="store_true",
        help="put every scheduled, unclaimed message back to Validé (after a restore)",
    )
    args = parser.parse_args(argv)

    # The integration settings saved from Paramètres > Connexions (S8) apply here too.
    settings = RuntimeSettings(get_settings()).effective
    engine = None
    if session_factory is None:
        engine = create_db_engine(settings.database_url)
        session_factory = create_session_factory(engine)
    try:
        if args.command == "provision-sql-reader":
            print(provision_reader(session_factory, settings))
        elif args.command == "contact-dispatch" and args.hold_scheduled:
            print(hold_scheduled(session_factory))
        elif args.command == "contact-dispatch":
            print(
                contact_dispatch_pass(
                    session_factory, toolbox or ToolboxIntegration(settings), settings
                )
            )
        elif args.command == "toolbox-cleanup":
            print(toolbox_cleanup(session_factory, toolbox or ToolboxIntegration(settings)))
        else:
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
