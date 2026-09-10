"""Explorer metadata: columns, types, keys, allowed values, references and row counts."""

from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AuditLogEntry
from app.models.enums import ActivityStatus
from tests.builders import add_company, add_prospect, add_role
from tests.explorer_helpers import API


def columns_of(client: TestClient, table: str) -> dict[str, dict[str, Any]]:
    response = client.get(f"{API}/{table}")
    assert response.status_code == 200, response.text
    return {column["name"]: column for column in response.json()["columns"]}


def test_columns_describe_type_nullability_default_and_keys(client: TestClient) -> None:
    columns = columns_of(client, "prospects")

    assert list(columns)[:3] == ["id", "company_id", "civility"]
    assert columns["id"] | {"filter_operators": None} == {
        "name": "id",
        "sql_type": "uuid",
        "kind": "uuid",
        "nullable": False,
        "default": "gen_random_uuid()",
        "primary_key": True,
        "foreign_key": None,
        "allowed_values": None,
        "masked": False,
        "filter_operators": None,
        "sortable": True,
        "searchable": True,
        "updatable": False,
        "insertable": False,
        "read_only_reason": "Clé primaire générée à la création.",
        "required_on_insert": False,
    }
    assert columns["role_id"]["foreign_key"] == {"table": "roles", "column": "id"}
    status = columns["activity_status"]
    assert (status["kind"], status["sql_type"], status["nullable"]) == (
        "enum",
        "varchar(32)",
        False,
    )
    assert status["allowed_values"] == [value.value for value in ActivityStatus]
    assert status["default"] == "'unknown'"
    assert columns["employment_verified_at"]["kind"] == "datetime"
    assert columns["employment_verified_at"]["sql_type"] == "timestamp with time zone"
    assert columns["employment_verified_at"]["nullable"] is True
    assert columns["first_name"]["filter_operators"] == [
        "contains",
        "eq",
        "neq",
        "starts_with",
        "in",
        "is_null",
        "not_null",
    ]


def test_every_value_family_is_mapped(client: TestClient) -> None:
    assert columns_of(client, "import_batches")["sheet_names"]["kind"] == "array"
    assert columns_of(client, "import_batches")["rows_total"]["kind"] == "integer"
    assert columns_of(client, "import_row_metadata")["legacy_metadata"]["kind"] == "json"
    assert columns_of(client, "import_row_metadata")["legacy_metadata"]["searchable"] is True
    assert columns_of(client, "establishments")["is_primary"]["kind"] == "boolean"
    assert columns_of(client, "establishments")["is_primary"]["default"] == "false"
    assert columns_of(client, "companies")["client_approach"]["sql_type"] == "text"


def test_composite_primary_key_and_incoming_references(client: TestClient) -> None:
    link = client.get(f"{API}/company_activity_categories").json()
    companies = client.get(f"{API}/companies").json()

    assert link["primary_key"] == ["company_id", "activity_category_id"]
    assert {(ref["table"], ref["column"]) for ref in companies["referenced_by"]} == {
        ("company_activity_categories", "company_id"),
        ("establishments", "company_id"),
        ("import_row_metadata", "company_id"),
        ("prospects", "company_id"),
    }
    assert {ref["referenced_column"] for ref in companies["referenced_by"]} == {"id"}


def test_row_counts_are_exact(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session)
    add_company(db_session, "Logistique Exemple SAS")
    add_prospect(db_session, company)
    add_role(db_session)

    counts = {table["name"]: table["row_count"] for table in client.get(API).json()}

    assert (counts["companies"], counts["prospects"], counts["roles"]) == (2, 1, 1)
    # Each audited insert above logged an event (plus the pilot's sign-in): counted like any table.
    logged = db_session.scalar(select(func.count()).select_from(AuditLogEntry))
    assert counts["audit_log"] == logged
    assert logged is not None and logged >= 4
    assert client.get(f"{API}/companies").json()["row_count"] == 2
