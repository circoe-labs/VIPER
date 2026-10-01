"""Contact dashboard (Contact port Slice S3; handoff Task 09, decisions 16-18; adapted to the
sequences rework D1-D9 — the full weekly planning by level is Slice S3 of the rework): the Contact
page's counters, week options and people list, read-only (no filter or counter ever changes a
state, a cohort or a sequence).

Scope: prospects in a cohort (a current sequence) or with a contact tracking, whose state is
neither `ignored` (terminal) nor `disqualified` (« Défaillant », out of the pipeline), and without
the durable opposition `do_not_contact` (nobody to write to) — except `appointment_obtained`,
which stays counted and listed whatever the opposition (« RDV pris » is a cumulative fact).

The next due date is derived (`contact_sequences.next_due_at_sql`): the cohort's date for the
Contact, then the Monday of the calendar week after the last real send; nothing is due when the
sequence is finished (« Relance terminée »), the cohort is S0, the state is not `neutral` or an
« Erreur sur le mail » is open. Counters — each equals the total of the list opened with the same
`counter` key (same SQL):

- `first_contact`: nothing sent yet in the sequence, Contact due this week or overdue;
- `follow_up`: at least one send, the next follow-up (R1, R2…) due this week or overdue;
- `to_handle`: « À traiter cette semaine » = the exact, disjoint union of the two above;
- `appointments`: « RDV pris », cumulative = current state `appointment_obtained`, no time window,
  opposed or not.

The « due » counters also exclude prospects known to have left their role (`inactive`), exactly
as Prospection's `actionable()`. "This week or overdue" compares the next due date with the start
of next week's Monday. An overdue step stays « à traiter » until a person records the send.

List criteria (AND): `counter`, `week` (exact ISO calendar week of the next due date, business
time), `state` (any state but `ignored`/`disqualified`), `q` (the Prospection search). Without
`counter`, `week` or `state`, the list is the planning: prospects with a next due date only.
Order: next due date (soonest first, none last), then last name, first name, id.
"""

import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from enum import StrEnum
from typing import Any

from sqlalchemy import ColumnElement, Select, and_, false, func, or_, select
from sqlalchemy.orm import Session

from app.core.business_time import BUSINESS_TIMEZONE, business_day, start_of_day
from app.db.session import whole_base_plan
from app.models import Cohort, ContactMessage, ContactSequence, ContactTracking, Prospect, Role
from app.models.companies import Company
from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    ContactMessageStatus,
    ContactMessageStep,
    ContactTrackingStatus,
)
from app.repositories.taxonomies import label_key
from app.services.contact_sequences import (
    finished_sql,
    has_cohort_sql,
    next_due_at_sql,
    next_rank_sql,
    sent_count_sql,
)
from app.services.contact_workflow import IsoWeek, step_code
from app.services.prospection.query import LIST_MAX_LIMIT, iso_week, search_condition
from app.services.prospection.segments import actionable, join_segment_sources, primary_email

S = ContactTrackingStatus
# Outside Contact: terminal or eliminated.
OUT_OF_SCOPE_STATES = (S.IGNORED, S.DISQUALIFIED)


class ContactCounter(StrEnum):
    """The dashboard's cards; the value is the list's `counter` key."""

    TO_HANDLE = "to_handle"
    FIRST_CONTACT = "first_contact"
    FOLLOW_UP = "follow_up"
    APPOINTMENTS = "appointments"


# States a Contact list may be filtered on.
FILTERABLE_STATES = tuple(state for state in S if state not in OUT_OF_SCOPE_STATES)


@dataclass(frozen=True, slots=True)
class ContactClock:
    """« This week »: the ISO calendar week of the business day."""

    today: date

    @classmethod
    def at(cls, moment: datetime) -> ContactClock:
        return cls(today=business_day(moment))

    @property
    def current_week(self) -> IsoWeek:
        return IsoWeek.of(self.today)

    @property
    def due_before(self) -> datetime:
        """Start of next week's Monday: a due date before it is this week or overdue."""
        return start_of_day(self.current_week.monday + timedelta(weeks=1))


@dataclass(frozen=True, slots=True)
class ContactFilters:
    counter: ContactCounter | None = None
    week: IsoWeek | None = None
    state: ContactTrackingStatus | None = None
    search: str | None = None


