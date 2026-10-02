"""Contact dashboard (Contact port Slice S3, handoff Task 09): counters = totals of the lists they
open, ISO-week boundaries (week 53, year change), scope (ignored, do-not-contact, inactive), list
criteria, message statuses per step, pagination and the HTTP contract."""

import uuid
from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.business_time import start_of_day
from app.models import ContactMessage, ContactTracking
from app.models.enums import (
    ActivityStatus,
    ContactabilityStatus,
    ContactMessageStatus,
    ContactMessageStep,
    ContactTrackingStatus,
)
from app.services.contact_dashboard import (
    ContactClock,
    ContactCounter,
    ContactFilters,
    NextStep,
    dashboard,
    list_contacts,
)
from app.services.contact_workflow import IsoWeek, next_action_at
from tests.builders import add_company, add_prospect

S = ContactTrackingStatus
C = ContactCounter
# Thursday 31 December 2026: ISO week 2026-W53 (2026 has 53 weeks), which ends on 3 January 2027.
CLOCK = ContactClock(today=date(2026, 12, 31))
W52 = next_action_at(IsoWeek(2026, 52))
W53 = next_action_at(IsoWeek(2026, 53))
W01 = next_action_at(IsoWeek(2027, 1))
# A legacy next action on the last evening of the current week (not a Monday): still this week.
SUNDAY_EVENING = datetime(2027, 1, 3, 23, 30, tzinfo=W53.tzinfo)


def person(
    session: Session,
    name: str,
    state: S | None,
    planned: datetime | None = None,
    **fields: object,
) -> uuid.UUID:
    prospect = add_prospect(session, add_company(session), last_name=name, **fields)
    if state is not None:
        session.add(
            ContactTracking(prospect_id=prospect.id, status=state, planned_contact_at=planned)
        )
        session.flush()
    return prospect.id


@pytest.fixture
def planning(db_session: Session) -> dict[str, uuid.UUID]:
    people = {
        "overdue": person(db_session, "Aaa", S.NEUTRAL, W52),
        "this_week": person(db_session, "Bbb", S.NEUTRAL, W53),
        "sunday": person(db_session, "Ccc", S.NEUTRAL, SUNDAY_EVENING),
        "next_week": person(db_session, "Ddd", S.NEUTRAL, W01),
        "unplanned": person(db_session, "Eee", S.NEUTRAL),
        "contacted": person(db_session, "Fff", S.CONTACTED, W53),
        "r1": person(db_session, "Ggg", S.R1, W52),
        "r2": person(db_session, "Hhh", S.R2, W53),
        "r2_later": person(db_session, "Iii", S.R2, W01),
        "appointment": person(db_session, "Jjj", S.APPOINTMENT_OBTAINED),
        "appointment_dated": person(db_session, "Kkk", S.APPOINTMENT_OBTAINED, W52),
        "failure": person(db_session, "Lll", S.FAILURE, W53),
        "response": person(db_session, "Mmm", S.RESPONSE_RECEIVED, W53),
        "inactive": person(
            db_session, "Nnn", S.NEUTRAL, W53, activity_status=ActivityStatus.INACTIVE
        ),
        # Outside Contact: ignored, opposed, untracked.
        "ignored": person(
            db_session,
            "Ooo",
            S.IGNORED,
            None,
            contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
            do_not_contact_at=W52,
        ),
        "opposed": person(
            db_session,
            "Ppp",
            S.NEUTRAL,
            W53,
            contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
            do_not_contact_at=W52,
        ),
        "untracked": person(db_session, "Qqq", None),
    }
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
        C.TO_HANDLE: 6,
        C.FIRST_CONTACT: 3,  # overdue, this week, Sunday evening — not next week nor unplanned
        C.FOLLOW_UP: 2,  # contacted (R1 to prepare), r1 (R2 to prepare)
        C.REVIEW: 1,  # r2 reached; the later one is not
        C.APPOINTMENTS: 2,  # cumulative, with or without a date
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
    assert names(db_session, ContactFilters(counter=C.REVIEW)) == ["Hhh"]
    assert names(db_session, ContactFilters(counter=C.APPOINTMENTS)) == ["Kkk", "Jjj"]


