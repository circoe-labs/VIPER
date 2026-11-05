"""Six real dashboard counters and the filtered lists their cards open."""

from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.routes import home as home_route
from app.core.business_time import start_of_day
from app.models import ContactTracking
from app.models.enums import ContactTrackingStatus
from app.services.home import dashboard_summary
from app.services.prospection.segments import SegmentContext
from tests.builders import add_company, add_prospect, add_send, start_sequence


def test_dashboard_requires_authentication(anonymous_client: TestClient) -> None:
    assert anonymous_client.get("/api/home/dashboard").status_code == 401


def test_dashboard_empty_base_is_really_zero(client: TestClient) -> None:
    response = client.get("/api/home/dashboard")
    assert response.status_code == 200
    body = response.json()
    assert {key: value for key, value in body.items() if not key.startswith("week_")} == {
        "prospects": 0,
        "companies": 0,
        "contacted": 0,
        "appointments": 0,
        "new_companies": 0,
        "new_prospects": 0,
    }
    assert date.fromisoformat(body["week_start"]).weekday() == 0
    assert date.fromisoformat(body["week_end"]).weekday() == 6


def test_distinct_entities_and_existing_appointment_rule(
    client: TestClient, db_session: Session
) -> None:
    company = add_company(db_session, "Same synthetic name")
    # Two different internal IDs still count even if their names match.
    add_company(db_session, "Same synthetic name")
    contacted = add_prospect(db_session, company)
    other = add_prospect(db_session, company)
    dated = add_prospect(db_session)
    sequence = start_sequence(db_session, contacted)
    now = start_of_day(date(2026, 10, 20))
    add_send(db_session, sequence, 0, now)
    add_send(db_session, sequence, 1, now + timedelta(days=1))
    db_session.add_all(
        [
            ContactTracking(
                prospect_id=contacted.id,
                status=ContactTrackingStatus.APPOINTMENT_OBTAINED,
                appointment_at=now,
            ),
            ContactTracking(prospect_id=other.id, status=ContactTrackingStatus.NEUTRAL),
            ContactTracking(prospect_id=dated.id, appointment_at=now),
        ]
    )
    db_session.flush()

    body = client.get("/api/home/dashboard").json()
    assert (body["prospects"], body["companies"], body["contacted"], body["appointments"]) == (
        3,
        2,
        1,
        2,
    )
    assert client.get("/api/prospection/prospects").json()["total"] == body["prospects"]
    assert client.get("/api/companies").json()["total"] == body["companies"]
    assert client.get("/api/contact/overview").json()["total"] == body["contacted"]
    appointments = client.get("/api/prospection/prospects?segment=appointments").json()
    assert appointments["total"] == body["appointments"]
    assert {row["id"] for row in appointments["items"]} == {str(contacted.id), str(dated.id)}


def test_week_boundaries_are_paris_midnight_and_creation_not_modification(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The week includes the autumn DST change: it lasts 169 hours in UTC.
    today = date(2026, 10, 25)
    monday, following = date(2026, 10, 19), date(2026, 10, 26)
    start, end = start_of_day(monday), start_of_day(following)
    times = [start - timedelta(microseconds=1), start, end - timedelta(microseconds=1), end]
    company_ids, prospect_ids = [], []
    for index, at in enumerate(times):
        company = add_company(db_session, f"Boundary {index}", created_at=at)
        person = add_prospect(db_session, company, created_at=at)
        # Every record is modified this week, including those created outside it.
        company.updated_at = person.updated_at = start + timedelta(hours=12)
        company_ids.append(str(company.id))
        prospect_ids.append(str(person.id))
    db_session.flush()
    monkeypatch.setattr(home_route, "segment_context", lambda _: SegmentContext(today, None))

    result = dashboard_summary(db_session, today)
    assert (result.prospects, result.companies, result.new_prospects, result.new_companies) == (
        4,
        4,
        2,
        2,
    )
    assert (result.week_start, result.week_end) == (monday, today)
    body = client.get("/api/home/dashboard").json()
    assert (body["new_prospects"], body["new_companies"]) == (2, 2)
    params = {"created_from": body["week_start"], "created_to": body["week_end"]}
    for path, ids in [
        ("/api/companies", company_ids),
        ("/api/prospection/prospects", prospect_ids),
    ]:
        response = client.get(path, params=params)
        assert response.status_code == 200, response.text
        assert response.json()["total"] == 2
        assert {row["id"] for row in response.json()["items"]} == set(ids[1:3])
    counters = client.get("/api/prospection/counters", params=params).json()
    assert counters["counts"]["all"] == 2


@pytest.mark.parametrize("path", ["/api/companies", "/api/prospection/prospects"])
def test_creation_period_rejects_reversed_dates(client: TestClient, path: str) -> None:
    response = client.get(path, params={"created_from": "2026-11-02", "created_to": "2026-11-01"})
    assert response.status_code == 422, response.text
