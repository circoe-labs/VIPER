"""Contact weekly planning (sequences rework S3, handoff §11): what to send per rank in a week
(overdue included in the current one), levels of the sequences in progress, categories, cohorts,
week boundaries (Sunday 23:30 vs Monday 00:00 Paris, the end of daylight saving time), missing
weeks (S37 and S39 without S38), a lowered « max relances », a change of cohort mid-sequence, an
« Erreur sur le mail » paused then resumed, an idempotent « Marquer comme envoyé », every count
equal to the total of its list, and the HTTP contract."""

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.core.business_time import BUSINESS_TIMEZONE, start_of_day
from app.core.contact_steps import level_keys
from app.models import ContactMessage, ContactSequence, ContactTracking
from app.models.enums import (
    ActivityStatus,
    ContactabilityStatus,
    ContactMessageStatus,
    ContactTrackingStatus,
    QualityAlertType,
)
from app.services import app_settings, contact_messages, contact_sequences, quality_alerts
from app.services.contact_dashboard import (
    COUNTED_CATEGORIES,
    ContactCategory,
    ContactClock,
    ContactFilters,
    ContactSort,
    dashboard,
    list_contacts,
)
from app.services.contact_workflow import IsoWeek
from tests.builders import OPERATOR, add_cohort, add_company, add_prospect, add_send

S = ContactTrackingStatus
C = ContactCategory
AGENT = ActorContext(type=ActorType.AGENT, display="Agent qualité (test)", id="agent.test")
# Thursday 1 October 2026: ISO week 2026-W40, Monday 28 September … Sunday 4 October.
CLOCK = ContactClock(today=date(2026, 10, 1))
W39, W40, W41 = IsoWeek(2026, 39), IsoWeek(2026, 40), IsoWeek(2026, 41)
# The cohorts' real dates; there was no prospecting in week 38 (no S38).
S37 = ("S37", date(2026, 9, 7))
S39 = ("S39", date(2026, 9, 28))
S40 = ("S40", date(2026, 10, 5))
S0 = ("S0", None)


def at(day: date, hour: int = 10) -> datetime:
    return datetime(day.year, day.month, day.day, hour, tzinfo=BUSINESS_TIMEZONE)


def weekly(first: date, count: int) -> tuple[datetime, ...]:
    """`count` real sends, one a week from `first`."""
    return tuple(at(first + timedelta(weeks=week)) for week in range(count))