def test_the_default_list_is_the_planning(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    listed = names(db_session, ContactFilters())
    # Next action first (soonest), then name; never without a week; never ignored or opposed.
    assert listed[:3] == ["Aaa", "Ggg", "Kkk"]
    assert set(listed) == {
        "Aaa",
        "Bbb",
        "Ccc",
        "Ddd",
        "Fff",
        "Ggg",
        "Hhh",
        "Iii",
        "Kkk",
        "Lll",
        "Mmm",
        "Nnn",
    }


def test_week_filter_uses_iso_years(db_session: Session, planning: dict[str, uuid.UUID]) -> None:
    this_week = names(db_session, ContactFilters(week=IsoWeek(2026, 53)))
    assert this_week == ["Bbb", "Fff", "Hhh", "Lll", "Mmm", "Nnn", "Ccc"]
    assert names(db_session, ContactFilters(week=IsoWeek(2027, 1))) == ["Ddd", "Iii"]
    assert names(db_session, ContactFilters(week=IsoWeek(2027, 2))) == []
    # Combined with a card: only what is due in that week.
    due = ContactFilters(week=IsoWeek(2026, 53), counter=C.FIRST_CONTACT)
    assert names(db_session, due) == ["Bbb", "Ccc"]


def test_state_filter_shows_the_unplanned_too(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    assert names(db_session, ContactFilters(state=S.NEUTRAL)) == [
        "Aaa",
        "Bbb",
        "Nnn",
        "Ccc",
        "Ddd",
        "Eee",
    ]
    assert names(db_session, ContactFilters(state=S.FAILURE)) == ["Lll"]


def test_search_narrows_counters_and_list(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    assert dashboard(db_session, CLOCK, "bbb").counts[C.FIRST_CONTACT] == 1
    assert names(db_session, ContactFilters(search="ggg")) == ["Ggg"]


def test_rows_carry_the_step_to_prepare_and_the_message_statuses(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    db_session.add(
        ContactMessage(
            prospect_id=planning["contacted"],
            step=ContactMessageStep.R1,
            status=ContactMessageStatus.DRAFT,
        )
    )
    db_session.flush()
    rows = {
        row.last_name: row
        for row in list_contacts(db_session, ContactFilters(), CLOCK, limit=200).items
    }

    contacted = rows["Fff"]
    assert (contacted.next_step, contacted.due, contacted.next_action_week) == (
        NextStep.R1,
        True,
        "2026-W53",
    )
    assert contacted.messages == {
        ContactMessageStep.CONTACT: None,
        ContactMessageStep.R1: ContactMessageStatus.DRAFT,
        ContactMessageStep.R2: None,
    }
    assert (rows["Aaa"].next_step, rows["Hhh"].next_step, rows["Lll"].next_step) == (
        NextStep.CONTACT,
        NextStep.REVIEW,
        None,
    )
    assert (rows["Ddd"].due, rows["Nnn"].due, rows["Lll"].due) == (False, False, False)


def test_week_options_and_pagination(db_session: Session, planning: dict[str, uuid.UUID]) -> None:
    weeks = dashboard(db_session, CLOCK).weeks
    assert [(week.week, week.count) for week in weeks] == [
        ("2026-W52", 3),
        ("2026-W53", 7),
        ("2027-W01", 2),
    ]
    assert (weeks[1].year, weeks[1].number) == (2026, 53)

    first = list_contacts(db_session, ContactFilters(), CLOCK, limit=5)
    second = list_contacts(db_session, ContactFilters(), CLOCK, limit=5, offset=5)
    assert (first.total, len(first.items), len(second.items)) == (12, 5, 5)
    assert not {row.id for row in first.items} & {row.id for row in second.items}


def test_nothing_changes_a_state(db_session: Session, planning: dict[str, uuid.UUID]) -> None:
    dashboard(db_session, CLOCK)
    list_contacts(db_session, ContactFilters(counter=C.TO_HANDLE), CLOCK)
    tracking = db_session.get(
        ContactTracking,
        db_session.query(ContactTracking.id)
        .filter(ContactTracking.prospect_id == planning["overdue"])
        .scalar(),
    )
    assert tracking is not None and tracking.status is S.NEUTRAL


# --- HTTP ---------------------------------------------------------------------------------------

CONTACT = "/api/contact"


def test_the_dashboard_over_http(client: TestClient, db_session: Session) -> None:
    person(db_session, "Zzz", S.NEUTRAL, start_of_day(date(2020, 1, 6)))

    body = client.get(f"{CONTACT}/dashboard").json()

    assert set(body) == {"today", "current_week", "counts", "weeks", "dispatch"}
    assert body["counts"]["first_contact"] >= 1
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
    assert row["messages"] == {"contact": None, "r1": None, "r2": None}
    assert client.get(f"{CONTACT}/prospects", params={"week": "2020-W02"}).json()["total"] == 1


@pytest.mark.parametrize(
    ("params", "field", "reason"),
    [
        ({"week": "2025-W53"}, "week", "iso_week"),  # 2025 has 52 ISO weeks
        ({"week": "2026-41"}, "week", "iso_week"),
        ({"state": "ignored"}, "state", "not_filterable"),
    ],
)
def test_invalid_criteria_are_refused(
    client: TestClient, params: dict[str, str], field: str, reason: str
) -> None:
    response = client.get(f"{CONTACT}/prospects", params=params)
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert (detail["code"], detail["field"], detail["reason"]) == ("invalid", field, reason)
    assert client.get(f"{CONTACT}/prospects", params={"counter": "other"}).status_code == 422


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
        W52,
        contactability_status=ContactabilityStatus.DO_NOT_CONTACT,
        do_not_contact_at=W52,
    )

    counts = dashboard(db_session, CLOCK).counts

    assert counts[C.APPOINTMENTS] == 3
    assert names(db_session, ContactFilters(counter=C.APPOINTMENTS)) == ["Kkk", "Rrr", "Jjj"]
    # The due cards still leave out the opposed (and the inactive).
    assert counts[C.TO_HANDLE] == 6


@pytest.mark.parametrize("week", ["1999-W10", "2101-W01", "9999-W52"])
def test_implausible_week_years_are_refused(client: TestClient, week: str) -> None:
    response = client.get(f"{CONTACT}/prospects", params={"week": week})
    assert response.status_code == 422
    assert response.json()["detail"]["reason"] == "iso_week"
