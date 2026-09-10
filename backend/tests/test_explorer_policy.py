"""Exposure policy: default deny for tables, hidden and masked columns."""

import csv
import io
from collections.abc import Callable
from urllib.parse import quote

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db.base import Base
from app.models import User
from app.services.errors import NotFoundError
from app.services.explorer.metadata import describe_table
from app.services.explorer.policy import (
    DEFAULT_POLICY,
    EXPOSED_TABLES,
    UNEXPOSED_TABLES,
    ColumnPolicy,
    ColumnVisibility,
    ExposurePolicy,
    TablePolicy,
)
from app.services.explorer.reads import BOM
from tests.builders import add_company, add_prospect
from tests.explorer_helpers import API, condition, get_rows, params, rows_status, use_policy

SECRET_APPROACH = "Approche confidentielle synthétique"
HIDDEN_SIREN = "000000042"
COMPANY_COLUMNS = {
    "siren": ColumnPolicy(ColumnVisibility.HIDDEN),
    "client_approach": ColumnPolicy(ColumnVisibility.MASKED),
}
MASKING_POLICY = ExposurePolicy(
    tables={**EXPOSED_TABLES, "companies": TablePolicy(columns=COMPANY_COLUMNS)}
)


@pytest.fixture
def policy(client: TestClient) -> Callable[[ExposurePolicy], None]:
    return use_policy(client)


def test_every_orm_table_is_explicitly_exposed_or_withheld() -> None:
    # A new table (e.g. authentication users/sessions) must be classified consciously.
    assert set(EXPOSED_TABLES) | set(UNEXPOSED_TABLES) == set(Base.metadata.tables)
    assert not set(EXPOSED_TABLES) & set(UNEXPOSED_TABLES)


def test_every_exposed_table_can_be_described() -> None:
    for name in EXPOSED_TABLES:
        assert describe_table(DEFAULT_POLICY, name).columns


AUTH_TABLES = {"users", "user_sessions"}


def test_authentication_tables_are_withheld_everywhere(
    client: TestClient, pilot_user: User
) -> None:
    assert set(UNEXPOSED_TABLES) >= AUTH_TABLES
    names = {table["name"] for table in client.get(API).json()}
    assert not names & AUTH_TABLES
    key = quote(f'{{"id": "{pilot_user.id}"}}')
    for table in AUTH_TABLES:
        for path in ("", "/rows", "/export.csv", f"/record?key={key}"):
            assert client.get(f"{API}/{table}{path}").status_code == 404, (table, path)
    # Never disclosed through metadata either: no FK target, no incoming reference.
    for name in names:
        detail = client.get(f"{API}/{name}").json()
        targets = {
            column["foreign_key"]["table"] for column in detail["columns"] if column["foreign_key"]
        }
        referencing = {reference["table"] for reference in detail["referenced_by"]}
        assert not (targets | referencing) & AUTH_TABLES, name


def test_a_foreign_key_to_a_withheld_table_is_not_disclosed() -> None:
    # Even a (hypothetical) policy exposing sessions would not reveal that they point at `users`.
    policy = ExposurePolicy(tables={"user_sessions": TablePolicy()})

    user_id = describe_table(policy, "user_sessions").column("user_id")

    assert user_id is not None
    assert user_id.foreign_key is None


def test_the_explorer_requires_a_session(anonymous_client: TestClient) -> None:
    for path in (
        "",
        "/companies",
        "/companies/rows",
        "/companies/export.csv",
        "/companies/record?key=%7B%7D",
    ):
        assert anonymous_client.get(f"{API}{path}").status_code == 401, path


def test_listing_shows_exactly_the_exposed_tables(client: TestClient) -> None:
    names = [table["name"] for table in client.get(API).json()]

    assert names == sorted(EXPOSED_TABLES)
    assert "alembic_version" not in names


@pytest.mark.parametrize(
    "name",
    [
        "alembic_version",
        "users",
        "sessions",
        "pg_user",
        "pg_catalog.pg_authid",
        "information_schema.tables",
        "public.companies",
        "Companies",
        "companies;DROP TABLE companies",
        "companies' OR '1'='1",
    ],
)
def test_unexposed_or_unknown_tables_are_not_found(client: TestClient, name: str) -> None:
    base = f"{API}/{quote(name, safe='')}"
    for path in ("", "/rows", "/export.csv", "/record?key=%7B%7D"):
        assert client.get(base + path).status_code == 404, path


