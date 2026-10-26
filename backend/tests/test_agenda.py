"""Agenda (Calendly sync, follow-up, reminders) through the API, with a fake Calendly."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx2
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.business_time import business_day
from app.models import Appointment, ContactMessage, InternalReferent
from app.models.enums import ContactMessageStatus, SendSource
from tests.builders import add_email, add_prospect
from tests.test_runtime_settings import URL as INTEGRATIONS_URL
from tests.test_runtime_settings import ok, put

API = "https://api.calendly.com"
TOKEN = "cal-token-0123456789"


def iso(moment: datetime) -> str:
    return moment.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.000000Z")


class FakeCalendly:
    """Just enough of Calendly's v2 API: the token owner, a list of events, their invitees."""

    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []
        self.invitees: dict[str, list[dict[str, Any]]] = {}
        self.status = 200
        self.seen_tokens: list[str] = []

    def add(
        self,
        key: str,
        start: datetime,
        *,
        email: str,
        name: str = "Jean Test",
        host_email: str = "hote@circoe.test",
        canceled: bool = False,
        rescheduled: bool = False,
        old_invitee: bool = False,
        answers: list[dict[str, str]] | None = None,
    ) -> None:
        uri = f"{API}/scheduled_events/{key}"
        self.events.append(
            {
                "uri": uri,
                "name": "Échange IA 30 min",
                "status": "canceled" if canceled else "active",
                "start_time": iso(start),
                "end_time": iso(start + timedelta(minutes=30)),
                "location": {"type": "google_conference", "join_url": "https://meet.test/abc"},
                "event_memberships": [
                    {
                        "user": f"{API}/users/U1",
                        "user_name": "Hôte Circoe",
                        "user_email": host_email,
                    }
                ],
            }
        )
        self.invitees[uri] = [
            {
                "uri": f"{uri}/invitees/I1",
                "name": name,
                "email": email,
                "status": "canceled" if canceled else "active",
                "rescheduled": rescheduled,
                "old_invitee": f"{uri}/invitees/OLD" if old_invitee else None,
                "questions_and_answers": answers or [],
            }
        ]

    def handler(self, request: httpx2.Request) -> httpx2.Response:
        self.seen_tokens.append(request.headers["authorization"])
        if self.status != 200:
            return httpx2.Response(self.status, json={"title": "Nope"})
        path = request.url.path
        if path == "/users/me":
            return httpx2.Response(
                200,
                json={
                    "resource": {
                        "uri": f"{API}/users/U1",
                        "name": "Hôte Circoe",
                        "email": "hote@circoe.test",
                        "current_organization": f"{API}/organizations/O1",
                    }
                },
            )
        if path == "/scheduled_events":
            return httpx2.Response(200, json={"collection": self.events, "pagination": {}})
        if path.endswith("/invitees"):
            event_uri = f"{API}{path.removesuffix('/invitees')}"
            return httpx2.Response(200, json={"collection": self.invitees[event_uri]})
        return httpx2.Response(404, json={})


