"""Contact dashboard (Contact port Slice S3; handoff Task 09, decisions 16-18): the Contact page's
counters, week options and people list, read-only (no filter or counter ever changes a state).

Scope: prospects with a contact tracking whose state is not `ignored` (terminal, outside
Contact — the reference's rule) and without the durable opposition `do_not_contact` (nobody to
write to; `ignored` implies it anyway) — except `appointment_obtained`, which stays counted and
listed whatever the opposition (« RDV pris » is a cumulative fact). `failure` stays in scope: it
is filterable, has no next action by default and is never due.

Counters — each equals the total of the list opened with the same `counter` key (same SQL):

- `first_contact`: `neutral` with a next-action week reached or overdue (week ≤ current ISO week);
- `follow_up`: `contacted` (R1 to prepare) or `r1` (R2 to prepare), week reached or overdue;
- `review`: `r2`, week reached or overdue — a human review/closing, not another mail (decision 13);
- `to_handle`: « À traiter cette semaine » = the exact, disjoint union of the three above;
- `appointments`: « RDV pris », cumulative = current state `appointment_obtained`, no time window
  (a corrected choice stops counting), opposed or not.

The four « due » counters also exclude prospects known to have left their role (`inactive`),
exactly as Prospection's `actionable()`. "Reached or overdue" compares the stored next action
(P1: Monday of the week, business midnight) with the start of next week's Monday, so any moment
inside the current ISO week counts, whatever was stored. Nothing becomes due or overdue by itself
in the state: an overdue week stays « à traiter » until a person acts (decision 10).

List criteria (AND): `counter`, `week` (exact ISO week of the next action, business time), `state`
(any state but `ignored`), `q` (the Prospection search: names, company, e-mail, phone). Without
`counter`, `week` or `state`, the list is the planning: prospects with a next-action week only
(a prospect without one appears only under an explicit state filter). Order: next action
(soonest first, none last), then last name, first name, id. Pagination like Prospection.
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
from app.models import ContactMessage, ContactTracking, Prospect, Role
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
from app.services.contact_workflow import IsoWeek
from app.services.prospection.query import LIST_MAX_LIMIT, iso_week, search_condition
from app.services.prospection.segments import actionable, join_segment_sources, primary_email

S = ContactTrackingStatus


class ContactCounter(StrEnum):
    """The dashboard's cards; the value is the list's `counter` key."""

    TO_HANDLE = "to_handle"
    FIRST_CONTACT = "first_contact"
    FOLLOW_UP = "follow_up"
    REVIEW = "review"
    APPOINTMENTS = "appointments"


class NextStep(StrEnum):
    """What the next action of a state prepares: the mail of a step, or the R2 review."""

    CONTACT = "contact"
    R1 = "r1"
    R2 = "r2"
    REVIEW = "review"


NEXT_STEPS: dict[ContactTrackingStatus, NextStep] = {
    S.NEUTRAL: NextStep.CONTACT,
    S.CONTACTED: NextStep.R1,
    S.R1: NextStep.R2,
    S.R2: NextStep.REVIEW,
}
DUE_STATES: dict[ContactCounter, tuple[ContactTrackingStatus, ...]] = {
    ContactCounter.TO_HANDLE: (S.NEUTRAL, S.CONTACTED, S.R1, S.R2),
    ContactCounter.FIRST_CONTACT: (S.NEUTRAL,),
    ContactCounter.FOLLOW_UP: (S.CONTACTED, S.R1),
    ContactCounter.REVIEW: (S.R2,),
}
# States a Contact list may be filtered on: all but `ignored` (outside Contact).
FILTERABLE_STATES = tuple(state for state in S if state is not S.IGNORED)


@dataclass(frozen=True, slots=True)
class ContactClock:
    """« This week »: the ISO week of the business day."""

    today: date

    @classmethod
    def at(cls, moment: datetime) -> ContactClock:
        return cls(today=business_day(moment))

    @property
    def current_week(self) -> IsoWeek:
        return IsoWeek.of(self.today)

    @property
    def due_before(self) -> datetime:
        """Start of next week's Monday: a next action before it is reached or overdue."""
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
    # Weeks present in the planning (in scope, under `q`), oldest first, for the week selector.
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
    planned_contact_at: datetime | None
    next_action_week: str | None
    # In `to_handle`: next action reached or overdue, and actionable.
    due: bool
    next_step: NextStep | None
    # Status of each step's message; None = never created.
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
        ContactTracking.id.is_not(None),
        ContactTracking.status != S.IGNORED,
        or_(
            Prospect.contactability_status == ContactabilityStatus.CONTACTABLE,
            # An appointment obtained stays a fact after a later opposition (« RDV pris »).
            ContactTracking.status == S.APPOINTMENT_OBTAINED,
        ),
    )


