"""`GET /api/metrics/weekly`: « cette semaine » boundaries and the truthful weekly counters."""

from datetime import UTC, date, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.routes import metrics as metrics_route
from app.core.actor import ActorType
from app.core.business_time import BusinessWeek, start_of_day
from app.models import ContactTracking, Warehouse
from app.models.contact_tracking import ContactTrackingStatusHistory
from app.models.enums import ContactTrackingStatus, TrackingHistoryStatus
from app.services.prospection.segments import SegmentContext
from app.services.weekly_metrics import weekly_metrics
from tests.builders import add_company, add_prospect, add_send, start_sequence

MONDAY = date(2026, 10, 19)  # the week ending 25 October 2026 holds the autumn DST change
TODAY = date(2026, 10, 22)


def test_week_is_monday_to_next_monday_in_paris_across_dst() -> None:
    week = BusinessWeek.of(date(2026, 10, 25))
    assert (week.monday, week.sunday, week.label) == (MONDAY, date(2026, 10, 25), "2026-W43")
    assert (week.end.astimezone(UTC) - week.start.astimezone(UTC)) == timedelta(hours=169)


def test_requires_authentication(anonymous_client: TestClient) -> None:
    assert anonymous_client.get("/api/metrics/weekly").status_code == 401


def test_empty_base_is_really_zero(client: TestClient) -> None:
    response = client.get("/api/metrics/weekly")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["timezone"] == "Europe/Paris"
    assert body["additions"] == {"prospects": 0, "companies": 0, "warehouses": 0}
    assert set(body["contact_stock"].values()) == {0}
    events = body["contact_events"]
    assert all(value == 0 for key, value in events.items() if key != "status_entries")
    assert set(events["status_entries"].values()) == {0}
    assert body["prospection_sub_status_deltas"] is None


def test_additions_use_creation_dates_and_paris_boundaries(
    client: TestClient, db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    start, end = start_of_day(MONDAY), start_of_day(MONDAY + timedelta(days=7))
    edges = [start - timedelta(microseconds=1), start, end - timedelta(microseconds=1), end]
    for index, at in enumerate(edges):
        company = add_company(db_session, f"Edge {index}", created_at=at)
        add_prospect(db_session, company, created_at=at)
        db_session.add(Warehouse(name=f"Site {index}", created_at=at, contacts=[]))
    db_session.flush()
    result = weekly_metrics(db_session, TODAY)
    added = result.additions
    assert (added.prospects, added.companies, added.warehouses) == (2, 2, 2)
    assert (result.week, result.week_start, result.week_end) == (
        "2026-W43",
        MONDAY,
        date(2026, 10, 25),
    )

    monkeypatch.setattr(metrics_route, "segment_context", lambda _: SegmentContext(TODAY, None))
    body = client.get("/api/metrics/weekly").json()
    assert body["additions"] == {"prospects": 2, "companies": 2, "warehouses": 2}


def test_contact_events_and_stock(db_session: Session) -> None:
    start = start_of_day(MONDAY)
    person = add_prospect(db_session)
    sequence = start_sequence(db_session, person)
    add_send(db_session, sequence, 0, start + timedelta(hours=2))
    answered = add_prospect(db_session)
    tracking = ContactTracking(
        prospect_id=answered.id,
        status=ContactTrackingStatus.RESPONSE_RECEIVED,
        response_received_at=start + timedelta(days=1),
    )
    db_session.add(tracking)
    db_session.flush()
    for actor_type, at in (
        (ActorType.HUMAN, start + timedelta(days=1)),
        (ActorType.IMPORT, start + timedelta(days=2)),  # a restatement: not an event
        (ActorType.HUMAN, start - timedelta(days=1)),  # before the week
    ):
        db_session.add(
            ContactTrackingStatusHistory(
                contact_tracking_id=tracking.id,
                from_status=None,
                to_status=TrackingHistoryStatus.RESPONSE_RECEIVED,
                changed_at=at,
                actor_type=actor_type,
                actor_id=None,
                actor_display="Test",
            )
        )
    db_session.flush()
    result = weekly_metrics(db_session, TODAY)
    events, stock = result.contact_events, result.contact_stock
    assert events.first_contacts == 1
    assert events.responses == 1
    assert events.status_entries["response_received"] == 1
    assert events.status_entries["appointment_obtained"] == 0
    assert stock.contacted == 1
    assert stock.responses == 1


def test_stock_separates_first_contact_follow_up_and_overdue(db_session: Session) -> None:
    from tests.builders import add_cohort

    late = add_cohort(db_session, "S40", starts_on=MONDAY - timedelta(days=14))
    person = add_prospect(db_session)
    start_sequence(db_session, person, late)
    # Sent two weeks ago: its follow-up (rank 1) is due since the Monday after, i.e. overdue.
    contacted = add_prospect(db_session)
    sequence = start_sequence(db_session, contacted, late)
    add_send(db_session, sequence, 0, start_of_day(MONDAY - timedelta(days=13)))
    db_session.flush()
    stock = weekly_metrics(db_session, TODAY).contact_stock
    assert stock.to_contact == 1
    assert (stock.to_send, stock.overdue) == (2, 2)
    split = (stock.first_contact_to_send, stock.follow_up_to_send, stock.follow_up_overdue)
    assert split == (1, 1, 1)
    assert stock.contacted == 1