@pytest.fixture
def calendly(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> FakeCalendly:
    fake = FakeCalendly()
    app.state.calendly_transport = httpx2.MockTransport(fake.handler)
    # No background thread in these tests: the sync is driven through the API.
    monkeypatch.setattr(app.state.integrations, "_sync_calendly", lambda: None)
    return fake


@pytest.fixture
def configured(client: TestClient, calendly: FakeCalendly) -> FakeCalendly:
    ok(put(client, calendly_api_token=TOKEN))
    return calendly


def tomorrow_at(hour: int) -> datetime:
    day = business_day(datetime.now(UTC)) + timedelta(days=1)
    return datetime(day.year, day.month, day.day, hour, 0, tzinfo=UTC)


def window(client: TestClient) -> list[dict[str, Any]]:
    today = business_day(datetime.now(UTC))
    reply = client.get(
        "/api/agenda/appointments",
        params={"start": today.isoformat(), "end": (today + timedelta(days=7)).isoformat()},
    )
    return ok(reply)["items"]


def test_sync_without_a_token_says_so(client: TestClient, calendly: FakeCalendly) -> None:
    assert ok(client.post("/api/agenda/sync")) == {
        "ok": False,
        "code": "calendly_not_configured",
        "created": 0,
        "updated": 0,
        "cancelled": 0,
    }


def test_the_token_is_write_only_and_can_be_tested(
    client: TestClient, calendly: FakeCalendly
) -> None:
    assert (
        ok(client.post(f"{INTEGRATIONS_URL}/calendly/check"))["code"] == "calendly_not_configured"
    )
    saved = ok(put(client, calendly_api_token=TOKEN))
    assert TOKEN not in str(saved)
    assert saved["calendly_api_token"]["set"] is True
    assert saved["calendly_api_token"]["last4"] == TOKEN[-4:]

    checked = ok(client.post(f"{INTEGRATIONS_URL}/calendly/check"))
    assert checked["ok"] is True
    assert checked["account"] == "Hôte Circoe · hote@circoe.test"
    assert calendly.seen_tokens[-1] == f"Bearer {TOKEN}"

    calendly.status = 401
    assert ok(client.post(f"{INTEGRATIONS_URL}/calendly/check"))["code"] == "calendly_unauthorized"
    assert ok(client.post("/api/agenda/sync"))["code"] == "calendly_unauthorized"


def test_sync_brings_the_meeting_with_its_prospect_company_and_referent(
    client: TestClient, configured: FakeCalendly, db_session: Session
) -> None:
    from tests.builders import add_company

    company = add_company(db_session, display_name="Carrières du Havre")
    prospect = add_prospect(db_session, company, first_name="Jeanne", last_name="Marin")
    add_email(db_session, prospect, "jeanne@carrieres.test")
    referent = InternalReferent(first_name="Hugo", last_name="Hôte", email="hote@circoe.test")
    db_session.add(referent)
    db_session.commit()
    configured.add("E1", tomorrow_at(9), email="Jeanne@Carrieres.test", name="Jeanne Marin")

    report = ok(client.post("/api/agenda/sync"))
    assert (report["ok"], report["created"], report["updated"]) == (True, 1, 0)

    [item] = window(client)
    assert item["invitee_name"] == "Jeanne Marin"
    assert item["company_name"] == "Carrières du Havre"
    assert item["prospect"] == {"id": str(prospect.id), "name": "Jeanne Marin"}
    assert item["referent"]["label"] == "Hugo Hôte"
    assert item["host_name"] == "Hôte Circoe"
    assert item["location"] == "https://meet.test/abc"
    assert item["status"] == "scheduled"

    # Idempotent.
    again = ok(client.post("/api/agenda/sync"))
    assert (again["created"], again["updated"], again["cancelled"]) == (0, 0, 0)
    assert len(window(client)) == 1


def test_an_unknown_invitee_keeps_what_calendly_gave(
    client: TestClient, configured: FakeCalendly
) -> None:
    configured.add(
        "E2",
        tomorrow_at(10),
        email="inconnu@ailleurs.test",
        answers=[{"question": "Votre entreprise", "answer": "Port de Rouen"}],
    )
    ok(client.post("/api/agenda/sync"))
    [item] = window(client)
    assert (item["prospect"], item["referent"]) == (None, None)
    assert item["company_name"] == "Port de Rouen"


def test_follow_up_is_never_overwritten_by_the_next_sync(
    client: TestClient, configured: FakeCalendly
) -> None:
    configured.add("E3", tomorrow_at(11), email="x@y.test")
    ok(client.post("/api/agenda/sync"))
    [item] = window(client)
    url = f"/api/agenda/appointments/{item['id']}"

    done = ok(client.patch(url, json={"status": "no_show", "notes": "Pas venu"}))
    assert (done["status"], done["notes"]) == ("no_show", "Pas venu")

    moved = ok(client.patch(url, json={"starts_at": iso(tomorrow_at(15))}))
    assert moved["status"] == "scheduled"
    assert moved["reschedule_count"] == 1
    assert moved["starts_at"].startswith(iso(tomorrow_at(15))[:13])
    # The length is kept: 30 minutes.
    start = datetime.fromisoformat(moved["starts_at"])
    assert datetime.fromisoformat(moved["ends_at"]) - start == timedelta(minutes=30)

    ok(client.post("/api/agenda/sync"))
    [after] = window(client)
    assert after["notes"] == "Pas venu"
    assert after["reschedule_count"] == 1
    assert datetime.fromisoformat(after["starts_at"]) == start


def test_a_cancellation_is_followed_but_a_reschedule_is_not_a_cancellation(
    client: TestClient, configured: FakeCalendly
) -> None:
    configured.add("OLD", tomorrow_at(9), email="a@b.test")
    configured.add("CANCELLED", tomorrow_at(10), email="c@d.test")
    ok(client.post("/api/agenda/sync"))
    assert len(window(client)) == 2

    configured.events.clear()
    configured.invitees.clear()
    # The first meeting moved: Calendly cancels it (`rescheduled`) and creates a new event.
    configured.add("OLD", tomorrow_at(9), email="a@b.test", canceled=True, rescheduled=True)
    configured.add("NEW", tomorrow_at(14), email="a@b.test", old_invitee=True)
    configured.add("CANCELLED", tomorrow_at(10), email="c@d.test", canceled=True)
    report = ok(client.post("/api/agenda/sync"))
    assert (report["created"], report["cancelled"]) == (1, 1)

    by_time = {item["starts_at"][11:13]: item for item in window(client)}
    assert len(by_time) == 2
    moved = next(item for item in by_time.values() if item["status"] == "scheduled")
    assert moved["reschedule_count"] == 1
    assert [i["status"] for i in by_time.values() if i is not moved] == ["cancelled"]


def test_reminders_list_today_and_tomorrow_with_the_last_sent_mail(
    client: TestClient, db_session: Session
) -> None:
    from tests.builders import start_sequence

    prospect = add_prospect(db_session, first_name="Jeanne", last_name="Marin")
    sequence = start_sequence(db_session, prospect)
    sent_at = datetime.now(UTC) - timedelta(days=3)
    db_session.add(
        ContactMessage(
            prospect_id=prospect.id,
            sequence_id=sequence.id,
            rank=1,
            status=ContactMessageStatus.SENT,
            sent_at=sent_at,
            sent_source=SendSource.MANUAL,
            subject="Votre entité : un échange",
            body_text="Bonjour Jeanne, un échange de 30 minutes ?",
        )
    )
    db_session.commit()

    tomorrow = client.post(
        "/api/agenda/appointments",
        json={
            "invitee_name": "Jeanne Marin",
            "starts_at": iso(tomorrow_at(9)),
            "prospect_id": str(prospect.id),
        },
    )
    assert tomorrow.status_code == 201
    far = datetime.now(UTC) + timedelta(days=5)
    client.post(
        "/api/agenda/appointments", json={"invitee_name": "Plus tard", "starts_at": iso(far)}
    )

    reminders = ok(client.get("/api/agenda/reminders"))
    assert reminders["today"] == []
    [reminder] = reminders["tomorrow"]
    assert reminder["invitee_name"] == "Jeanne Marin"
    assert reminder["last_mail"]["step_label"] == "R1"
    assert reminder["last_mail"]["subject"] == "Votre entité : un échange"

    # A meeting that was cancelled is no reminder.
    client.patch(f"/api/agenda/appointments/{reminder['id']}", json={"status": "cancelled"})
    assert ok(client.get("/api/agenda/reminders"))["tomorrow"] == []


def test_manual_meetings_are_validated(client: TestClient, db_session: Session) -> None:
    start = iso(tomorrow_at(9))
    blank = client.post("/api/agenda/appointments", json={"invitee_name": " ", "starts_at": start})
    assert blank.status_code == 422
    backwards = client.post(
        "/api/agenda/appointments",
        json={"invitee_name": "A", "starts_at": start, "ends_at": iso(tomorrow_at(8))},
    )
    assert backwards.status_code == 422
    missing = client.patch(f"/api/agenda/appointments/{uuid.uuid4()}", json={"status": "completed"})
    assert missing.status_code == 404
    too_wide = client.get(
        "/api/agenda/appointments", params={"start": "2026-01-01", "end": "2026-12-31"}
    )
    assert too_wide.status_code == 422
    assert db_session.query(Appointment).count() == 0
