"""Contact weekly planning (sequences rework S3, handoff §11; D1, D2, D7, D9): what to send this
week, where every sequence stands and the categories out of the automatic actions — read-only (no
count, list or filter ever changes a state, a cohort, a sequence or a message).

**Week.** A planning week is an ISO calendar week, Monday 00:00 to Sunday 24:00 business time
(Europe/Paris, DST-aware), « cette semaine » being the week of the business day. A cohort code
`Sxx` is never a week (D5): the week only places the derived next due dates.

**À envoyer.** A prospect has something to send when its next due date
(`contact_sequences.next_due_at_sql`: the cohort's date for the Contact, then the Monday after the
last real send) falls in the week — **for the current week, every earlier due date too** (an
overdue step stays to send until a person records it, flagged `overdue`: due before this week's
Monday). A future week shows only what falls in it; a past week what fell in it and is still
unsent. The predicate is `segments.to_send_before` (actionable: no opposition, not `inactive`), so
nothing is ever to send without a cohort, in S0, under a state other than `neutral` (response,
RDV, ignored, Défaillant), after « Relance terminée », under the opposition or while an
« Erreur sur le mail » raised by a person or an import is open. Groups: one per rank from the
Contact (« nouveaux contacts ») to R<max> (« max relances »), by the rank to send next. Levels move
only with real sends: a week without prospecting (no S38) changes nothing, the next step simply
stays due (overdue).

**Levels** (`contact_steps.level_key`, SQL `contact_sequences.level_key_sql`): over the sequences
**in progress** — a current sequence in a campaign cohort (not S0), state `neutral`, no
opposition (`in_sequence`) — Contact à envoyer, Contact envoyé, R1 … R<max-1> envoyée, Relance
terminée (R<max> sent, or the sequence closed `completed`).

**Categories** (counts and lists; a prospect may be in several):

- `in_sequence` — the sequences in progress above;
- `email_error` — an open « Erreur sur le mail » raised by a person or an import (the AI's is a
  proposal and pauses nothing); the cohort, state and history are kept;
- `finished` — « Relance terminée »: in sequence and finished (still contactable);
- `disqualified` — « Défaillant »;
- `out_of_campaign` — current cohort S0 (validated, out of campaign);
- `response_received`, `appointment_obtained` — the state;
- `ignored` — the state `ignored` or the do-not-contact opposition.

**Cohorts**: per cohort holding current prospects (under the filters): its prospects, its
sequences in progress by level (so a person sees « S37 at R4 »), what it has to send in the week.

Scope of the page: prospects with a current sequence, a contact tracking or an open effective
« Erreur sur le mail ». Filters (AND): `cohort` (a cohort id or `none`), `q` (the Prospection
search), and for the lists `category` (default `to_send`), `rank`, `level`, `week`. Every count of
the dashboard equals the total of the list opened with the same criteria (same SQL).
"""

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from enum import StrEnum
from typing import Any, Literal

from sqlalchemy import ColumnElement, Select, and_, case, false, func, null, or_, select
from sqlalchemy.orm import Session

from app.core.business_time import BUSINESS_TIMEZONE, business_day, start_of_day
from app.core.cohort_codes import OUT_OF_CAMPAIGN_CODE
from app.core.contact_steps import level_keys, level_label, step_code, step_label
from app.db.session import whole_base_plan
from app.models import Cohort, ContactMessage, ContactSequence, ContactTracking, Prospect, Role
from app.models.companies import Company
from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    ContactMessageStatus,
    ContactTrackingStatus,
)
from app.repositories.taxonomies import label_key
from app.services import app_settings
from app.services.contact_sequences import (
    email_error_sql,
    finished_sql,
    has_cohort_sql,
    last_sent_at_sql,
    level_key_sql,
    next_due_at_sql,
    next_rank_sql,
    sent_count_sql,
)
from app.services.contact_workflow import IsoWeek
from app.services.prospection.query import LIST_MAX_LIMIT, iso_week, search_condition
from app.services.prospection.segments import (
    actionable,
    join_segment_sources,
    primary_email,
    to_send_before,
)

