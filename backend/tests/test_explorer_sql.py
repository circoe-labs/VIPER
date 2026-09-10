"""Read-only SQL console: the reader role, its grants, the endpoint and a security regression suite.

The reader connects on its own, so it sees only committed data: in these tests (one rolled-back
transaction each) the tables are empty. Reading real rows is covered by the E2E suite.
"""

import hashlib
import json
import time
from collections.abc import Iterator
from typing import Any

import pytest
import sqlalchemy as sa
from fastapi.testclient import TestClient
from pydantic import SecretStr
from sqlalchemy import Engine
from sqlalchemy.exc import DBAPIError
from sqlalchemy.orm import Session

from app.api.session_cookie import CSRF_HEADER
from app.core.actor import ActorType
from app.core.config import Settings
from app.models import User
from app.services.explorer.policy import (
    EXPOSED_TABLES,
    ColumnPolicy,
    ColumnVisibility,
    ExposurePolicy,
    TablePolicy,
)
from app.services.explorer.sql_console import (
    MAX_CELL_CHARS,
    SqlConsoleError,
    check_statement,
    create_reader_engine,
    run_query,
)
from app.services.explorer.sql_reader import (
    SqlReaderProvisioningError,
    provision_sql_reader,
    reader_grants,
)
from tests.builders import audit_events

URL = "/api/explorer/sql"
PROBE_SEQUENCE = "sql_console_probe_seq"


@pytest.fixture(scope="module")
def settings(test_database_url: str) -> Settings:
    return Settings(database_url=test_database_url)


@pytest.fixture(scope="module", autouse=True)
def provisioned(engine: Engine, settings: Settings) -> Iterator[None]:
    """The reader role with its grants (a migration round-trip elsewhere may have dropped them),
    plus a committed sequence for the `nextval` probe."""
    with engine.begin() as connection:
        provision(connection, settings)
        connection.exec_driver_sql(f"CREATE SEQUENCE IF NOT EXISTS {PROBE_SEQUENCE}")
    yield
    with engine.begin() as connection:
        connection.exec_driver_sql(f"DROP SEQUENCE IF EXISTS {PROBE_SEQUENCE}")


def provision(
    connection: sa.Connection, settings: Settings, policy: ExposurePolicy | None = None
) -> Any:
    role, password = settings.sql_reader_role, settings.sql_reader_password.get_secret_value()
    if policy is None:
        return provision_sql_reader(connection, role, password)
    return provision_sql_reader(connection, role, password, policy)


@pytest.fixture
def reader(settings: Settings) -> Iterator[Engine]:
    engine = create_reader_engine(settings.sql_reader_url)
    yield engine
    engine.dispose()


def run(client: TestClient, sql: str) -> Any:
    return client.post(URL, json={"sql": sql})


def refusal(client: TestClient, sql: str) -> dict[str, Any]:
    response = run(client, sql)
    assert response.status_code == 422, response.text
    detail: dict[str, Any] = response.json()["detail"]
    return detail


# --- the reader role ---------------------------------------------------------------------------


def test_the_reader_role_can_only_log_in_and_reads_by_default(
    engine: Engine, settings: Settings
) -> None:
    with engine.connect() as connection:
        role = connection.execute(
            sa.text(
                "SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolreplication,"
                " rolbypassrls, rolinherit, rolconfig FROM pg_roles WHERE rolname = :role"
            ),
            {"role": settings.sql_reader_role},
        ).one()

    assert tuple(role)[:7] == (True, False, False, False, False, False, False)
    assert {
        "default_transaction_read_only=on",
        "statement_timeout=10s",
        "idle_in_transaction_session_timeout=15s",
    } <= set(role.rolconfig)


def column_privileges(engine: Engine, role: str) -> set[tuple[str, str, str]]:
    with engine.connect() as connection:
        rows = connection.execute(
            sa.text(
                "SELECT table_name, column_name, privilege_type FROM"
                " information_schema.column_privileges WHERE grantee = :role"
            ),
            {"role": role},
        )
        return {(row.table_name, row.column_name, row.privilege_type) for row in rows}


def table_privileges(engine: Engine, role: str) -> set[tuple[str, str]]:
    with engine.connect() as connection:
        rows = connection.execute(
            sa.text(
                "SELECT table_name, privilege_type FROM information_schema.table_privileges"
                " WHERE grantee = :role"
            ),
            {"role": role},
        )
        return {(row.table_name, row.privilege_type) for row in rows}


def test_the_reader_grants_are_exactly_the_exposure_policy(
    engine: Engine, settings: Settings
) -> None:
    role = settings.sql_reader_role
    expected = {
        (table, column, "SELECT")
        for table, columns in reader_grants().items()
        for column in columns
    }

    assert column_privileges(engine, role) == expected
    assert {table for table, _, _ in expected} == set(EXPOSED_TABLES)
    # No table-level privilege at all, hence nothing on users, sessions or alembic_version.
    assert table_privileges(engine, role) == set()