@dataclass(frozen=True, slots=True)
class WeekOption:
    week: str
    year: int
    number: int
    count: int


@dataclass(frozen=True, slots=True)
class ContactDashboard:
    today: date
    current_week: str
    counts: dict[ContactCounter, int]
    # Weeks of the next due dates (in scope, under `q`), oldest first, for the week selector.
    weeks: list[WeekOption]


@dataclass(frozen=True, slots=True)
class ContactRow:
    id: uuid.UUID
    civility: Civility | None
    first_name: str | None
    last_name: str | None
    exact_job_title: str | None
    role_label: str | None
    company_id: uuid.UUID | None
    company_name: str | None
    primary_email: str | None
    activity_status: ActivityStatus
    tracking_status: ContactTrackingStatus
    cohort_code: str | None
    sent_count: int
    finished: bool
    next_due_at: datetime | None
    next_action_week: str | None
    # In `to_handle`: due this week or overdue, and actionable.
    due: bool
    # The step to send next (`contact`, `r1`…), None when finished or without cohort.
    next_step: str | None
    # Status of each named step's message in the current sequence; None = never created.
    messages: dict[ContactMessageStep, ContactMessageStatus | None]


@dataclass(frozen=True, slots=True)
class ContactPage:
    items: list[ContactRow]
    total: int
    limit: int
    offset: int


# --- conditions --------------------------------------------------------------------------------


def in_scope() -> ColumnElement[bool]:
    return and_(
        or_(has_cohort_sql(), ContactTracking.id.is_not(None)),
        or_(ContactTracking.id.is_(None), ContactTracking.status.not_in(OUT_OF_SCOPE_STATES)),
        or_(
            Prospect.contactability_status == ContactabilityStatus.CONTACTABLE,
            # An appointment obtained stays a fact after a later opposition (« RDV pris »).
            ContactTracking.status == S.APPOINTMENT_OBTAINED,
        ),
    )


def _due(clock: ContactClock) -> ColumnElement[bool]:
    return and_(actionable(), next_due_at_sql() < clock.due_before)


def counter_condition(counter: ContactCounter, clock: ContactClock) -> ColumnElement[bool]:
    match counter:
        case ContactCounter.APPOINTMENTS:
            return ContactTracking.status == S.APPOINTMENT_OBTAINED
        case ContactCounter.FIRST_CONTACT:
            return and_(_due(clock), sent_count_sql() == 0)
        case ContactCounter.FOLLOW_UP:
            return and_(_due(clock), sent_count_sql() > 0)
        case ContactCounter.TO_HANDLE:
            return _due(clock)


def week_condition(week: IsoWeek) -> ColumnElement[bool]:
    start = start_of_day(week.monday)
    due = next_due_at_sql()
    return and_(due >= start, due < start_of_day(week.monday + timedelta(weeks=1)))


def _search(filters: ContactFilters) -> list[ColumnElement[bool]]:
    search = (filters.search or "").strip()
    return [search_condition(search)] if search else []


def list_conditions(filters: ContactFilters, clock: ContactClock) -> list[ColumnElement[bool]]:
    conditions = [in_scope(), *_search(filters)]
    if filters.counter is not None:
        conditions.append(counter_condition(filters.counter, clock))
    if filters.week is not None:
        conditions.append(week_condition(filters.week))
    if filters.state is not None:
        if filters.state is S.NEUTRAL:
            no_state = or_(ContactTracking.id.is_(None), ContactTracking.status == S.NEUTRAL)
            conditions.append(no_state)
        else:
            conditions.append(ContactTracking.status == filters.state)
    if filters.counter is None and filters.week is None and filters.state is None:
        conditions.append(next_due_at_sql().is_not(None))
    return conditions


def _week_label() -> ColumnElement[str]:
    local = func.timezone(str(BUSINESS_TIMEZONE), next_due_at_sql())
    return func.to_char(local, 'IYYY-"W"IW')


# --- service -----------------------------------------------------------------------------------