def test_a_database_table_outside_the_orm_is_unreachable(
    client: TestClient, db_session: Session
) -> None:
    db_session.execute(text("CREATE TABLE secret_tokens (id integer PRIMARY KEY, token text)"))

    assert "secret_tokens" not in [table["name"] for table in client.get(API).json()]
    assert client.get(f"{API}/secret_tokens/rows").status_code == 404


def test_removing_a_table_from_the_policy_hides_it_and_references_to_it(
    client: TestClient, policy: Callable[[ExposurePolicy], None]
) -> None:
    policy(ExposurePolicy(tables={k: v for k, v in EXPOSED_TABLES.items() if k != "companies"}))

    assert "companies" not in [table["name"] for table in client.get(API).json()]
    assert client.get(f"{API}/companies").status_code == 404
    company_id = next(
        column
        for column in client.get(f"{API}/prospects").json()["columns"]
        if column["name"] == "company_id"
    )
    assert company_id["foreign_key"] is None


def test_primary_key_columns_cannot_be_hidden() -> None:
    policy = ExposurePolicy(
        tables={"roles": TablePolicy(columns={"id": ColumnPolicy(ColumnVisibility.HIDDEN)})}
    )

    with pytest.raises(ValueError, match="Primary key"):
        describe_table(policy, "roles")
    with pytest.raises(NotFoundError):
        describe_table(policy, "companies")


@pytest.fixture
def secret_company(db_session: Session) -> None:
    add_company(
        db_session, "Transports Masque SARL", siren=HIDDEN_SIREN, client_approach=SECRET_APPROACH
    )


@pytest.mark.usefixtures("secret_company")
def test_hidden_columns_vanish_and_masked_columns_carry_no_value(
    client: TestClient, policy: Callable[[ExposurePolicy], None]
) -> None:
    policy(MASKING_POLICY)

    columns = {
        column["name"]: column for column in client.get(f"{API}/companies").json()["columns"]
    }
    assert "siren" not in columns
    masked = columns["client_approach"]
    assert masked["masked"] is True
    assert (masked["filter_operators"], masked["sortable"], masked["searchable"]) == (
        [],
        False,
        False,
    )

    row = get_rows(client, "companies")["rows"][0]
    assert "siren" not in row["values"]
    assert row["values"]["client_approach"] is None
    key = f'{{"id": "{row["values"]["id"]}"}}'
    record = client.get(f"{API}/companies/record", params={"key": key}).json()["values"]
    assert "siren" not in record
    assert record["client_approach"] is None


@pytest.mark.usefixtures("secret_company")
def test_hidden_and_masked_columns_cannot_be_searched_filtered_or_sorted(
    client: TestClient, policy: Callable[[ExposurePolicy], None]
) -> None:
    policy(MASKING_POLICY)

    assert get_rows(client, "companies", q="confidentielle")["total"] == 0
    assert get_rows(client, "companies", q=HIDDEN_SIREN)["total"] == 0
    for column in ("siren", "client_approach"):
        assert rows_status(client, "companies", sort=[column]) == 422
        assert rows_status(client, "companies", node=condition(column, "is_null")) == 422


@pytest.mark.usefixtures("secret_company")
def test_export_drops_hidden_columns_and_blanks_masked_ones(
    client: TestClient, policy: Callable[[ExposurePolicy], None]
) -> None:
    policy(MASKING_POLICY)

    response = client.get(f"{API}/companies/export.csv", params=params())
    header, row = list(csv.reader(io.StringIO(response.text.removeprefix(BOM)), delimiter=";"))

    assert "siren" not in header
    assert row[header.index("client_approach")] == ""
    assert HIDDEN_SIREN not in response.text
    assert SECRET_APPROACH not in response.text


def test_foreign_keys_to_exposed_tables_are_described(
    client: TestClient, db_session: Session
) -> None:
    add_prospect(db_session)
    columns = {
        column["name"]: column for column in client.get(f"{API}/prospects").json()["columns"]
    }

    assert columns["company_id"]["foreign_key"] == {"table": "companies", "column": "id"}