def test_no_function_of_the_application_schema_runs_with_its_owner_privileges(
    engine: Engine, client: TestClient
) -> None:
    # EXECUTE on public functions comes from PostgreSQL's PUBLIC default: harmless only while
    # none is SECURITY DEFINER (e.g. `label_key` and `unaccent` from migration 0005 are not).
    with engine.connect() as connection:
        definers = connection.scalars(
            sa.text(
                "SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace"
                " WHERE n.nspname = 'public' AND p.prosecdef"
            )
        ).all()

    assert definers == []
    assert run(client, "SELECT label_key('  Évènement  Test ')").json()["rows"] == [
        ["evenement test"]
    ]


def test_provisioning_revokes_any_other_grant_and_is_idempotent(
    engine: Engine, settings: Settings
) -> None:
    role = settings.sql_reader_role
    with engine.begin() as connection:
        connection.exec_driver_sql(f"GRANT SELECT, INSERT ON users TO {role}")
        connection.exec_driver_sql(f"GRANT UPDATE ON roles TO {role}")
        report = provision(connection, settings)

    assert report.created is False
    assert table_privileges(engine, role) == set()
    assert all(privilege == "SELECT" for _, _, privilege in column_privileges(engine, role))


def test_masked_and_hidden_columns_are_not_granted(engine: Engine, settings: Settings) -> None:
    columns = {
        "client_approach": ColumnPolicy(ColumnVisibility.MASKED),
        "siren": ColumnPolicy(ColumnVisibility.HIDDEN),
    }
    masking = ExposurePolicy(tables={**EXPOSED_TABLES, "companies": TablePolicy(columns=columns)})
    try:
        with engine.begin() as connection:
            provision(connection, settings, masking)
        granted = {
            column
            for table, column, _ in column_privileges(engine, settings.sql_reader_role)
            if table == "companies"
        }
    finally:
        with engine.begin() as connection:
            provision(connection, settings)

    assert "display_name" in granted
    assert not {"client_approach", "siren"} & granted


def test_provisioning_without_createrole_says_what_an_administrator_must_run(
    reader: Engine,
) -> None:
    with reader.connect() as connection, pytest.raises(SqlReaderProvisioningError) as error:
        provision_sql_reader(connection, "viper_sql_absent_probe", "irrelevant")

    assert "CREATE ROLE viper_sql_absent_probe LOGIN" in str(error.value)
    assert "<VIPER_SQL_READER_PASSWORD>" in str(error.value)
    assert "irrelevant" not in str(error.value)


def test_a_role_with_memberships_is_refused_as_reader(engine: Engine) -> None:
    probe = "viper_sql_member_probe"
    with engine.begin() as connection:
        connection.exec_driver_sql(f"DROP ROLE IF EXISTS {probe}")
        connection.exec_driver_sql(f"CREATE ROLE {probe} LOGIN")
        connection.exec_driver_sql(f"GRANT pg_read_all_data TO {probe}")
    try:
        with engine.begin() as connection, pytest.raises(SqlReaderProvisioningError):
            provision_sql_reader(connection, probe, "mot-de-passe-de-test")
    finally:
        with engine.begin() as connection:
            connection.exec_driver_sql(f"DROP ROLE {probe}")


# --- the database is the boundary: raw reader connections, no console code in between -----------


@pytest.mark.parametrize(
    "statement",
    [
        "INSERT INTO roles (label, slug) VALUES ('Intrus', 'intrus')",
        "UPDATE roles SET label = 'Intrus'",
        "DELETE FROM roles",
        "TRUNCATE roles",
        "DROP TABLE roles",
        "CREATE TABLE intrus (x int)",
        "CREATE TEMP TABLE intrus (x int)",
        "ALTER TABLE roles ADD COLUMN intrus int",
        "GRANT SELECT ON users TO PUBLIC",
        "SELECT * FROM users",
        "SELECT * FROM user_sessions",
        "SELECT * FROM alembic_version",
        "SET ROLE viper",
        "COPY roles TO PROGRAM 'id'",
        "SELECT pg_read_file('pg_hba.conf')",
        # Leaving the read-only default does not help: the role has no write privilege.
        "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE; INSERT INTO roles (label, slug)"
        " VALUES ('Intrus', 'intrus')",
        f"SELECT nextval('{PROBE_SEQUENCE}')",
    ],
)
def test_the_reader_role_cannot_write_nor_read_hidden_data(reader: Engine, statement: str) -> None:
    with reader.connect() as connection, pytest.raises(DBAPIError) as error:
        connection.exec_driver_sql(statement)

    assert getattr(error.value.orig, "sqlstate", None) in {"42501", "25006"}


