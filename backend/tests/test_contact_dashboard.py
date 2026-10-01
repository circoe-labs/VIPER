"""Contact dashboard (Contact port Slice S3, handoff Task 09; sequences rework D1-D9): counters =
totals of the lists they open, next due dates derived from the cohort and the real sends, ISO
calendar-week boundaries (week 53, year change), scope (ignored, Défaillant, do-not-contact,
inactive), pauses (S0, finished, state, « Erreur sur le mail »), list criteria, message statuses
per step, pagination and the HTTP contract."""

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.business_time import BUSINESS_TIMEZONE
from app.models import ContactMessage, ContactSequence, ContactTracking, QualityAlert
from app.models.enums import (
    ActivityStatus,
    ContactabilityStatus,
    ContactMessageStatus,
    ContactMessageStep,
    ContactTrackingStatus,
    QualityAlertSource,
    QualityAlertType,
    SequenceEndReason,
)
from app.services.contact_dashboard import (
    ContactClock,
    ContactCounter,
    ContactFilters,
    dashboard,
    list_contacts,
)
from app.services.contact_workflow import IsoWeek
from tests.builders import FIXTURE_ACTOR, add_cohort, add_company, add_prospect, add_send

S = ContactTrackingStatus
C = ContactCounter
# Thursday 31 December 2026: ISO week 2026-W53 (2026 has 53 weeks), which ends on 3 January 2027.
CLOCK = ContactClock(today=date(2026, 12, 31))
MONDAY_W52 = date(2026, 12, 21)
MONDAY_W53 = date(2026, 12, 28)
SUNDAY_W53 = date(2027, 1, 3)
MONDAY_W01 = date(2027, 1, 4)


def at(day: date, hour: int = 10) -> datetime:
    return datetime(day.year, day.month, day.day, hour, tzinfo=BUSINESS_TIMEZONE)


def person(
    session: Session,
    name: str,
    state: S | None,
    cohort: tuple[str, date | None] | None = None,
    sends: tuple[datetime, ...] = (),
    **fields: object,
) -> uuid.UUID:
    """A prospect with a tracking in `state` (None: no tracking) and, when given, a current
    sequence in the cohort `(code, start date)` with `sends` really sent."""
    prospect = add_prospect(session, add_company(session), last_name=name, **fields)
    if state is not None:
        session.add(ContactTracking(prospect_id=prospect.id, status=state))
    if cohort is not None:
        code, starts_on = cohort
        sequence = ContactSequence(
            prospect_id=prospect.id, cohort_id=add_cohort(session, code, starts_on).id
        )
        session.add(sequence)
        session.flush()
        for rank, moment in enumerate(sends):
            add_send(session, sequence, rank, moment)
    session.flush()
    return prospect.id


S52 = ("S52", MONDAY_W52)
S53 = ("S53", MONDAY_W53)
S54 = ("S54", SUNDAY_W53)
S55 = ("S55", MONDAY_W01)