def dashboard(session: Session, clock: ContactClock, search: str | None = None) -> ContactDashboard:
    """Every card's count (one aggregate query) and the week options, under the search `q`."""
    filters = ContactFilters(search=search)
    where = [in_scope(), *_search(filters)]
    counts = [
        func.count().filter(counter_condition(counter, clock)).label(counter.value)
        for counter in ContactCounter
    ]
    week = _week_label().label("week")
    weeks_query = (
        join_segment_sources(select(week, func.count()))
        .where(*where, next_due_at_sql().is_not(None))
        .group_by(week)
        .order_by(week)
    )
    with whole_base_plan(session):
        row = session.execute(join_segment_sources(select(*counts)).where(*where)).one()._mapping
        week_rows = session.execute(weeks_query).tuples().all()
    options = []
    for label, count in week_rows:
        year, number = label.split("-W")
        options.append(WeekOption(week=label, year=int(year), number=int(number), count=count))
    return ContactDashboard(
        today=clock.today,
        current_week=clock.current_week.label,
        counts={counter: row[counter.value] for counter in ContactCounter},
        weeks=options,
    )


def _page_statement(clock: ContactClock) -> Select[Any]:
    due = func.coalesce(_due(clock), false())
    return join_segment_sources(
        select(
            Prospect,
            Role.label,
            Company.display_name,
            primary_email.address,
            ContactTracking.status,
            Cohort.code,
            sent_count_sql(),
            func.coalesce(finished_sql(), false()),
            next_rank_sql(),
            next_due_at_sql(),
            due,
            ContactSequence.id,
        )
    ).outerjoin(Role, Role.id == Prospect.role_id)


def _message_statuses(
    session: Session, sequence_ids: list[uuid.UUID]
) -> dict[uuid.UUID, dict[ContactMessageStep, ContactMessageStatus]]:
    """Per current sequence: the status of its Contact, R1 and R2 messages."""
    statuses: dict[uuid.UUID, dict[ContactMessageStep, ContactMessageStatus]] = {}
    if not sequence_ids:
        return statuses
    rows = session.scalars(
        select(ContactMessage).where(
            ContactMessage.sequence_id.in_(sequence_ids),
            ContactMessage.rank < len(ContactMessageStep),
        )
    )
    for message in rows:
        step = message.step
        if step is not None:
            statuses.setdefault(message.sequence_id, {})[step] = message.status
    return statuses


def list_contacts(
    session: Session,
    filters: ContactFilters,
    clock: ContactClock,
    *,
    limit: int = 50,
    offset: int = 0,
) -> ContactPage:
    """One page of the Contact list and its total (three queries whatever the page size)."""
    limit = max(1, min(limit, LIST_MAX_LIMIT))
    offset = max(0, offset)
    where = list_conditions(filters, clock)
    order: list[Any] = [
        next_due_at_sql().asc().nulls_last(),
        label_key(Prospect.last_name).nulls_last(),
        label_key(Prospect.first_name).nulls_last(),
        Prospect.id,
    ]
    page = _page_statement(clock).where(*where).order_by(*order).limit(limit).offset(offset)
    count = join_segment_sources(select(func.count())).where(*where)
    with whole_base_plan(session):
        rows = session.execute(page).tuples().all()
        total = session.execute(count).scalar_one()
    messages = _message_statuses(session, [row[-1] for row in rows if row[-1] is not None])
    items = []
    for (
        prospect,
        role_label,
        company_name,
        email,
        state,
        cohort_code,
        sent_count,
        finished,
        next_rank,
        next_due,
        due,
        sequence_id,
    ) in rows:
        steps = messages.get(sequence_id, {}) if sequence_id else {}
        items.append(
            ContactRow(
                id=prospect.id,
                civility=prospect.civility,
                first_name=prospect.first_name,
                last_name=prospect.last_name,
                exact_job_title=prospect.exact_job_title,
                role_label=role_label,
                company_id=prospect.company_id,
                company_name=company_name,
                primary_email=email,
                activity_status=prospect.activity_status,
                tracking_status=state or S.NEUTRAL,
                cohort_code=cohort_code,
                sent_count=sent_count,
                finished=bool(finished),
                next_due_at=next_due,
                next_action_week=iso_week(next_due),
                due=bool(due),
                next_step=step_code(next_rank) if next_rank is not None else None,
                messages={step: steps.get(step) for step in ContactMessageStep},
            )
        )
    return ContactPage(items=items, total=total, limit=limit, offset=offset)