# --- the console: early refusals, database refusals, limits -----------------------------------


@pytest.mark.parametrize(
    ("sql", "code"),
    [
        ("", "empty"),
        ("  -- rien\n /* toujours rien */ ;", "empty"),
        ("SELECT 1; DELETE FROM roles", "multiple"),
        ("SELECT 1; SELECT 2", "multiple"),
        ("INSERT INTO roles (label, slug) VALUES ('Intrus', 'intrus')", "not_read"),
        ("UPDATE roles SET label = 'Intrus'", "not_read"),
        ("DELETE FROM roles", "not_read"),
        ("TRUNCATE roles", "not_read"),
        ("DROP TABLE roles", "not_read"),
        ("CREATE TABLE intrus (x int)", "not_read"),
        ("ALTER TABLE roles ADD COLUMN intrus int", "not_read"),
        ("GRANT SELECT ON users TO PUBLIC", "not_read"),
        ("SET ROLE viper", "not_read"),
        ("RESET ROLE", "not_read"),
        ("COPY roles TO PROGRAM 'id'", "not_read"),
        ("DO $$ BEGIN DELETE FROM roles; END $$", "not_read"),
        ("CALL anything()", "not_read"),
        ("x" * 20_001, "too_long"),
    ],
)
def test_the_console_refuses_early_what_is_not_one_read(
    client: TestClient, sql: str, code: str
) -> None:
    assert refusal(client, sql)["code"] == code


@pytest.mark.parametrize(
    ("sql", "codes"),
    [
        ("SELECT * FROM roles FOR UPDATE", {"read_only", "forbidden"}),
        ("WITH d AS (DELETE FROM roles RETURNING *) SELECT * FROM d", {"unsupported"}),
        ("EXPLAIN ANALYZE DELETE FROM roles", {"read_only", "forbidden"}),
        ("SELECT * INTO intrus FROM roles", {"syntax"}),
        ("SELECT * FROM users", {"forbidden"}),
        ("SELECT * FROM user_sessions", {"forbidden"}),
        ("TABLE alembic_version", {"forbidden"}),
        ("SELECT * FROM pg_authid", {"forbidden"}),
        ("SELECT pg_read_file('pg_hba.conf')", {"forbidden"}),
        ("SELECT lo_import('pg_hba.conf')", {"forbidden"}),
        ("SELECT dblink('dbname=viper', 'SELECT 1')", {"unknown_object"}),
        (f"SELECT nextval('{PROBE_SEQUENCE}')", {"forbidden", "read_only"}),
        (
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename <> current_user",
            {"forbidden"},
        ),
    ],
)
def test_the_database_refuses_writes_hidden_tables_and_admin_functions(
    client: TestClient, sql: str, codes: set[str]
) -> None:
    assert refusal(client, sql)["code"] in codes


def test_hidden_tables_get_a_readable_message(client: TestClient) -> None:
    detail = refusal(client, "SELECT email, password_hash FROM users")

    assert detail["message"].startswith("Table non accessible")
    assert detail["detail"] == "permission denied for table users"


def test_changing_session_settings_leaves_nothing_behind(
    client: TestClient, engine: Engine
) -> None:
    assert run(client, "SELECT set_config('default_transaction_read_only', 'off', false)").json()[
        "rows"
    ] == [["off"]]
    assert run(client, "SELECT pg_advisory_lock(424242)").status_code == 200

    # Each query has its own connection, closed afterwards: the lock is gone, reads stay read-only.
    deadline = time.monotonic() + 5
    with engine.connect() as connection:
        while connection.scalar(
            sa.text("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND objid = 424242")
        ):
            assert time.monotonic() < deadline, "advisory lock survived the query"
            time.sleep(0.05)
    assert refusal(client, "SELECT * FROM roles FOR UPDATE")["code"] in {"read_only", "forbidden"}


def test_a_long_query_is_stopped_by_the_statement_timeout(client: TestClient) -> None:
    app_settings: Settings = client.app.state.settings  # type: ignore[attr-defined]
    client.app.state.settings = app_settings.model_copy(update={"sql_statement_timeout_ms": 300})  # type: ignore[attr-defined]

    started = time.monotonic()
    plain = refusal(client, "SELECT pg_sleep(3)")
    # Switching the timeout off from inside the query does not stop the running timer.
    disguised = refusal(client, "SELECT set_config('statement_timeout', '0', false), pg_sleep(3)")

    assert plain["code"] == disguised["code"] == "timeout"
    assert plain["message"] == "Requête interrompue : elle a dépassé 0.3 s."
    assert time.monotonic() - started < 3


