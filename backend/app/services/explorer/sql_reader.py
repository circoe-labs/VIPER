"""The SQL console's database role (ADR-0011): creation, settings, grants from the exposure policy.

The security boundary of the console is this role, not a query parser: it can log in, has no
attribute beyond LOGIN, reads with `default_transaction_read_only` and a statement timeout, and may
`SELECT` only the visible, unmasked columns of the tables the explorer exposes. Everything else —
authentication tables, `alembic_version`, writes of any kind — is refused by PostgreSQL itself.

`provision_sql_reader` is idempotent and run by `python -m app.cli provision-sql-reader` (after
every migration, since grants follow the tables), by the test fixtures and by the E2E setup, each
inside `provisioning_lock`. Creating or altering the role needs CREATEROLE; granting only needs to
own the tables (the application role).
"""

from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from dataclasses import dataclass

import psycopg
import sqlalchemy as sa
from psycopg import sql

from app.services.errors import DomainError
from app.services.explorer.metadata import describe_table, exposed_table_names
from app.services.explorer.policy import DEFAULT_POLICY, ExposurePolicy

# SUPERUSER, REPLICATION and BYPASSRLS default to off and only a superuser may change them: they are
# checked, not set, when the role already exists.
ROLE_ATTRIBUTES = "LOGIN NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 10"
# Session defaults of every connection of the role (the console also sets them per transaction).
ROLE_SETTINGS: Mapping[str, str] = {
    "default_transaction_read_only": "on",
    "statement_timeout": "10s",
    "idle_in_transaction_session_timeout": "15s",
    "lock_timeout": "2s",
    "search_path": "public",
}


# Advisory lock taken by every provisioning run ("VIPR").
PROVISIONING_LOCK_KEY = 0x56495052
# Advisory locks belong to one database, while the role lives in catalogs shared by the cluster: the
# lock is taken in the database every cluster has.
MAINTENANCE_DATABASE = "postgres"


@contextmanager
def provisioning_lock(url: sa.URL) -> Iterator[None]:
    """Serialize provisioning runs across the cluster; wrap the whole provisioning transaction.

    The role, its password and settings are rows of shared catalogs: two runs at once from different
    databases of one cluster (parallel checkouts, pytest beside the E2E setup) fail with "tuple
    concurrently updated", and two runs on one database also collide on the grants. The lock is held
    on its own connection to the maintenance database until the block ends, so the next run starts
    after this one has committed. A role that may not connect there locks in `url`'s database, which
    still serializes the runs of that database.
    """
    engine = sa.create_engine(
        url.set(database=MAINTENANCE_DATABASE), poolclass=sa.NullPool, isolation_level="AUTOCOMMIT"
    )
    try:
        connection = engine.connect()
    except sa.exc.OperationalError:
        engine.dispose()
        engine = sa.create_engine(url, poolclass=sa.NullPool, isolation_level="AUTOCOMMIT")
        connection = engine.connect()
    try:
        connection.execute(sa.text("SELECT pg_advisory_lock(:key)"), {"key": PROVISIONING_LOCK_KEY})
        yield
    finally:
        # Ending the session releases its advisory lock.
        connection.close()
        engine.dispose()


class SqlReaderProvisioningError(DomainError):
    """The reader role is missing and may not be created from here, or has unsafe attributes."""


@dataclass(frozen=True, slots=True)
class ProvisioningReport:
    created: bool
    tables: int


def reader_grants(policy: ExposurePolicy = DEFAULT_POLICY) -> dict[str, tuple[str, ...]]:
    """Table → columns the reader may SELECT: what the explorer shows, masked columns excluded."""
    return {
        name: tuple(
            column.name for column in describe_table(policy, name).columns if not column.masked
        )
        for name in exposed_table_names(policy)
    }


def _execute(connection: sa.Connection, statement: sql.Composable) -> None:
    raw = connection.connection.driver_connection
    assert isinstance(raw, psycopg.Connection)
    connection.exec_driver_sql(statement.as_string(raw))


def admin_statements(role: str) -> list[str]:
    """What an administrator runs when the application role lacks CREATEROLE (password elided)."""
    settings = [
        f"ALTER ROLE {role} SET {name} = '{value}';" for name, value in ROLE_SETTINGS.items()
    ]
    return [
        f"CREATE ROLE {role} {ROLE_ATTRIBUTES} PASSWORD '<VIPER_SQL_READER_PASSWORD>';",
        *settings,
    ]


def provision_sql_reader(
    connection: sa.Connection, role: str, password: str, policy: ExposurePolicy = DEFAULT_POLICY
) -> ProvisioningReport:
    """Create or align the reader role, then reset its grants to exactly `reader_grants(policy)`."""
    exists = connection.scalar(
        sa.text("SELECT 1 FROM pg_roles WHERE rolname = :role"), {"role": role}
    )
    can_manage = connection.scalar(
        sa.text("SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user")
    )
    name = sql.Identifier(role)
    if can_manage:
        verb = "ALTER" if exists else "CREATE"
        _execute(
            connection,
            sql.SQL(f"{verb} ROLE {{}} {ROLE_ATTRIBUTES} PASSWORD {{}}").format(
                name, sql.Literal(password)
            ),
        )
        for setting, value in ROLE_SETTINGS.items():
            _execute(
                connection,
                sql.SQL("ALTER ROLE {} SET {} = {}").format(
                    name, sql.Identifier(setting), sql.Literal(value)
                ),
            )
    elif not exists:
        raise SqlReaderProvisioningError(
            f"The role {role!r} does not exist and the connecting role may not create it. Ask an "
            "administrator to run:\n" + "\n".join(admin_statements(role))
        )
    _check_safe(connection, role)
    _grant(connection, name, policy)
    return ProvisioningReport(created=not exists, tables=len(reader_grants(policy)))


def _check_safe(connection: sa.Connection, role: str) -> None:
    """The role must hold nothing beyond LOGIN: no powerful attribute, no membership of any role."""
    unsafe = connection.scalar(
        sa.text(
            "SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls"
            " OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid)"
            " FROM pg_roles WHERE rolname = :role"
        ),
        {"role": role},
    )
    if unsafe:
        raise SqlReaderProvisioningError(
            f"The role {role!r} has attributes or memberships beyond LOGIN: it cannot be the SQL"
            " console's reader. Remove them (or choose another VIPER_SQL_READER_ROLE)."
        )


def _grant(connection: sa.Connection, role: sql.Identifier, policy: ExposurePolicy) -> None:
    database = sql.Identifier(connection.scalar(sa.text("SELECT current_database()")))
    for statement in (
        "REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {role}",
        "REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {role}",
        "REVOKE CREATE ON SCHEMA public FROM {role}",
        "GRANT USAGE ON SCHEMA public TO {role}",
        "GRANT CONNECT ON DATABASE {database} TO {role}",
    ):
        _execute(connection, sql.SQL(statement).format(role=role, database=database))
    for table, columns in reader_grants(policy).items():
        _execute(
            connection,
            sql.SQL("GRANT SELECT ({}) ON TABLE {} TO {}").format(
                sql.SQL(", ").join(map(sql.Identifier, columns)), sql.Identifier(table), role
            ),
        )