S = ContactTrackingStatus
NONE: Literal["none"] = "none"


class ContactCategory(StrEnum):
    """The lists of the planning; the value is the API key (`?category=`)."""

    TO_SEND = "to_send"
    IN_SEQUENCE = "in_sequence"
    EMAIL_ERROR = "email_error"
    FINISHED = "finished"
    DISQUALIFIED = "disqualified"
    OUT_OF_CAMPAIGN = "out_of_campaign"
    RESPONSE_RECEIVED = "response_received"
    APPOINTMENT_OBTAINED = "appointment_obtained"
    IGNORED = "ignored"


CATEGORY_LABELS: dict[ContactCategory, str] = {
    ContactCategory.TO_SEND: "À envoyer",
    ContactCategory.IN_SEQUENCE: "En séquence",
    ContactCategory.EMAIL_ERROR: "Erreur sur le mail",
    ContactCategory.FINISHED: "Relance terminée",
    ContactCategory.DISQUALIFIED: "Défaillant",
    ContactCategory.OUT_OF_CAMPAIGN: "S0 (validé hors campagne)",
    ContactCategory.RESPONSE_RECEIVED: "Réponse reçue",
    ContactCategory.APPOINTMENT_OBTAINED: "RDV obtenu",
    ContactCategory.IGNORED: "Ignoré",
}
# The categories counted beside the planning (`to_send` is counted per rank).
COUNTED_CATEGORIES = tuple(
    category for category in ContactCategory if category is not ContactCategory.TO_SEND
)


class ContactSort(StrEnum):
    DUE = "due"  # next due date (soonest first, none last), then the person
    NAME = "name"  # last name, first name
    COHORT = "cohort"  # cohort date (oldest first, S0 and none last), then the person


# --- the week -----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PlanningWeek:
    """The planning of `week` seen from the `current` week."""

    week: IsoWeek
    current: IsoWeek

    @property
    def is_current(self) -> bool:
        return self.week == self.current

    @property
    def monday(self) -> date:
        return self.week.monday

    @property
    def sunday(self) -> date:
        return self.week.monday + timedelta(days=6)

    @property
    def start(self) -> datetime:
        return start_of_day(self.week.monday)

    @property
    def end(self) -> datetime:
        """Start of the next week's Monday (exclusive)."""
        return start_of_day(self.week.monday + timedelta(weeks=1))

    @property
    def overdue_before(self) -> datetime:
        """A due date before the current week's Monday is overdue."""
        return start_of_day(self.current.monday)


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

    def window(self, week: IsoWeek | None = None) -> PlanningWeek:
        return PlanningWeek(week=week or self.current_week, current=self.current_week)


# --- inputs and results -------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ContactFilters:
    category: ContactCategory = ContactCategory.TO_SEND
    # The planning week (default: the current one); used by `to_send` and the row flags.
    week: IsoWeek | None = None
    # The rank to send next (0 = Contact, n = Rn).
    rank: int | None = None
    # A level key (`contact_pending`, `contact_sent`, `r2_sent`, `finished`).
    level: str | None = None
    # The current cohort, or `none` (no cohort).
    cohort: uuid.UUID | Literal["none"] | None = None
    search: str | None = None
    sort: ContactSort = ContactSort.DUE


@dataclass(frozen=True, slots=True)
class WeekInfo:
    week: str
    monday: date
    sunday: date
    is_current: bool


@dataclass(frozen=True, slots=True)
class RankGroup:
    rank: int
    step: str
    step_label: str
    count: int
    overdue: int


@dataclass(frozen=True, slots=True)
class ToSend:
    total: int
    overdue: int
    groups: list[RankGroup]


@dataclass(frozen=True, slots=True)
class LevelCount:
    level: str
    label: str
    count: int


@dataclass(frozen=True, slots=True)
class CategoryCount:
    category: ContactCategory
    label: str
    count: int