@pytest.fixture
def planning(db_session: Session) -> dict[str, uuid.UUID]:
    people = {
        "overdue": person(db_session, "Aaa", S.NEUTRAL, S52),
        "this_week": person(db_session, "Bbb", S.NEUTRAL, S53),
        "sunday": person(db_session, "Ccc", S.NEUTRAL, S54),
        "next_week": person(db_session, "Ddd", S.NEUTRAL, S55),
        "unvalidated": person(db_session, "Eee", S.NEUTRAL),
        # Contact sent on Tuesday of W52: R1 due on Monday of W53.
        "contacted": person(db_session, "Fff", S.NEUTRAL, S52, (at(date(2026, 12, 22)),)),
        # Contact and R1 sent; R1 on Tuesday of W51: R2 due on Monday of W52 (overdue).
        "r1": person(
            db_session,
            "Ggg",
            S.NEUTRAL,
            ("S50", date(2026, 12, 7)),
            (at(date(2026, 12, 8)), at(date(2026, 12, 15))),
        ),
        # Contact and R1…R4 sent (max 4): « Relance terminée ».
        "finished": person(
            db_session,
            "Hhh",
            S.NEUTRAL,
            ("S45", date(2026, 11, 2)),
            tuple(at(date(2026, 11, 3) + timedelta(weeks=week)) for week in range(5)),
        ),
        "appointment": person(db_session, "Jjj", S.APPOINTMENT_OBTAINED),
        "appointment_in_cohort": person(db_session, "Kkk", S.APPOINTMENT_OBTAINED, S52),
        "completed": person(db_session, "Lll", S.NEUTRAL, S52),
        "response": person(db_session, "Mmm", S.RESPONSE_RECEIVED, S53),
        "inactive": person(
            db_session, "Nnn", S.NEUTRAL, S53, activity_status=ActivityStatus.INACTIVE
        ),
        # Outside Contact: ignored, Défaillant, opposed, neither cohort nor tracking.
        "ignored": person(
            db_session,
            "Ooo",
            S.IGNORED,
            S53,
            contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
            do_not_contact_at=at(MONDAY_W52),
        ),
        "opposed": person(
            db_session,
            "Ppp",
            S.NEUTRAL,
            S53,
            contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
            do_not_contact_at=at(MONDAY_W52),
        ),
        "untracked": person(db_session, "Qqq", None),
        "disqualified": person(db_session, "Rrq", S.DISQUALIFIED, S53),
        # In scope, nothing due: S0, an open « Erreur sur le mail ».
        "s0": person(db_session, "Sss", S.NEUTRAL, ("S0", None)),
        "email_error": person(db_session, "Ttt", S.NEUTRAL, S53),
    }
    completed = db_session.query(ContactSequence).filter_by(prospect_id=people["completed"]).one()
    completed.closed_at = at(MONDAY_W52)
    completed.end_reason = SequenceEndReason.COMPLETED
    db_session.add(
        QualityAlert(
            prospect_id=people["email_error"],
            type=QualityAlertType.EMAIL_ERROR,
            source=QualityAlertSource.HUMAN,
            raised_by_type=FIXTURE_ACTOR.type,
            raised_by_display=FIXTURE_ACTOR.display,
        )
    )
    db_session.flush()
    return people


def names(session: Session, filters: ContactFilters) -> list[str]:
    page = list_contacts(session, filters, CLOCK, limit=200)
    assert page.total == len(page.items)
    return [item.last_name or "" for item in page.items]


