"""Explorer reads stay interactive on a large synthetic table (50k rows, well above V1 scale)."""

import time

from fastapi.testclient import TestClient
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.models import Company
from tests.explorer_helpers import API, condition, get_rows, group, params

ROWS = 50_000
# Generous for shared CI runners; locally a page takes a few tens of milliseconds.
BUDGET_SECONDS = 2.0
EXPORT_BUDGET_SECONDS = 10.0


def test_filtered_sorted_deep_page_on_50k_rows(client: TestClient, db_session: Session) -> None:
    db_session.execute(
        text(
            "INSERT INTO companies (display_name, siren, size_label, client_approach)"
            " SELECT 'Société synthétique ' || g, lpad(g::text, 9, '0'),"
            " (ARRAY['10-49', '50-249', NULL])[g % 3 + 1], repeat('Texte fictif ', g % 40)"
            " FROM generate_series(1, :rows) AS g"
        ),
        {"rows": ROWS},
    )
    assert db_session.scalar(select(func.count()).select_from(Company)) == ROWS
    node = group(condition("display_name", "contains", "7"), condition("size_label", "not_null"))

    started = time.perf_counter()
    body = get_rows(
        client,
        "companies",
        node=node,
        q="synthétique",
        sort=["size_label", "-siren"],
        offset=5_000,
        limit=200,
    )
    elapsed = time.perf_counter() - started

    expected = db_session.execute(
        select(func.count())
        .select_from(Company)
        .where(Company.display_name.contains("7"), Company.size_label.is_not(None))
    ).scalar_one()
    assert body["total"] == expected
    assert len(body["rows"]) == 200
    sizes = [row["values"]["size_label"] for row in body["rows"]]
    assert sizes == sorted(sizes)
    assert elapsed < BUDGET_SECONDS, f"page took {elapsed:.2f}s"

    started = time.perf_counter()
    assert client.get(API).status_code == 200
    assert time.perf_counter() - started < BUDGET_SECONDS

    started = time.perf_counter()
    export = client.get(f"{API}/companies/export.csv", params=params(node=node))
    assert export.status_code == 200
    assert export.text.count("\r\n") == expected + 1
    assert time.perf_counter() - started < EXPORT_BUDGET_SECONDS