@dataclass(frozen=True, slots=True)
class CohortSummary:
    id: uuid.UUID
    code: str
    starts_on: date | None
    out_of_campaign: bool
    needs_review: bool
    # Prospects whose current cohort it is (under the filters), in progress among them, to send in
    # the week (overdue included for the current week) and overdue.
    prospects: int
    in_sequence: int
    to_send: int
    overdue: int
    levels: list[LevelCount]


@dataclass(frozen=True, slots=True)
class WeekOption:
    week: str
    year: int
    number: int
    monday: date
    count: int


@dataclass(frozen=True, slots=True)
class ContactDashboard:
    today: date
    current_week: str
    week: WeekInfo
    max_follow_ups: int
    to_send: ToSend
    levels: list[LevelCount]
    categories: list[CategoryCount]
    cohorts: list[CohortSummary]
    # Weeks holding next due dates (overdue ones included, under the filters), oldest first.
    weeks: list[WeekOption]


@dataclass(frozen=True, slots=True)
class MessageState:
    rank: int
    step: str
    status: ContactMessageStatus


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
    contactability_status: ContactabilityStatus
    tracking_status: ContactTrackingStatus
    cohort_id: uuid.UUID | None
    cohort_code: str | None
    cohort_starts_on: date | None
    out_of_campaign: bool
    sent_count: int
    last_sent_at: datetime | None
    # The level key and its label; None without a cohort.
    level: str | None
    level_label: str | None
    finished: bool
    # The rank to send next, its code and label (None when finished or without a cohort).
    next_rank: int | None
    next_step: str | None
    next_step_label: str | None
    next_due_at: datetime | None
    next_due_week: str | None
    # To send in the requested week (overdue included for the current week); overdue: due before
    # the current week.
    to_send: bool
    overdue: bool
    email_error: bool
    # The status of the message at the next rank (None: nothing prepared) and every message of
    # the current sequence by rank.
    next_message_status: ContactMessageStatus | None
    messages: list[MessageState] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class ContactPage:
    items: list[ContactRow]
    total: int
    limit: int
    offset: int
    # The planning week the `to_send` flags and the `to_send` category refer to.
    week: str


# --- conditions ---------------------------------------------------------------------------------


def _neutral() -> ColumnElement[bool]:
    return or_(ContactTracking.status.is_(None), ContactTracking.status == S.NEUTRAL)


def in_scope() -> ColumnElement[bool]:
    """A current sequence, a contact tracking or an open effective « Erreur sur le mail »."""
    return or_(has_cohort_sql(), ContactTracking.id.is_not(None), email_error_sql())


def in_sequence() -> ColumnElement[bool]:
    """A sequence in progress: a current sequence in a campaign cohort, state `neutral`, no
    opposition (« Relance terminée » and a paused « Erreur sur le mail » included)."""
    return and_(
        has_cohort_sql(),
        Cohort.code != OUT_OF_CAMPAIGN_CODE,
        _neutral(),
        Prospect.contactability_status == ContactabilityStatus.CONTACTABLE,
    )


def to_send(window: PlanningWeek) -> ColumnElement[bool]:
    condition = to_send_before(window.end)
    if window.is_current:
        return condition
    return and_(condition, next_due_at_sql() >= window.start)


def overdue(window: PlanningWeek) -> ColumnElement[bool]:
    return next_due_at_sql() < window.overdue_before


def category_condition(category: ContactCategory, window: PlanningWeek) -> ColumnElement[bool]:
    match category:
        case ContactCategory.TO_SEND:
            return to_send(window)
        case ContactCategory.IN_SEQUENCE:
            return in_sequence()
        case ContactCategory.EMAIL_ERROR:
            return email_error_sql()
        case ContactCategory.FINISHED:
            return and_(in_sequence(), finished_sql())
        case ContactCategory.DISQUALIFIED:
            return ContactTracking.status == S.DISQUALIFIED
        case ContactCategory.OUT_OF_CAMPAIGN:
            return and_(has_cohort_sql(), Cohort.code == OUT_OF_CAMPAIGN_CODE)
        case ContactCategory.RESPONSE_RECEIVED:
            return ContactTracking.status == S.RESPONSE_RECEIVED
        case ContactCategory.APPOINTMENT_OBTAINED:
            return ContactTracking.status == S.APPOINTMENT_OBTAINED
        case ContactCategory.IGNORED:
            return or_(
                ContactTracking.status == S.IGNORED,
                Prospect.contactability_status == ContactabilityStatus.DO_NOT_CONTACT,
            )


