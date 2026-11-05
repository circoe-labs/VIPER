"""The Contacts screen uses real sends; chart annotations never schedule individual mail."""

from datetime import UTC, date, datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models import AppSetting, ContactMessage, ContactSequence, ContactTracking
from app.models.enums import ContactTrackingStatus
from app.services import contact_sequences
from tests.builders import OPERATOR, add_cohort, add_company, add_prospect, add_send


def sent_person(session: Session, name: str, count: int = 1) -> tuple[str, str]:
    company = add_company(session, display_name=f"Entreprise {name}")
    prospect = add_prospect(session, company, first_name="Claire", last_name=name)
    cohort = add_cohort(session, "S39", date(2026, 9, 28))
    sequence = ContactSequence(prospect_id=prospect.id, cohort_id=cohort.id)
    session.add(sequence)
    session.flush()
    for rank in range(count):
        add_send(session, sequence, rank, datetime(2026, 9, 28, tzinfo=UTC) + timedelta(days=rank))
    return str(prospect.id), str(company.id)


def test_distribution_counts_latest_send_once_per_person(
    client: TestClient, db_session: Session
) -> None:
    for rank in range(6):
        sent_person(db_session, f"Niveau {rank}", rank + 1)
    add_prospect(db_session, add_company(db_session), last_name="Jamais contacté")

    response = client.get("/api/contact/overview")
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 6
    assert [bar["count"] for bar in body["bars"]] == [1, 1, 1, 1, 2]
    assert all(bar["send_date"] is None for bar in body["bars"])
    assert len(body["companies"]) == 6


def test_overview_and_list_share_search_company_state_and_level_filters(
    client: TestClient, db_session: Session
) -> None:
    first, company = sent_person(db_session, "Alpha", 2)
    second, _ = sent_person(db_session, "Bravo")
    db_session.add(
        ContactTracking(prospect_id=second, status=ContactTrackingStatus.RESPONSE_RECEIVED)
    )
    db_session.flush()
    for filters in (
        {"q": "Alpha"},
        {"company": company},
        {"tracking_status": "response_received"},
        {"level": "r1_sent"},
        {"q": "Alpha", "company": company, "level": "r1_sent"},
    ):
        overview = client.get("/api/contact/overview", params=filters).json()
        listing = client.get(
            "/api/contact/prospects", params={"category": "contacted", **filters}
        ).json()
        assert overview["total"] == listing["total"] == 1
        assert sum(bar["count"] for bar in overview["bars"]) == 1
    assert client.get("/api/contact/overview", params={"q": "Inexistant"}).json()["total"] == 0
    assert client.get("/api/contact/overview", params={"level": "fake"}).status_code == 422
    assert client.get("/api/contact/overview", params={"company": "not-a-uuid"}).status_code == 422
    assert first != second


def test_chart_dates_are_independent_persistent_clearable_and_do_not_change_messages(
    client: TestClient, db_session: Session
) -> None:
    sent_person(db_session, "Dates", 3)
    before = db_session.execute(
        select(ContactMessage.id, ContactMessage.sent_at, ContactMessage.scheduled_at)
    ).all()
    for slot, day in ((0, "2026-10-05"), (1, "2026-10-12"), (4, "2026-11-02")):
        saved = client.put(f"/api/contact/chart-dates/{slot}", json={"send_date": day})
        assert saved.status_code == 200
        assert saved.json() == {"send_date": day}
    dates = [bar["send_date"] for bar in client.get("/api/contact/overview").json()["bars"]]
    assert dates == ["2026-10-05", "2026-10-12", None, None, "2026-11-02"]
    assert (
        client.put("/api/contact/chart-dates/0", json={"send_date": "2026-10-06"}).status_code
        == 200
    )
    assert client.put("/api/contact/chart-dates/1", json={"send_date": None}).status_code == 200
    dates = [bar["send_date"] for bar in client.get("/api/contact/overview").json()["bars"]]
    assert dates == ["2026-10-06", None, None, None, "2026-11-02"]
    assert (
        db_session.execute(
            select(ContactMessage.id, ContactMessage.sent_at, ContactMessage.scheduled_at)
        ).all()
        == before
    )
    assert db_session.scalar(select(func.count()).select_from(AppSetting)) == 3
    assert (
        client.put("/api/contact/chart-dates/5", json={"send_date": "2026-10-05"}).status_code
        == 422
    )
    assert (
        client.put("/api/contact/chart-dates/0", json={"send_date": "not-a-date"}).status_code
        == 422
    )


def test_historical_contact_date_survives_sequence_removal(
    client: TestClient, db_session: Session
) -> None:
    id_, _ = sent_person(db_session, "Historique", 2)
    import uuid

    contact_sequences.change_cohort(db_session, OPERATOR, uuid.UUID(id_), None)
    body = client.get(
        "/api/contact/prospects", params={"category": "contacted", "q": "Historique"}
    ).json()
    assert body["total"] == 1
    assert body["items"][0]["last_contact_at"].startswith("2026-09-29")
    assert (
        client.get("/api/contact/overview", params={"q": "Historique"}).json()["bars"][1]["count"]
        == 1
    )
