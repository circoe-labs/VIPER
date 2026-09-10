"""Prospection counters and pages stay interactive on a synthetic base far above V1 scale."""

import time

from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlalchemy.orm import Session

PROSPECTS = 20_000
# Generous for shared CI runners; locally each call takes a few tens of milliseconds.
BUDGET_SECONDS = 2.0


def test_counters_and_deep_page_on_20k_prospects(client: TestClient, db_session: Session) -> None:
    db_session.execute(
        text(
            "INSERT INTO companies (display_name)"
            " SELECT 'Entreprise synthétique ' || g FROM generate_series(1, 200) AS g"
        )
    )
    db_session.execute(
        text(
            "INSERT INTO prospects (company_id, first_name, last_name, activity_status,"
            " employment_verified_at)"
            " SELECT (SELECT id FROM companies ORDER BY display_name OFFSET g % 200 LIMIT 1),"
            " 'Prénom' || g, 'Nom' || (g % 997),"
            " (ARRAY['active', 'inactive', 'unknown'])[g % 3 + 1],"
            " CASE WHEN g % 2 = 0 THEN now() - (g % 400) * interval '1 day' END"
            " FROM generate_series(1, :rows) AS g"
        ),
        {"rows": PROSPECTS},
    )
    db_session.execute(
        text(
            "INSERT INTO emails"
            " (prospect_id, address, is_primary, verification_status, origin_type)"
            " SELECT id, 'personne' || row_number() OVER () || '@exemple.example', true,"
            " (ARRAY['unverified', 'verified', 'invalid', 'unknown'])[(random() * 3)::int + 1],"
            " 'imported' FROM prospects"
        )
    )
    db_session.execute(
        text(
            "INSERT INTO contact_tracking (prospect_id, status, planned_contact_at)"
            " SELECT id, (ARRAY['to_contact', 'contacted', 'follow_up_1', 'response_received'])"
            "[(random() * 3)::int + 1], now() + ((random() * 60)::int - 30) * interval '1 day'"
            " FROM prospects TABLESAMPLE BERNOULLI (60)"
        )
    )

    started = time.perf_counter()
    counters = client.get("/api/prospection/counters", params={"q": "nom1"})
    counters_elapsed = time.perf_counter() - started
    started = time.perf_counter()
    page = client.get(
        "/api/prospection/prospects",
        params={"segment": "to_contact", "sort": "planned_contact", "offset": 5_000, "limit": 50},
    )
    page_elapsed = time.perf_counter() - started

    assert counters.status_code == page.status_code == 200
    assert counters.json()["counts"]["all"] > 0
    assert len(page.json()["items"]) == 50
    assert counters_elapsed < BUDGET_SECONDS, f"counters took {counters_elapsed:.2f}s"
    assert page_elapsed < BUDGET_SECONDS, f"page took {page_elapsed:.2f}s"