def _cohort_condition(cohort: uuid.UUID | str | None) -> list[ColumnElement[bool]]:
    if cohort is None:
        return []
    if cohort == NONE:
        return [~has_cohort_sql()]
    return [Cohort.id == cohort]


def scope_conditions(filters: ContactFilters) -> list[ColumnElement[bool]]:
    """The page's scope under `cohort` and `q` (dashboard and lists)."""
    conditions = [in_scope(), *_cohort_condition(filters.cohort)]
    search = (filters.search or "").strip()
    if search:
        conditions.append(search_condition(search))
    return conditions


def list_conditions(filters: ContactFilters, window: PlanningWeek) -> list[ColumnElement[bool]]:
    conditions = [*scope_conditions(filters), category_condition(filters.category, window)]
    if filters.rank is not None:
        conditions.append(next_rank_sql() == filters.rank)
    if filters.level is not None:
        conditions.append(level_key_sql() == filters.level)
    return conditions


def _due_week() -> ColumnElement[str | None]:
    """The ISO week (`2026-W41`) of an actionable next due date; NULL when nothing is due."""
    local = func.timezone(str(BUSINESS_TIMEZONE), next_due_at_sql())
    return case(
        (and_(actionable(), next_due_at_sql().is_not(None)), func.to_char(local, 'IYYY-"W"IW')),
        else_=null(),
    )


# --- dashboard ----------------------------------------------------------------------------------


def _derived(filters: ContactFilters, window: PlanningWeek) -> Any:
    """One row per prospect in scope with every derived fact the dashboard counts (computed once,
    then aggregated)."""
    sending = to_send(window)
    statement = join_segment_sources(
        select(
            Cohort.id.label("cohort_id"),
            func.coalesce(sending, false()).label("to_send"),
            func.coalesce(and_(sending, overdue(window)), false()).label("overdue"),
            next_rank_sql().label("next_rank"),
            level_key_sql().label("level"),
            func.coalesce(in_sequence(), false()).label("in_sequence"),
            _due_week().label("due_week"),
            *(
                func.coalesce(category_condition(category, window), false()).label(
                    f"category_{category.value}"
                )
                for category in COUNTED_CATEGORIES
            ),
        )
    ).where(*scope_conditions(filters))
    return statement.subquery("planning")


