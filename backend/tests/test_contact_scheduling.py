"""Suivi des envois programmés: the messages by step and day, the due steps without a scheduled mail
(« oubliés ») and what to watch, over the planning of `test_contact_dashboard`, plus HTTP."""

import uuid
from datetime import UTC, date, datetime

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ContactMessage, ContactSequence
from app.models.enums import ContactMessageStatus as M
from app.services.contact_scheduling import overview
from tests.test_contact_dashboard import CLOCK, S37, S39, S40, at, person, weekly

URL = "/api/contact/scheduling"


def prepare(
    session: Session,
    prospect_id: uuid.UUID,
    rank: int,
    status: M,
    scheduled_at: datetime | None = None,
) -> ContactMessage:
    sequence = session.scalars(
        select(ContactSequence).where(
            ContactSequence.prospect_id == prospect_id, ContactSequence.is_current
        )
    ).one()
    moment = datetime(2026, 9, 30, 12, tzinfo=UTC)
    message = ContactMessage(
        prospect_id=prospect_id,
        sequence_id=sequence.id,
        rank=rank,
        status=status,
        scheduled_at=scheduled_at,
        subject="Objet",
        body_text="Corps",
    )
    if status in (M.VALIDATED, M.SCHEDULED):
        message.validated_at, message.validated_by_actor_id = moment, "pilote"
        message.validated_revision = message.revision = 1
    session.add(message)
    session.flush()
    return message


def week_scene(session: Session) -> dict[str, uuid.UUID]:
    people = {
        # R2 overdue (S37, 2 sent), nothing written: forgotten, `none`.
        "overdue": person(session, "Aaa", cohort=S37, sends=weekly(date(2026, 9, 7), 2)),
        # R3 due this week, a draft: forgotten, `draft`.
        "draft": person(session, "Bbb", cohort=S37, sends=weekly(date(2026, 9, 7), 3)),
        # Contact due this week, validated but not scheduled: forgotten, `validated`.
        "validated": person(session, "Ccc", cohort=S39),
        # Contact due this week, scheduled: not forgotten.
        "scheduled": person(session, "Ddd", cohort=S39),
        # R4 not due before next week, scheduled ahead: counted, not due, not forgotten.
        "ahead": person(session, "Eee", cohort=S37, sends=weekly(date(2026, 9, 7), 4)),
        # The next cohort: Contact scheduled for its Monday.
        "next_cohort": person(session, "Fff", cohort=S40),
    }
    prepare(session, people["draft"], 3, M.DRAFT)
    prepare(session, people["validated"], 0, M.VALIDATED)
    prepare(session, people["scheduled"], 0, M.SCHEDULED, at(date(2026, 10, 2), 9))
    prepare(session, people["ahead"], 4, M.SCHEDULED, at(date(2026, 10, 6), 9))
    prepare(session, people["next_cohort"], 0, M.SCHEDULED, at(date(2026, 10, 6), 14))
    return people


def test_counts_by_step_and_state(db_session: Session) -> None:
    week_scene(db_session)

    result = overview(db_session, CLOCK, now=datetime(2026, 10, 1, 9, tzinfo=UTC))

    steps = {step.step: step for step in result.steps}
    assert (steps["contact"].scheduled, steps["contact"].validated) == (2, 1)
    assert (steps["r3"].drafts, steps["r4"].scheduled) == (1, 1)
    assert (result.totals.scheduled, result.totals.validated, result.totals.drafts) == (3, 1, 1)
    # Due this week: two Contact, the overdue R2 and R3 (the R4 and the S40 Contact are next week).
    assert (steps["contact"].due, steps["r2"].due, steps["r3"].due) == (2, 1, 1)
    assert result.totals.due == 4
    assert result.totals.forgotten == 3


def test_forgotten_say_what_is_missing(db_session: Session) -> None:
    people = week_scene(db_session)

    result = overview(db_session, CLOCK, now=datetime(2026, 10, 1, 9, tzinfo=UTC))

    found = {(item.id, item.step, item.state, item.overdue) for item in result.forgotten}
    assert found == {
        (people["overdue"], "r2", "none", True),
        (people["draft"], "r3", "draft", False),
        (people["validated"], "contact", "validated", False),
    }
    # The overdue step comes first (default order: by due date).
    assert result.forgotten[0].id == people["overdue"]
    steps = {step.step: step for step in result.steps}
    assert (steps["r2"].forgotten_none, steps["r3"].forgotten_draft) == (1, 1)
    assert steps["contact"].forgotten_validated == 1


def test_scheduled_by_business_day_with_the_steps(db_session: Session) -> None:
    week_scene(db_session)

    result = overview(db_session, CLOCK, now=datetime(2026, 10, 1, 9, tzinfo=UTC))

    assert [(day.day, day.total, day.by_step, day.past) for day in result.days] == [
        (date(2026, 10, 2), 1, {"contact": 1}, False),
        (date(2026, 10, 6), 2, {"contact": 1, "r4": 1}, False),
    ]


def test_a_scheduled_mail_whose_time_passed_is_watched(db_session: Session) -> None:
    people = week_scene(db_session)
    late = prepare(
        db_session, person(db_session, "Ggg", cohort=S39), 0, M.SCHEDULED, at(date(2026, 9, 30))
    )
    late.last_error_code, late.last_error_at = (
        "send_draft_not_created",
        datetime(2026, 9, 30, 12, tzinfo=UTC),
    )
    db_session.flush()

    result = overview(db_session, CLOCK, now=datetime(2026, 10, 1, 9, tzinfo=UTC))

    assert result.totals.scheduled_past == 1
    assert result.totals.scheduled_with_error == 1
    assert result.totals.scheduled_with_draft_error == 0
    assert result.days[0].past is True
    assert people["scheduled"]


def test_messages_list_whose_each_prepared_mail_is(db_session: Session) -> None:
    people = week_scene(db_session)

    result = overview(db_session, CLOCK, now=datetime(2026, 10, 1, 9, tzinfo=UTC))

    found = {(item.prospect_id, item.step, item.status) for item in result.messages}
    assert (people["draft"], "r3", "draft") in found
    assert (people["validated"], "contact", "validated") in found
    assert (people["scheduled"], "contact", "scheduled") in found
    assert len(result.messages) == 5
    # Scheduled first, by moment; the ones without a moment after.
    assert [item.status for item in result.messages][:3] == ["scheduled"] * 3
    first = result.messages[0]
    assert first.cohort_code and first.company_name is not None


def test_http_contract(client: TestClient, db_session: Session) -> None:
    week_scene(db_session)

    answer = client.get(URL)

    assert answer.status_code == 200
    body = answer.json()
    assert body["totals"]["scheduled"] >= 3
    assert {"contact", "r1", "r4"} <= {step["step"] for step in body["steps"]}
    assert all(item["state"] in ("none", "draft", "validated") for item in body["forgotten"])
    assert client.get(URL, params={"week": "pas-une-semaine"}).status_code == 422
    assert client.get(URL, params={"week": "2026-W41"}).status_code == 200