def test_counters_split_this_weeks_work(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    result = dashboard(db_session, CLOCK)

    assert result.current_week == "2026-W53"
    assert result.counts == {
        C.TO_HANDLE: 5,
        C.FIRST_CONTACT: 3,  # overdue, this week, Sunday — not next week, not unvalidated
        C.FOLLOW_UP: 2,  # R1 due this week, R2 overdue — never the finished sequence
        C.APPOINTMENTS: 2,  # cumulative, with or without a cohort
    }


@pytest.mark.parametrize("counter", list(ContactCounter))
def test_each_counter_equals_the_list_it_opens(
    db_session: Session, planning: dict[str, uuid.UUID], counter: ContactCounter
) -> None:
    counts = dashboard(db_session, CLOCK).counts
    page = list_contacts(db_session, ContactFilters(counter=counter), CLOCK)
    assert page.total == counts[counter]


def test_the_lists_of_each_card(db_session: Session, planning: dict[str, uuid.UUID]) -> None:
    assert names(db_session, ContactFilters(counter=C.FIRST_CONTACT)) == ["Aaa", "Bbb", "Ccc"]
    assert names(db_session, ContactFilters(counter=C.FOLLOW_UP)) == ["Ggg", "Fff"]
    assert names(db_session, ContactFilters(counter=C.APPOINTMENTS)) == ["Jjj", "Kkk"]


def test_the_default_list_is_the_planning(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    # Next due date first (soonest), then name; never without one (paused, finished, S0,
    # unvalidated); never ignored, Défaillant or opposed.
    assert names(db_session, ContactFilters()) == ["Aaa", "Ggg", "Bbb", "Fff", "Nnn", "Ccc", "Ddd"]


def test_week_filter_uses_iso_years(db_session: Session, planning: dict[str, uuid.UUID]) -> None:
    assert names(db_session, ContactFilters(week=IsoWeek(2026, 53))) == ["Bbb", "Fff", "Nnn", "Ccc"]
    assert names(db_session, ContactFilters(week=IsoWeek(2027, 1))) == ["Ddd"]
    assert names(db_session, ContactFilters(week=IsoWeek(2027, 2))) == []
    # Combined with a card: only what is due in that week.
    due = ContactFilters(week=IsoWeek(2026, 53), counter=C.FIRST_CONTACT)
    assert names(db_session, due) == ["Bbb", "Ccc"]


def test_state_filter_shows_the_unplanned_too(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    assert names(db_session, ContactFilters(state=S.NEUTRAL)) == [
        "Aaa",
        "Ggg",
        "Bbb",
        "Fff",
        "Nnn",
        "Ccc",
        "Ddd",
        "Eee",
        "Hhh",
        "Lll",
        "Sss",
        "Ttt",
    ]
    assert names(db_session, ContactFilters(state=S.RESPONSE_RECEIVED)) == ["Mmm"]


def test_search_narrows_counters_and_list(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    assert dashboard(db_session, CLOCK, "bbb").counts[C.FIRST_CONTACT] == 1
    assert names(db_session, ContactFilters(search="ggg")) == ["Ggg"]


def test_rows_carry_the_level_and_the_message_statuses(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    sequence = db_session.query(ContactSequence).filter_by(prospect_id=planning["contacted"]).one()
    db_session.add(
        ContactMessage(
            prospect_id=planning["contacted"],
            sequence_id=sequence.id,
            rank=1,
            status=ContactMessageStatus.DRAFT,
        )
    )
    db_session.flush()
    rows = {
        row.last_name: row
        for row in list_contacts(db_session, ContactFilters(state=S.NEUTRAL), CLOCK).items
    }

    contacted = rows["Fff"]
    assert (contacted.next_step, contacted.due, contacted.next_action_week) == (
        "r1",
        True,
        "2026-W53",
    )
    assert (contacted.cohort_code, contacted.sent_count, contacted.finished) == ("S52", 1, False)
    assert contacted.next_due_at == at(MONDAY_W53, 0)
    assert contacted.messages == {
        ContactMessageStep.CONTACT: ContactMessageStatus.SENT,
        ContactMessageStep.R1: ContactMessageStatus.DRAFT,
        ContactMessageStep.R2: None,
    }
    assert (rows["Aaa"].next_step, rows["Ggg"].next_step) == ("contact", "r2")
    assert (rows["Hhh"].next_step, rows["Hhh"].finished, rows["Hhh"].sent_count) == (None, True, 5)
    assert (rows["Lll"].next_step, rows["Lll"].finished) == (None, True)
    assert (rows["Eee"].cohort_code, rows["Eee"].next_step) == (None, None)
    assert (rows["Ddd"].due, rows["Nnn"].due, rows["Ttt"].due) == (False, False, False)
    assert rows["Ttt"].next_due_at is None


def test_week_options_and_pagination(db_session: Session, planning: dict[str, uuid.UUID]) -> None:
    weeks = dashboard(db_session, CLOCK).weeks
    assert [(week.week, week.count) for week in weeks] == [
        ("2026-W52", 2),
        ("2026-W53", 4),
        ("2027-W01", 1),
    ]
    assert (weeks[1].year, weeks[1].number) == (2026, 53)

    first = list_contacts(db_session, ContactFilters(), CLOCK, limit=5)
    second = list_contacts(db_session, ContactFilters(), CLOCK, limit=5, offset=5)
    assert (first.total, len(first.items), len(second.items)) == (7, 5, 2)
    assert not {row.id for row in first.items} & {row.id for row in second.items}


def test_nothing_changes_a_state(db_session: Session, planning: dict[str, uuid.UUID]) -> None:
    dashboard(db_session, CLOCK)
    list_contacts(db_session, ContactFilters(counter=C.TO_HANDLE), CLOCK)
    tracking = db_session.query(ContactTracking).filter_by(prospect_id=planning["overdue"]).one()
    assert tracking.status is S.NEUTRAL


def test_the_maximum_of_follow_ups_is_read_from_the_settings(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    from app.models import AppSetting

    db_session.add(AppSetting(key="contact.max_follow_ups", value=1))
    db_session.flush()

    counts = dashboard(db_session, CLOCK).counts

    # R2 of « r1 » is beyond the maximum: finished, no longer due.
    assert counts[C.FOLLOW_UP] == 1
    assert names(db_session, ContactFilters(counter=C.FOLLOW_UP)) == ["Fff"]


# --- HTTP ---------------------------------------------------------------------------------------

CONTACT = "/api/contact"


def test_the_dashboard_over_http(client: TestClient, db_session: Session) -> None:
    person(db_session, "Zzz", S.NEUTRAL, ("S2", date(2020, 1, 6)))

    body = client.get(f"{CONTACT}/dashboard").json()

    assert set(body) == {"today", "current_week", "counts", "weeks"}
    assert body["counts"]["first_contact"] >= 1
    assert "review" not in body["counts"]
    assert body["weeks"][0] == {"week": "2020-W02", "year": 2020, "number": 2, "count": 1}
    page = client.get(f"{CONTACT}/prospects", params={"counter": "first_contact", "q": "zzz"})
    assert page.status_code == 200, page.text
    [row] = page.json()["items"]
    assert (row["last_name"], row["due"], row["next_step"], row["next_action_week"]) == (
        "Zzz",
        True,
        "contact",
        "2020-W02",
    )
    assert (row["cohort_code"], row["sent_count"], row["finished"]) == ("S2", 0, False)
    assert row["messages"] == {"contact": None, "r1": None, "r2": None}
    assert client.get(f"{CONTACT}/prospects", params={"week": "2020-W02"}).json()["total"] == 1


@pytest.mark.parametrize(
    ("params", "field", "reason"),
    [
        ({"week": "2025-W53"}, "week", "iso_week"),  # 2025 has 52 ISO weeks
        ({"week": "2026-41"}, "week", "iso_week"),
        ({"state": "ignored"}, "state", "not_filterable"),
        ({"state": "disqualified"}, "state", "not_filterable"),
    ],
)
def test_invalid_criteria_are_refused(
    client: TestClient, params: dict[str, str], field: str, reason: str
) -> None:
    response = client.get(f"{CONTACT}/prospects", params=params)
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert (detail["code"], detail["field"], detail["reason"]) == ("invalid", field, reason)
    assert client.get(f"{CONTACT}/prospects", params={"counter": "review"}).status_code == 422
    assert client.get(f"{CONTACT}/prospects", params={"state": "contacted"}).status_code == 422


def test_the_dashboard_needs_a_session(anonymous_client: TestClient) -> None:
    assert anonymous_client.get(f"{CONTACT}/dashboard").status_code == 401
    assert anonymous_client.get(f"{CONTACT}/prospects").status_code == 401


def test_an_appointment_counts_whatever_the_opposition(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    person(
        db_session,
        "Rrr",
        S.APPOINTMENT_OBTAINED,
        S52,
        contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
        do_not_contact_at=datetime(2026, 12, 1, tzinfo=UTC),
    )

    counts = dashboard(db_session, CLOCK).counts

    assert counts[C.APPOINTMENTS] == 3
    assert names(db_session, ContactFilters(counter=C.APPOINTMENTS)) == ["Jjj", "Kkk", "Rrr"]
    # The due cards still leave out the opposed (and the inactive).
    assert counts[C.TO_HANDLE] == 5


@pytest.mark.parametrize("week", ["1999-W10", "2101-W01", "9999-W52"])
def test_implausible_week_years_are_refused(client: TestClient, week: str) -> None:
    response = client.get(f"{CONTACT}/prospects", params={"week": week})
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "iso_week"