def dashboard(
    session: Session, clock: ContactClock, filters: ContactFilters | None = None
) -> ContactDashboard:
    """The week's planning, the levels, the categories, the cohorts and the week options under
    `week`, `cohort` and `q` (the list criteria `category`, `rank`, `level` do not apply). Four
    statements (plus the « max relances » read) whatever the base size."""
    filters = filters or ContactFilters()
    window = clock.window(filters.week)
    limit = app_settings.max_follow_ups(session)
    keys = level_keys(limit)
    rows = _derived(filters, window)
    ranks = range(limit + 1)
    totals = select(
        func.count().filter(rows.c.to_send).label("to_send"),
        func.count().filter(rows.c.overdue).label("overdue"),
        *(
            func.count().filter(rows.c.to_send, rows.c.next_rank == rank).label(f"rank_{rank}")
            for rank in ranks
        ),
        *(
            func.count().filter(rows.c.overdue, rows.c.next_rank == rank).label(f"late_{rank}")
            for rank in ranks
        ),
        *(
            func.count().filter(rows.c.in_sequence, rows.c.level == key).label(f"level_{key}")
            for key in keys
        ),
        *(
            func.count().filter(rows.c[f"category_{c.value}"]).label(c.value)
            for c in COUNTED_CATEGORIES
        ),
    ).select_from(rows)
    per_cohort = (
        select(
            rows.c.cohort_id,
            rows.c.level,
            func.count(),
            func.count().filter(rows.c.in_sequence),
            func.count().filter(rows.c.to_send),
            func.count().filter(rows.c.overdue),
        )
        .where(rows.c.cohort_id.is_not(None))
        .group_by(rows.c.cohort_id, rows.c.level)
    )
    weeks = (
        select(rows.c.due_week, func.count())
        .where(rows.c.due_week.is_not(None))
        .group_by(rows.c.due_week)
        .order_by(rows.c.due_week)
    )
    with whole_base_plan(session):
        total = session.execute(totals).one()._mapping
        cohort_rows = session.execute(per_cohort).tuples().all()
        week_rows = session.execute(weeks).tuples().all()
    return ContactDashboard(
        today=clock.today,
        current_week=clock.current_week.label,
        week=WeekInfo(
            week=window.week.label,
            monday=window.monday,
            sunday=window.sunday,
            is_current=window.is_current,
        ),
        max_follow_ups=limit,
        to_send=ToSend(
            total=total["to_send"],
            overdue=total["overdue"],
            groups=[
                RankGroup(
                    rank=rank,
                    step=step_code(rank),
                    step_label=step_label(rank),
                    count=total[f"rank_{rank}"],
                    overdue=total[f"late_{rank}"],
                )
                for rank in ranks
            ],
        ),
        levels=[LevelCount(key, level_label(key), total[f"level_{key}"]) for key in keys],
        categories=[
            CategoryCount(category, CATEGORY_LABELS[category], total[category.value])
            for category in COUNTED_CATEGORIES
        ],
        cohorts=_cohort_summaries(session, list(cohort_rows), keys),
        weeks=[_week_option(label, count) for label, count in week_rows],
    )


def _week_option(label: str, count: int) -> WeekOption:
    year, number = label.split("-W")
    week = IsoWeek(int(year), int(number))
    return WeekOption(week=label, year=week.year, number=week.week, monday=week.monday, count=count)


def _cohort_summaries(
    session: Session, rows: list[tuple[Any, ...]], keys: list[str]
) -> list[CohortSummary]:
    """Per cohort holding prospects: totals and its sequences in progress by level."""
    if not rows:
        return []
    facts: dict[uuid.UUID, dict[str, Any]] = {}
    for cohort_id, level, count, active, sending, late in rows:
        entry = facts.setdefault(
            cohort_id,
            {"prospects": 0, "in_sequence": 0, "to_send": 0, "overdue": 0, "levels": {}},
        )
        entry["prospects"] += count
        entry["in_sequence"] += active
        entry["to_send"] += sending
        entry["overdue"] += late
        if level is not None and active:
            entry["levels"][level] = entry["levels"].get(level, 0) + active
    cohorts = session.scalars(select(Cohort).where(Cohort.id.in_(facts))).all()
    ordered = sorted(
        cohorts,
        key=lambda cohort: (
            cohort.out_of_campaign,
            cohort.starts_on is None,
            cohort.starts_on or date.min,
            cohort.code,
        ),
    )
    return [
        CohortSummary(
            id=cohort.id,
            code=cohort.code,
            starts_on=cohort.starts_on,
            out_of_campaign=cohort.out_of_campaign,
            needs_review=cohort.needs_review,
            prospects=facts[cohort.id]["prospects"],
            in_sequence=facts[cohort.id]["in_sequence"],
            to_send=facts[cohort.id]["to_send"],
            overdue=facts[cohort.id]["overdue"],
            levels=[]
            if cohort.out_of_campaign
            else [
                LevelCount(key, level_label(key), facts[cohort.id]["levels"].get(key, 0))
                for key in keys
            ],
        )
        for cohort in ordered
    ]


# --- lists --------------------------------------------------------------------------------------