def _due(states: tuple[ContactTrackingStatus, ...], clock: ContactClock) -> ColumnElement[bool]:
    return and_(
        actionable(),
        ContactTracking.status.in_(states),
        ContactTracking.planned_contact_at < clock.due_before,
    )


def counter_condition(counter: ContactCounter, clock: ContactClock) -> ColumnElement[bool]:
    if counter is ContactCounter.APPOINTMENTS:
        return ContactTracking.status == S.APPOINTMENT_OBTAINED
    return _due(DUE_STATES[counter], clock)


def week_condition(week: IsoWeek) -> ColumnElement[bool]:
    start = start_of_day(week.monday)
    return and_(
        ContactTracking.planned_contact_at >= start,
        ContactTracking.planned_contact_at < start_of_day(week.monday + timedelta(weeks=1)),
    )


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
        conditions.append(ContactTracking.status == filters.state)
    if filters.counter is None and filters.week is None and filters.state is None:
        conditions.append(ContactTracking.planned_contact_at.is_not(None))
    return conditions


def _week_label() -> ColumnElement[str]:
    local = func.timezone(str(BUSINESS_TIMEZONE), ContactTracking.planned_contact_at)
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
    week = _week_label()
    weeks_query = (
        join_segment_sources(select(week, func.count()))
        .where(*where, ContactTracking.planned_contact_at.is_not(None))
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
    due = func.coalesce(_due(DUE_STATES[ContactCounter.TO_HANDLE], clock), false())
    return join_segment_sources(
        select(
            Prospect,
            Role.label,
            Company.display_name,
            primary_email.address,
            ContactTracking.status,
            ContactTracking.planned_contact_at,
            due,
        )
    ).outerjoin(Role, Role.id == Prospect.role_id)


def _message_statuses(
    session: Session, prospect_ids: list[uuid.UUID]
) -> dict[uuid.UUID, dict[ContactMessageStep, ContactMessageStatus]]:
    statuses: dict[uuid.UUID, dict[ContactMessageStep, ContactMessageStatus]] = {}
    if not prospect_ids:
        return statuses
    rows = session.execute(
        select(ContactMessage.prospect_id, ContactMessage.step, ContactMessage.status).where(
            ContactMessage.prospect_id.in_(prospect_ids)
        )
    ).tuples()
    for prospect_id, step, status in rows:
        statuses.setdefault(prospect_id, {})[step] = status
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
        ContactTracking.planned_contact_at.asc().nulls_last(),
        label_key(Prospect.last_name).nulls_last(),
        label_key(Prospect.first_name).nulls_last(),
        Prospect.id,
    ]
    page = _page_statement(clock).where(*where).order_by(*order).limit(limit).offset(offset)
    count = join_segment_sources(select(func.count())).where(*where)
    with whole_base_plan(session):
        rows = session.execute(page).tuples().all()
        total = session.execute(count).scalar_one()
    messages = _message_statuses(session, [row[0].id for row in rows])
    items = [
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
            tracking_status=state,
            planned_contact_at=planned,
            next_action_week=iso_week(planned),
            due=bool(due),
            next_step=NEXT_STEPS.get(state),
            messages={step: messages.get(prospect.id, {}).get(step) for step in ContactMessageStep},
        )
        for prospect, role_label, company_name, email, state, planned, due in rows
    ]
    return ContactPage(items=items, total=total, limit=limit, offset=offset)