def person(
    session: Session,
    name: str,
    state: S | None = S.NEUTRAL,
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


OPPOSED: dict[str, Any] = {
    "contactability_status": ContactabilityStatus.DO_NOT_CONTACT,
    "do_not_contact_at": datetime(2026, 9, 1, tzinfo=UTC),
}


@pytest.fixture
def planning(db_session: Session) -> dict[str, uuid.UUID]:
    people = {
        # S37 (7 Sept): Contact and R1 sent, nothing in week 38 → R2 due since 21 Sept (overdue).
        "r2_overdue": person(db_session, "Aaa", cohort=S37, sends=weekly(date(2026, 9, 7), 2)),
        # Contact, R1, R2 sent (the last on 21 Sept) → R3 due on Monday 28 Sept (this week).
        "r3": person(db_session, "Bbb", cohort=S37, sends=weekly(date(2026, 9, 7), 3)),
        # R3 sent on Monday 28 Sept → R4 due on Monday 5 Oct (next week).
        "r4_next": person(db_session, "Ccc", cohort=S37, sends=weekly(date(2026, 9, 7), 4)),
        # Contact … R4 sent (max 4): « Relance terminée ».
        "finished": person(db_session, "Ddd", cohort=S37, sends=weekly(date(2026, 8, 31), 5)),
        # S39 (28 Sept): nothing sent → Contact due this week.
        "new": person(db_session, "Eee", cohort=S39),
        # Contact sent on 28 Sept → R1 due next week.
        "contacted": person(db_session, "Fff", cohort=S39, sends=(at(date(2026, 9, 28)),)),
        # S40 (5 Oct, future): Contact due next week.
        "next_cohort": person(db_session, "Ggg", cohort=S40),
        # Paused by a person's « Erreur sur le mail »; an AI alert pauses nothing.
        "email_error": person(db_session, "Hhh", cohort=S39),
        "ai_alert": person(db_session, "Iii", cohort=S39),
        "inactive": person(db_session, "Jjj", cohort=S39, activity_status=ActivityStatus.INACTIVE),
        "s0": person(db_session, "Kkk", cohort=S0),
        "disqualified": person(db_session, "Lll", S.DISQUALIFIED),
        "response": person(db_session, "Mmm", S.RESPONSE_RECEIVED, S39),
        "appointment": person(db_session, "Nnn", S.APPOINTMENT_OBTAINED, S37),
        "ignored": person(db_session, "Ooo", S.IGNORED, **OPPOSED),
        "opposed": person(db_session, "Ppp", S.NEUTRAL, S39, **OPPOSED),
        # Out of the page: neither cohort, tracking nor alert.
        "untracked": person(db_session, "Qqq", None),
    }
    raise_alert(db_session, OPERATOR, people["email_error"])
    raise_alert(db_session, AGENT, people["ai_alert"])
    return people


def raise_alert(session: Session, actor: ActorContext, prospect_id: uuid.UUID) -> uuid.UUID:
    return quality_alerts.raise_alert(
        session,
        actor,
        quality_alerts.AlertInput(QualityAlertType.EMAIL_ERROR, prospect_id=prospect_id),
    ).id


def names(session: Session, filters: ContactFilters, clock: ContactClock = CLOCK) -> list[str]:
    page = list_contacts(session, filters, clock, limit=200)
    assert page.total == len(page.items)
    return [item.last_name or "" for item in page.items]


def groups(result: Any) -> dict[int, tuple[int, int]]:
    return {group.rank: (group.count, group.overdue) for group in result.to_send.groups}


def levels(result: Any) -> dict[str, int]:
    return {level.level: level.count for level in result.levels}


# --- what to send ---------------------------------------------------------------------------------


def test_this_weeks_planning_by_rank(db_session: Session, planning: dict[str, uuid.UUID]) -> None:
    result = dashboard(db_session, CLOCK)

    assert (result.current_week, result.week.week, result.week.is_current) == (
        "2026-W40",
        "2026-W40",
        True,
    )
    assert (result.week.monday, result.week.sunday) == (date(2026, 9, 28), date(2026, 10, 4))
    assert (result.to_send.total, result.to_send.overdue) == (4, 1)
    # Contact: the new S39 prospect and the AI-alert one; R2 overdue (no S38); R3 this week.
    assert groups(result) == {0: (2, 0), 1: (0, 0), 2: (1, 1), 3: (1, 0), 4: (0, 0)}
    assert [group.step_label for group in result.to_send.groups] == [
        "Contact",
        "R1",
        "R2",
        "R3",
        "R4",
    ]
    assert names(db_session, ContactFilters()) == ["Aaa", "Bbb", "Eee", "Iii"]
    assert names(db_session, ContactFilters(rank=0)) == ["Eee", "Iii"]


def test_a_future_or_past_week_shows_only_its_own_due_dates(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    upcoming = dashboard(db_session, CLOCK, ContactFilters(week=W41))
    assert (upcoming.to_send.total, upcoming.to_send.overdue, upcoming.week.is_current) == (
        3,
        0,
        False,
    )
    assert groups(upcoming) == {0: (1, 0), 1: (1, 0), 2: (0, 0), 3: (0, 0), 4: (1, 0)}
    assert names(db_session, ContactFilters(week=W41)) == ["Ccc", "Fff", "Ggg"]

    past = dashboard(db_session, CLOCK, ContactFilters(week=W39))
    assert (past.to_send.total, past.to_send.overdue) == (1, 1)
    assert names(db_session, ContactFilters(week=W39)) == ["Aaa"]


def test_a_missing_week_never_moves_a_level(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    """S37 then S39, no S38: the S37 prospect whose R1 left on 14 Sept still has R2 to send, two
    weeks later — only a real send moves it."""
    [row] = list_contacts(db_session, ContactFilters(rank=2), CLOCK).items

    assert (row.last_name, row.cohort_code, row.sent_count) == ("Aaa", "S37", 2)
    assert (row.level, row.level_label, row.next_step, row.next_step_label) == (
        "r1_sent",
        "R1 envoyée",
        "r2",
        "R2",
    )
    assert (row.next_due_at, row.next_due_week) == (start_of_day(date(2026, 9, 21)), "2026-W39")
    assert (row.to_send, row.overdue) == (True, True)


def test_nothing_out_of_the_automatic_actions_is_ever_to_send(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    to_send_ids = {
        row.id
        for week in (W39, W40, W41, IsoWeek(2026, 42))
        for row in list_contacts(db_session, ContactFilters(week=week), CLOCK, limit=200).items
    }
    for key in (
        "finished",
        "email_error",
        "inactive",
        "s0",
        "disqualified",
        "response",
        "appointment",
        "ignored",
        "opposed",
        "untracked",
    ):
        assert planning[key] not in to_send_ids, key


# --- levels, categories, cohorts ------------------------------------------------------------------


def test_levels_of_the_sequences_in_progress(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    result = dashboard(db_session, CLOCK)

    assert levels(result) == {
        "contact_pending": 5,  # new, next cohort, email error, AI alert, inactive
        "contact_sent": 1,
        "r1_sent": 1,
        "r2_sent": 1,
        "r3_sent": 1,
        "finished": 1,
    }
    assert [level.label for level in result.levels] == [
        "Contact à envoyer",
        "Contact envoyé",
        "R1 envoyée",
        "R2 envoyée",
        "R3 envoyée",
        "Relance terminée",
    ]
    assert sum(levels(result).values()) == result.categories[0].count  # `in_sequence`


def test_categories(db_session: Session, planning: dict[str, uuid.UUID]) -> None:
    counts = {item.category: item.count for item in dashboard(db_session, CLOCK).categories}

    assert counts == {
        C.IN_SEQUENCE: 10,
        C.EMAIL_ERROR: 1,
        C.FINISHED: 1,
        C.DISQUALIFIED: 1,
        C.OUT_OF_CAMPAIGN: 1,
        C.RESPONSE_RECEIVED: 1,
        C.APPOINTMENT_OBTAINED: 1,
        C.IGNORED: 2,
    }
    assert names(db_session, ContactFilters(category=C.EMAIL_ERROR)) == ["Hhh"]
    assert names(db_session, ContactFilters(category=C.FINISHED)) == ["Ddd"]
    assert names(db_session, ContactFilters(category=C.DISQUALIFIED)) == ["Lll"]
    assert names(db_session, ContactFilters(category=C.OUT_OF_CAMPAIGN)) == ["Kkk"]
    assert names(db_session, ContactFilters(category=C.IGNORED, sort=ContactSort.NAME)) == [
        "Ooo",
        "Ppp",
    ]


@pytest.mark.parametrize("category", list(COUNTED_CATEGORIES))
def test_each_category_count_equals_its_list(
    db_session: Session, planning: dict[str, uuid.UUID], category: ContactCategory
) -> None:
    counts = {item.category: item.count for item in dashboard(db_session, CLOCK).categories}
    assert (
        list_contacts(db_session, ContactFilters(category=category), CLOCK).total
        == (counts[category])
    )


def test_each_rank_and_level_count_equals_its_list(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    result = dashboard(db_session, CLOCK)
    for group in result.to_send.groups:
        assert (
            list_contacts(db_session, ContactFilters(rank=group.rank), CLOCK).total == group.count
        )
    for level in result.levels:
        filters = ContactFilters(category=C.IN_SEQUENCE, level=level.level)
        assert list_contacts(db_session, filters, CLOCK).total == level.count


def test_cohorts_show_where_their_sequences_stand(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    cohorts = {cohort.code: cohort for cohort in dashboard(db_session, CLOCK).cohorts}

    assert list(cohorts) == ["S37", "S39", "S40", "S0"]
    s37 = cohorts["S37"]
    assert (s37.starts_on, s37.prospects, s37.in_sequence, s37.to_send, s37.overdue) == (
        date(2026, 9, 7),
        5,  # four in sequence and the appointment
        4,
        2,
        1,
    )
    assert {level.level: level.count for level in s37.levels if level.count} == {
        "r1_sent": 1,
        "r2_sent": 1,
        "r3_sent": 1,
        "finished": 1,
    }
    s39 = cohorts["S39"]
    assert (s39.prospects, s39.in_sequence, s39.to_send) == (7, 5, 2)
    assert (cohorts["S0"].prospects, cohorts["S0"].levels) == (1, [])
    s37_only = ContactFilters(cohort=s37.id)
    assert names(db_session, s37_only) == ["Aaa", "Bbb"]
    assert dashboard(db_session, CLOCK, s37_only).to_send.total == 2


def test_week_options(db_session: Session, planning: dict[str, uuid.UUID]) -> None:
    weeks = dashboard(db_session, CLOCK).weeks

    assert [(week.week, week.count) for week in weeks] == [
        ("2026-W39", 1),
        ("2026-W40", 3),
        ("2026-W41", 3),
    ]
    assert (weeks[2].year, weeks[2].number, weeks[2].monday) == (2026, 41, date(2026, 10, 5))


def test_search_and_rows(db_session: Session, planning: dict[str, uuid.UUID]) -> None:
    assert dashboard(db_session, CLOCK, ContactFilters(search="bbb")).to_send.total == 1
    sequence = db_session.query(ContactSequence).filter_by(prospect_id=planning["r3"]).one()
    db_session.add(
        ContactMessage(
            prospect_id=planning["r3"],
            sequence_id=sequence.id,
            rank=3,
            status=ContactMessageStatus.DRAFT,
        )
    )
    db_session.flush()

    [row] = list_contacts(db_session, ContactFilters(search="bbb"), CLOCK).items

    assert (row.next_rank, row.next_message_status, row.email_error) == (
        3,
        ContactMessageStatus.DRAFT,
        False,
    )
    assert [(message.step, message.status) for message in row.messages] == [
        ("contact", ContactMessageStatus.SENT),
        ("r1", ContactMessageStatus.SENT),
        ("r2", ContactMessageStatus.SENT),
        ("r3", ContactMessageStatus.DRAFT),
    ]
    assert row.last_sent_at == at(date(2026, 9, 21))
    error_row = list_contacts(db_session, ContactFilters(category=C.EMAIL_ERROR), CLOCK).items[0]
    assert (error_row.email_error, error_row.next_due_at, error_row.to_send) == (True, None, False)


def test_pagination(db_session: Session, planning: dict[str, uuid.UUID]) -> None:
    first = list_contacts(db_session, ContactFilters(category=C.IN_SEQUENCE), CLOCK, limit=4)
    second = list_contacts(
        db_session, ContactFilters(category=C.IN_SEQUENCE), CLOCK, limit=4, offset=4
    )
    assert (first.total, len(first.items), len(second.items)) == (10, 4, 4)
    assert not {row.id for row in first.items} & {row.id for row in second.items}


# --- changes --------------------------------------------------------------------------------------


def test_a_lower_maximum_finishes_sequences(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    app_settings.set_max_follow_ups(db_session, OPERATOR, 2)

    result = dashboard(db_session, CLOCK)

    # R3 is beyond the maximum: « Relance terminée », nothing due; R2 is still the last one.
    assert result.max_follow_ups == 2
    assert groups(result) == {0: (2, 0), 1: (0, 0), 2: (1, 1)}
    assert levels(result) == {"contact_pending": 5, "contact_sent": 1, "r1_sent": 1, "finished": 3}
    assert [level.level for level in result.levels] == level_keys(2)
    assert names(db_session, ContactFilters(category=C.FINISHED)) == ["Bbb", "Ccc", "Ddd"]


def test_a_cohort_change_restarts_the_planning(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    s41 = add_cohort(db_session, "S41", date(2026, 10, 12))

    contact_sequences.change_cohort(db_session, OPERATOR, planning["r2_overdue"], s41.id)

    assert names(db_session, ContactFilters()) == ["Bbb", "Eee", "Iii"]
    assert names(db_session, ContactFilters(week=IsoWeek(2026, 42))) == ["Aaa"]
    cohorts = {cohort.code: cohort for cohort in dashboard(db_session, CLOCK).cohorts}
    assert (cohorts["S41"].prospects, cohorts["S37"].prospects) == (1, 4)
    [row] = list_contacts(
        db_session, ContactFilters(search="aaa", category=C.IN_SEQUENCE), CLOCK
    ).items
    assert (row.cohort_code, row.sent_count, row.level, row.messages) == (
        "S41",
        0,
        "contact_pending",
        [],
    )


def test_an_email_error_pauses_then_resumes(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    alert_id = raise_alert(db_session, OPERATOR, planning["new"])
    assert "Eee" not in names(db_session, ContactFilters())
    assert "Eee" in names(db_session, ContactFilters(category=C.EMAIL_ERROR))

    quality_alerts.resolve_alert(db_session, OPERATOR, alert_id, note="Adresse corrigée")

    assert "Eee" in names(db_session, ContactFilters(rank=0))
    assert "Eee" not in names(db_session, ContactFilters(category=C.EMAIL_ERROR))


def test_mark_sent_moves_the_prospect_once(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    moment = datetime(2026, 9, 29, 9, tzinfo=UTC)
    for _ in range(2):
        contact_messages.mark_sent(
            db_session, OPERATOR, planning["new"], rank=0, sent_at=moment, now=moment
        )

    assert "Eee" not in names(db_session, ContactFilters())
    assert names(db_session, ContactFilters(week=W41, rank=1)) == ["Eee", "Fff"]
    [row] = list_contacts(db_session, ContactFilters(week=W41, search="eee"), CLOCK).items
    assert (row.sent_count, row.level) == (1, "contact_sent")


def test_a_planned_message_is_still_to_send(
    db_session: Session, planning: dict[str, uuid.UUID]
) -> None:
    sequence = db_session.query(ContactSequence).filter_by(prospect_id=planning["new"]).one()
    db_session.add(
        ContactMessage(
            prospect_id=planning["new"],
            sequence_id=sequence.id,
            rank=0,
            status=ContactMessageStatus.CANCELLED,
            cancelled_at=datetime(2026, 9, 29, tzinfo=UTC),
        )
    )
    db_session.flush()

    [row] = list_contacts(db_session, ContactFilters(search="eee"), CLOCK).items
    assert (row.to_send, row.sent_count, row.next_message_status) == (
        True,
        0,
        ContactMessageStatus.CANCELLED,
    )


# --- week boundaries (Europe/Paris) ---------------------------------------------------------------


def test_sunday_evening_and_monday_midnight_at_the_end_of_summer_time(db_session: Session) -> None:
    """Summer time ends on Sunday 25 October 2026 (UTC+2 → UTC+1). A send on Sunday 23:30 makes
    R1 due the next day; a send on Monday 00:30 the Monday after. The planning's week turns at
    Monday 00:00 Paris (23:00 UTC on Sunday)."""
    sunday = person(
        db_session,
        "Dimanche",
        cohort=("S43", date(2026, 10, 19)),
        sends=(datetime(2026, 10, 25, 22, 30, tzinfo=UTC),),  # Sunday 23:30 Paris
    )
    monday = person(
        db_session,
        "Lundi",
        cohort=("S43", date(2026, 10, 19)),
        sends=(datetime(2026, 10, 25, 23, 30, tzinfo=UTC),),  # Monday 00:30 Paris
    )
    sunday_late = ContactClock.at(datetime(2026, 10, 25, 22, 59, tzinfo=UTC))  # Sun 23:59
    monday_start = ContactClock.at(datetime(2026, 10, 25, 23, 0, tzinfo=UTC))  # Mon 00:00

    assert (sunday_late.today, monday_start.today) == (date(2026, 10, 25), date(2026, 10, 26))
    assert names(db_session, ContactFilters(), sunday_late) == []
    assert names(db_session, ContactFilters(), monday_start) == ["Dimanche"]
    rows = {
        row.id: row
        for row in list_contacts(
            db_session, ContactFilters(category=C.IN_SEQUENCE), monday_start
        ).items
    }
    assert rows[sunday].next_due_at == datetime(2026, 10, 25, 23, 0, tzinfo=UTC)
    assert rows[monday].next_due_at == datetime(2026, 11, 1, 23, 0, tzinfo=UTC)
    assert (rows[sunday].next_due_week, rows[monday].next_due_week) == ("2026-W44", "2026-W45")
    week = dashboard(db_session, monday_start).week
    assert (week.week, week.monday, week.sunday) == (
        "2026-W44",
        date(2026, 10, 26),
        date(2026, 11, 1),
    )


def test_a_cohort_starting_on_monday_is_due_from_monday_midnight(db_session: Session) -> None:
    person(db_session, "Cohorte", cohort=("S44", date(2026, 10, 26)))

    before = ContactClock.at(datetime(2026, 10, 25, 22, 30, tzinfo=UTC))  # Sunday 23:30 Paris
    after = ContactClock.at(datetime(2026, 10, 25, 23, 0, tzinfo=UTC))  # Monday 00:00 Paris

    assert dashboard(db_session, before).to_send.total == 0
    assert dashboard(db_session, after).to_send.total == 1
    assert names(db_session, ContactFilters(week=IsoWeek(2026, 44)), before) == ["Cohorte"]


def test_nothing_changes_anything(db_session: Session, planning: dict[str, uuid.UUID]) -> None:
    before = [(row.prospect_id, row.status) for row in db_session.query(ContactTracking).all()]
    sends = db_session.query(ContactMessage).count()
    dashboard(db_session, CLOCK)
    for category in ContactCategory:
        list_contacts(db_session, ContactFilters(category=category), CLOCK)
    assert [
        (row.prospect_id, row.status) for row in db_session.query(ContactTracking).all()
    ] == before
    assert db_session.query(ContactMessage).count() == sends


# --- HTTP -----------------------------------------------------------------------------------------

CONTACT = "/api/contact"


def test_the_planning_over_http(client: TestClient, db_session: Session) -> None:
    person(db_session, "Zzz", cohort=("S2", date(2020, 1, 6)))

    body = client.get(f"{CONTACT}/dashboard").json()

    assert set(body) == {
        "today",
        "current_week",
        "week",
        "max_follow_ups",
        "to_send",
        "levels",
        "categories",
        "cohorts",
        "weeks",
        "dispatch",
    }
    assert body["week"]["week"] == body["current_week"]
    assert body["max_follow_ups"] == 4
    assert body["to_send"]["total"] >= 1 and body["to_send"]["overdue"] >= 1
    assert body["to_send"]["groups"][0] == {
        "rank": 0,
        "step": "contact",
        "step_label": "Contact",
        "count": body["to_send"]["groups"][0]["count"],
        "overdue": body["to_send"]["groups"][0]["overdue"],
    }
    assert [group["step"] for group in body["to_send"]["groups"]] == [
        "contact",
        "r1",
        "r2",
        "r3",
        "r4",
    ]
    assert body["levels"][0] == {
        "level": "contact_pending",
        "label": "Contact à envoyer",
        "count": body["levels"][0]["count"],
    }
    assert [item["category"] for item in body["categories"]] == [
        "in_sequence",
        "email_error",
        "finished",
        "disqualified",
        "out_of_campaign",
        "response_received",
        "appointment_obtained",
        "ignored",
    ]
    s2 = next(cohort for cohort in body["cohorts"] if cohort["code"] == "S2")
    assert (s2["starts_on"], s2["prospects"], s2["to_send"]) == ("2020-01-06", 1, 1)
    assert body["weeks"][0] == {
        "week": "2020-W02",
        "year": 2020,
        "number": 2,
        "monday": "2020-01-06",
        "count": 1,
    }

    page = client.get(f"{CONTACT}/prospects", params={"q": "zzz", "rank": 0})
    assert page.status_code == 200, page.text
    assert page.json()["week"] == body["current_week"]
    [row] = page.json()["items"]
    assert (row["last_name"], row["to_send"], row["overdue"], row["next_step"]) == (
        "Zzz",
        True,
        True,
        "contact",
    )
    assert (row["cohort_code"], row["level"], row["level_label"], row["messages"]) == (
        "S2",
        "contact_pending",
        "Contact à envoyer",
        [],
    )
    cohort_id = s2["id"]
    assert client.get(f"{CONTACT}/prospects", params={"cohort": cohort_id}).json()["total"] == 1
    assert (
        client.get(f"{CONTACT}/dashboard", params={"cohort": "none"}).json()["to_send"]["total"]
        == 0
    )
    in_week = client.get(f"{CONTACT}/prospects", params={"week": "2020-W02"}).json()
    assert (in_week["week"], in_week["total"]) == ("2020-W02", 1)
    levels_page = client.get(
        f"{CONTACT}/prospects", params={"category": "in_sequence", "level": "contact_pending"}
    )
    assert levels_page.json()["total"] >= 1


@pytest.mark.parametrize(
    ("params", "field", "reason"),
    [
        ({"week": "2025-W53"}, "week", "iso_week"),  # 2025 has 52 ISO weeks
        ({"week": "2026-41"}, "week", "iso_week"),
        ({"week": "1999-W10"}, "week", "iso_week"),
        ({"rank": "5"}, "rank", "out_of_range"),  # « max relances » is 4
        ({"level": "r4_sent"}, "level", "unknown_level"),  # R4 sent = « Relance terminée »
        ({"level": "r1"}, "level", "unknown_level"),
    ],
)
def test_invalid_criteria_are_refused(
    client: TestClient, params: dict[str, str], field: str, reason: str
) -> None:
    response = client.get(f"{CONTACT}/prospects", params=params)
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert (detail["code"], detail["field"], detail["reason"]) == ("invalid", field, reason)


@pytest.mark.parametrize(
    "params",
    [{"category": "to_handle"}, {"sort": "planned"}, {"rank": "-1"}, {"cohort": "S37"}],
)
def test_malformed_criteria_are_refused(client: TestClient, params: dict[str, str]) -> None:
    assert client.get(f"{CONTACT}/prospects", params=params).status_code == 422


def test_the_planning_needs_a_session(anonymous_client: TestClient) -> None:
    assert anonymous_client.get(f"{CONTACT}/dashboard").status_code == 401
    assert anonymous_client.get(f"{CONTACT}/prospects").status_code == 401
