"""Filtered CSV export: format, filters/sort applied, formula neutralization, errors."""

import csv
import io
from datetime import UTC, datetime
from typing import Any

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import Establishment
from app.services.explorer.reads import BOM
from tests.builders import add_company, add_phone, add_prospect
from tests.explorer_helpers import API, condition, params


def export(client: TestClient, table: str, **kwargs: Any) -> list[list[str]]:
    response = client.get(f"{API}/{table}/export.csv", params=params(**kwargs))
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "text/csv; charset=utf-8"
    assert response.text.startswith(BOM)
    return list(csv.reader(io.StringIO(response.text.removeprefix(BOM)), delimiter=";"))


def test_export_is_excel_friendly_and_respects_filter_and_sort(
    client: TestClient, db_session: Session
) -> None:
    for name in ("Alpha Fret", "Beta Fret", "Gamma Logistique"):
        add_company(db_session, name, email_domain=f"{name.split()[0].lower()}.example.com")

    response = client.get(
        f"{API}/companies/export.csv",
        params=params(node=condition("display_name", "contains", "fret"), sort=["-display_name"]),
    )
    rows = list(csv.reader(io.StringIO(response.text.removeprefix(BOM)), delimiter=";"))

    assert response.headers["content-disposition"].startswith('attachment; filename="companies-')
    assert "\r\n" in response.text
    assert rows[0][:3] == ["id", "display_name", "legal_name"]
    names = [row[rows[0].index("display_name")] for row in rows[1:]]
    assert names == ["Beta Fret", "Alpha Fret"]


def test_export_formats_nulls_booleans_timestamps_and_accents(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, "Entrepôts Démo; « SAS »")
    db_session.add(Establishment(company_id=company.id, is_primary=True, city=None))
    verified = datetime(2026, 3, 1, 12, 0, tzinfo=UTC)
    add_prospect(db_session, company, employment_verified_at=verified)

    [header, row] = export(client, "establishments")
    assert row[header.index("is_primary")] == "true"
    assert row[header.index("city")] == ""
    [header, row] = export(client, "prospects")
    assert row[header.index("employment_verified_at")] == "2026-03-01T12:00:00+00:00"
    [header, row] = export(client, "companies")
    assert row[header.index("display_name")] == "Entrepôts Démo; « SAS »"


def test_export_neutralizes_spreadsheet_formulas(client: TestClient, db_session: Session) -> None:
    company = add_company(db_session, '=HYPERLINK("https://example.com")', legal_name="@SUM(1)")
    prospect = add_prospect(db_session, company, first_name="-2+3", last_name="+12")
    add_phone(db_session, prospect, "+33100000001")

    [header, row] = export(client, "companies")
    assert row[header.index("display_name")] == '\'=HYPERLINK("https://example.com")'
    assert row[header.index("legal_name")] == "'@SUM(1)"
    [header, row] = export(client, "prospects")
    assert (row[header.index("first_name")], row[header.index("last_name")]) == ("'-2+3", "+12")
    [header, row] = export(client, "phones")
    assert row[header.index("number")] == "+33100000001"


def test_export_of_an_empty_result_still_has_the_header(client: TestClient) -> None:
    assert export(client, "roles") == [
        ["id", "label", "slug", "active", "created_at", "updated_at"]
    ]


def test_export_errors_are_reported_before_streaming(client: TestClient) -> None:
    assert client.get(f"{API}/alembic_version/export.csv").status_code == 404
    bad_filter = params(node=condition("nope", "is_null"))
    assert client.get(f"{API}/companies/export.csv", params=bad_filter).status_code == 422