def test_a_huge_result_is_cut_after_the_row_limit(client: TestClient) -> None:
    body = run(
        client, "SELECT n, repeat('x', 600) AS long_text FROM generate_series(1, 5000) n"
    ).json()

    assert (body["row_count"], body["truncated"], body["max_rows"]) == (1000, True, 1000)
    assert body["rows"][0][0] == 1
    assert len(body["rows"][0][1]) == MAX_CELL_CHARS
    assert body["truncated_cells"][:2] == [[0, 1], [1, 1]]


def test_a_read_returns_typed_columns_and_json_safe_values(client: TestClient) -> None:
    response = run(
        client,
        "SELECT current_user AS who, count(*) AS companies, 12345678901234567::bigint AS big,"
        " '2026-09-10 09:30:00+00'::timestamptz AS at, NULL AS nothing FROM companies;",
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert [column["name"] for column in body["columns"]] == [
        "who",
        "companies",
        "big",
        "at",
        "nothing",
    ]
    assert [column["type"] for column in body["columns"]][1:4] == ["int8", "int8", "timestamptz"]
    assert body["rows"] == [
        ["viper_sql_reader", 0, "12345678901234567", "2026-09-10T09:30:00+00:00", None]
    ]
    assert (body["row_count"], body["truncated"]) == (1, False)


def test_explain_values_and_with_are_reads(client: TestClient) -> None:
    assert run(client, "EXPLAIN SELECT * FROM companies").status_code == 200
    assert run(client, "VALUES (1, 'a'), (2, 'b')").json()["rows"] == [[1, "a"], [2, "b"]]
    assert run(client, "WITH n AS (SELECT 1 AS x) SELECT x FROM n").json()["rows"] == [[1]]


def test_a_syntax_error_points_at_its_position_in_the_query(client: TestClient) -> None:
    detail = refusal(client, "SELECT * FORM roles")

    assert detail == {
        "code": "syntax",
        "message": "Erreur de syntaxe à la position 10.",
        "detail": 'syntax error at or near "FORM"',
        "position": 10,
    }


# --- audit and protection ----------------------------------------------------------------------


def test_every_query_is_audited_with_its_hash_never_its_text(
    client: TestClient, db_session: Session, pilot_user: User
) -> None:
    query = "SELECT count(*) FROM emails WHERE address = 'jean.test@example.com'"

    run(client, query)
    refusal(client, "SELECT * FROM users")

    ok, refused = audit_events(db_session, action="explorer.sql_executed")
    assert (ok.actor_type, ok.actor_id) == (ActorType.HUMAN, str(pilot_user.id))
    assert ok.context["source"] == "database_explorer"
    assert ok.entity_type == "sql_query"
    facts = {name: change["after"] for name, change in ok.changes.items()}
    assert facts == {
        "query_sha256": hashlib.sha256(query.encode()).hexdigest(),
        "query_length": len(query),
        "outcome": "ok",
        "row_count": 1,
        "truncated": False,
        "duration_ms": facts["duration_ms"],
    }
    assert "jean.test" not in json.dumps([ok.changes, ok.context, refused.changes])
    assert refused.changes["outcome"]["after"] == "forbidden"


def test_the_console_needs_a_session_and_the_csrf_token(
    client: TestClient, anonymous_client: TestClient
) -> None:
    assert anonymous_client.post(URL, json={"sql": "SELECT 1"}).status_code == 401
    del client.headers[CSRF_HEADER]
    assert client.post(URL, json={"sql": "SELECT 1"}).status_code == 403


def test_an_unprovisioned_reader_is_reported_as_unavailable(
    client: TestClient, settings: Settings
) -> None:
    wrong = settings.model_copy(
        update={"sql_reader_password": SecretStr("pas-le-bon-mot-de-passe")}
    )
    client.app.state.sql_engine = create_reader_engine(wrong.sql_reader_url)  # type: ignore[attr-defined]

    response = run(client, "SELECT 1")

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "unavailable"
    assert "provision-sql-reader" in response.json()["detail"]["message"]


# --- early checks only (no database) -------------------------------------------------------------


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT ';' AS semicolon -- ; not a second statement",
        "SELECT $$;$$, $tag$ ; $tag$ /* ; */",
        "  /* comment ; */ (SELECT 1);;  ",
        'SELECT 1 AS "a;b"',
        "SELECT E'it\\'s;' AS escaped",
        "with x as (select 1) select * from x",
    ],
)
def test_semicolons_inside_strings_identifiers_and_comments_are_not_separators(sql: str) -> None:
    assert check_statement(sql).rstrip(";").strip()


def test_run_query_does_not_depend_on_the_early_checks(reader: Engine) -> None:
    with pytest.raises(SqlConsoleError) as error:
        run_query(reader, "SELECT 1; DELETE FROM roles", max_rows=10, timeout_ms=1000)

    assert error.value.code == "syntax"
    assert error.value.detail == "cannot insert multiple commands into a prepared statement"