def _page_statement(window: PlanningWeek) -> Select[Any]:
    sending = to_send(window)
    return join_segment_sources(
        select(
            Prospect,
            Role.label,
            Company.display_name,
            primary_email.address,
            ContactTracking.status,
            Cohort.id,
            Cohort.code,
            Cohort.starts_on,
            sent_count_sql(),
            last_sent_at_sql(),
            level_key_sql(),
            func.coalesce(finished_sql(), false()),
            next_rank_sql(),
            next_due_at_sql(),
            func.coalesce(sending, false()),
            func.coalesce(and_(sending, overdue(window)), false()),
            email_error_sql(),
            ContactSequence.id,
        )
    ).outerjoin(Role, Role.id == Prospect.role_id)


def _order_by(sort: ContactSort) -> list[Any]:
    person = [
        label_key(Prospect.last_name).nulls_last(),
        label_key(Prospect.first_name).nulls_last(),
    ]
    keys: list[Any]
    match sort:
        case ContactSort.DUE:
            keys = [next_due_at_sql().asc().nulls_last(), *person]
        case ContactSort.NAME:
            keys = person
        case ContactSort.COHORT:
            keys = [
                (Cohort.code == OUT_OF_CAMPAIGN_CODE).asc().nulls_last(),
                Cohort.starts_on.asc().nulls_last(),
                Cohort.code.asc().nulls_last(),
                *person,
            ]
    return [*keys, Prospect.id]


def _messages(
    session: Session, sequence_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[MessageState]]:
    """Per current sequence: its messages by rank (one statement for the page)."""
    states: dict[uuid.UUID, list[MessageState]] = {}
    if not sequence_ids:
        return states
    rows = session.execute(
        select(ContactMessage.sequence_id, ContactMessage.rank, ContactMessage.status)
        .where(ContactMessage.sequence_id.in_(sequence_ids))
        .order_by(ContactMessage.sequence_id, ContactMessage.rank)
    ).tuples()
    for sequence_id, rank, status in rows:
        states.setdefault(sequence_id, []).append(MessageState(rank, step_code(rank), status))
    return states


def list_contacts(
    session: Session,
    filters: ContactFilters,
    clock: ContactClock,
    *,
    limit: int = 50,
    offset: int = 0,
) -> ContactPage:
    """One page of a planning list and its total (three statements whatever the page size)."""
    limit = max(1, min(limit, LIST_MAX_LIMIT))
    offset = max(0, offset)
    window = clock.window(filters.week)
    where = list_conditions(filters, window)
    page = (
        _page_statement(window)
        .where(*where)
        .order_by(*_order_by(filters.sort))
        .limit(limit)
        .offset(offset)
    )
    count = join_segment_sources(select(func.count())).where(*where)
    with whole_base_plan(session):
        rows = session.execute(page).tuples().all()
        total = session.execute(count).scalar_one()
    messages = _messages(session, [row[-1] for row in rows if row[-1] is not None])
    items = []
    for (
        prospect,
        role_label,
        company_name,
        email,
        state,
        cohort_id,
        cohort_code,
        cohort_starts_on,
        sent_count,
        last_sent_at,
        level,
        finished,
        next_rank,
        next_due,
        sending,
        late,
        email_error,
        sequence_id,
    ) in rows:
        states = messages.get(sequence_id, []) if sequence_id else []
        next_status = next(
            (message.status for message in states if message.rank == next_rank), None
        )
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
                contactability_status=prospect.contactability_status,
                tracking_status=state or S.NEUTRAL,
                cohort_id=cohort_id,
                cohort_code=cohort_code,
                cohort_starts_on=cohort_starts_on,
                out_of_campaign=cohort_code == OUT_OF_CAMPAIGN_CODE,
                sent_count=sent_count,
                last_sent_at=last_sent_at,
                level=level,
                level_label=level_label(level) if level else None,
                finished=bool(finished),
                next_rank=next_rank,
                next_step=step_code(next_rank) if next_rank is not None else None,
                next_step_label=step_label(next_rank) if next_rank is not None else None,
                next_due_at=next_due,
                next_due_week=iso_week(next_due),
                to_send=bool(sending),
                overdue=bool(late),
                email_error=bool(email_error),
                next_message_status=next_status,
                messages=states,
            )
        )
    return ContactPage(items=items, total=total, limit=limit, offset=offset, week=window.week.label)
