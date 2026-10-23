"""Suivi des envois programmés: what is scheduled, how many, at which step, what was forgotten.

Read-only, like the Contact planning it sits on: nothing here changes a state or a message.

- **Messages** (`steps`, `days`, `totals`): the messages of the *current* sequences that are
  `draft`, `validated` or `scheduled`, by step (Contact, R1, R2…); the scheduled ones also by
  business day (Europe/Paris) of their send moment.
- **Forgotten** (`forgotten`): the prospects with something to send — the planning's « à envoyer »
  of the week (`contact_dashboard`, overdue steps included for the current week) — whose message of
  the step to send is not `scheduled`. Its state says what is missing: `none` (nothing written, or a
  cancelled message), `draft` (to read and validate) or `validated` (to schedule). A prospect whose
  next step is not due yet is not « forgotten »: its mail may simply be prepared ahead.
- **To watch** (`totals`): scheduled messages whose moment has passed without leaving
  (`scheduled_past`), and scheduled messages carrying a send error (`scheduled_with_error`) or a
  failed remote-draft creation (`scheduled_with_draft_error`, a `toolbox_*` code: nothing was sent).
"""

import uuid
from dataclasses import dataclass, field
from datetime import date, datetime

from sqlalchemy import Date, cast, func, select
from sqlalchemy.orm import Session

from app.core.business_time import BUSINESS_TIMEZONE
from app.core.contact_steps import step_code, step_label
from app.models import Cohort, ContactMessage, ContactSequence, Prospect
from app.models.companies import Company
from app.models.enums import ContactMessageStatus
from app.services import app_settings
from app.services.contact_dashboard import (
    ContactCategory,
    ContactClock,
    ContactFilters,
    ContactRow,
    list_contacts,
)
from app.services.contact_remote_drafts import TOOLBOX_ERROR_PREFIX
from app.services.contact_workflow import IsoWeek
from app.services.prospection.query import LIST_MAX_LIMIT

M = ContactMessageStatus
# A safety stop: more than this many prospects to send in one week is not a planning any more.
FORGOTTEN_SCAN_MAX = 5000


@dataclass(slots=True)
class StepOverview:
    rank: int
    step: str
    step_label: str
    drafts: int = 0
    validated: int = 0
    scheduled: int = 0
    # Prospects with this step to send in the week; of them, those without a scheduled message.
    due: int = 0
    forgotten: int = 0
    forgotten_none: int = 0
    forgotten_draft: int = 0
    forgotten_validated: int = 0


@dataclass(slots=True)
class ScheduledDay:
    day: date
    total: int = 0
    by_step: dict[str, int] = field(default_factory=dict)
    # The day is before today: those mails should have left.
    past: bool = False


@dataclass(frozen=True, slots=True)
class ForgottenProspect:
    id: uuid.UUID
    first_name: str | None
    last_name: str | None
    civility: str | None
    company_name: str | None
    cohort_code: str | None
    step: str
    step_label: str
    rank: int
    # `none` | `draft` | `validated`
    state: str
    due_at: datetime | None
    overdue: bool


@dataclass(frozen=True, slots=True)
class PreparedMessage:
    """One draft, validated or scheduled message and whose it is (the tiles' drill-down)."""

    prospect_id: uuid.UUID
    first_name: str | None
    last_name: str | None
    company_name: str | None
    cohort_code: str | None
    step: str
    step_label: str
    rank: int
    # `draft` | `validated` | `scheduled`
    status: str
    scheduled_at: datetime | None
    last_error_code: str | None


@dataclass(slots=True)
class Totals:
    scheduled: int = 0
    validated: int = 0
    drafts: int = 0
    due: int = 0
    forgotten: int = 0
    scheduled_past: int = 0
    scheduled_with_error: int = 0
    scheduled_with_draft_error: int = 0


@dataclass(slots=True)
class SchedulingOverview:
    today: date
    week: str
    current_week: str
    max_follow_ups: int
    totals: Totals
    steps: list[StepOverview]
    days: list[ScheduledDay]
    forgotten: list[ForgottenProspect]
    messages: list[PreparedMessage]


def _forgotten_state(row: ContactRow) -> str:
    match row.next_message_status:
        case M.DRAFT:
            return "draft"
        case M.VALIDATED:
            return "validated"
        case _:
            return "none"


def _message_counts(session: Session, steps: dict[int, StepOverview], totals: Totals) -> None:
    rows = session.execute(
        select(ContactMessage.rank, ContactMessage.status, func.count())
        .join(ContactSequence, ContactSequence.id == ContactMessage.sequence_id)
        .where(
            ContactSequence.is_current,
            ContactMessage.status.in_([M.DRAFT, M.VALIDATED, M.SCHEDULED]),
        )
        .group_by(ContactMessage.rank, ContactMessage.status)
    ).tuples()
    for rank, status, count in rows:
        step = steps.get(rank)
        if step is None:
            continue
        if status is M.DRAFT:
            step.drafts += count
            totals.drafts += count
        elif status is M.VALIDATED:
            step.validated += count
            totals.validated += count
        else:
            step.scheduled += count
            totals.scheduled += count


def _prepared_messages(session: Session) -> list[PreparedMessage]:
    rows = session.execute(
        select(
            ContactMessage.prospect_id,
            Prospect.first_name,
            Prospect.last_name,
            Company.display_name,
            Cohort.code,
            ContactMessage.rank,
            ContactMessage.status,
            ContactMessage.scheduled_at,
            ContactMessage.last_error_code,
        )
        .join(ContactSequence, ContactSequence.id == ContactMessage.sequence_id)
        .join(Prospect, Prospect.id == ContactMessage.prospect_id)
        .outerjoin(Company, Company.id == Prospect.company_id)
        .outerjoin(Cohort, Cohort.id == ContactSequence.cohort_id)
        .where(
            ContactSequence.is_current,
            ContactMessage.status.in_([M.DRAFT, M.VALIDATED, M.SCHEDULED]),
        )
        .order_by(
            ContactMessage.scheduled_at.asc().nulls_last(),
            func.lower(Prospect.last_name).asc().nulls_last(),
            ContactMessage.rank,
        )
    ).tuples()
    return [
        PreparedMessage(
            prospect_id=prospect_id,
            first_name=first,
            last_name=last,
            company_name=company,
            cohort_code=cohort,
            step=step_code(rank),
            step_label=step_label(rank),
            rank=rank,
            status=status.value,
            scheduled_at=scheduled_at,
            last_error_code=error,
        )
        for prospect_id, first, last, company, cohort, rank, status, scheduled_at, error in rows
    ]


def _scheduled_days(
    session: Session, clock: ContactClock, now: datetime, totals: Totals
) -> list[ScheduledDay]:
    local_day = cast(func.timezone(str(BUSINESS_TIMEZONE), ContactMessage.scheduled_at), Date)
    rows = session.execute(
        select(local_day, ContactMessage.rank, func.count())
        .join(ContactSequence, ContactSequence.id == ContactMessage.sequence_id)
        .where(
            ContactSequence.is_current,
            ContactMessage.status == M.SCHEDULED,
            ContactMessage.scheduled_at.is_not(None),
        )
        .group_by(local_day, ContactMessage.rank)
        .order_by(local_day)
    ).tuples()
    days: dict[date, ScheduledDay] = {}
    for day, rank, count in rows:
        entry = days.setdefault(day, ScheduledDay(day=day, past=day < clock.today))
        code = step_code(rank)
        entry.by_step[code] = entry.by_step.get(code, 0) + count
        entry.total += count
    watched = session.execute(
        select(
            func.count().filter(ContactMessage.scheduled_at < now),
            func.count().filter(
                ContactMessage.last_error_code.is_not(None),
                ~ContactMessage.last_error_code.startswith(TOOLBOX_ERROR_PREFIX, autoescape=True),
            ),
            func.count().filter(
                ContactMessage.last_error_code.startswith(TOOLBOX_ERROR_PREFIX, autoescape=True)
            ),
        )
        .join(ContactSequence, ContactSequence.id == ContactMessage.sequence_id)
        .where(ContactSequence.is_current, ContactMessage.status == M.SCHEDULED)
    ).one()
    (
        totals.scheduled_past,
        totals.scheduled_with_error,
        totals.scheduled_with_draft_error,
    ) = watched
    return list(days.values())


def overview(
    session: Session,
    clock: ContactClock,
    week: IsoWeek | None = None,
    *,
    now: datetime | None = None,
) -> SchedulingOverview:
    """The scheduling picture of `week` (default: this week) in a handful of statements."""
    now = now or datetime.now(BUSINESS_TIMEZONE)
    limit = app_settings.max_follow_ups(session)
    steps = {
        rank: StepOverview(rank, step_code(rank), step_label(rank)) for rank in range(limit + 1)
    }
    totals = Totals()
    _message_counts(session, steps, totals)
    days = _scheduled_days(session, clock, now, totals)

    forgotten: list[ForgottenProspect] = []
    filters = ContactFilters(category=ContactCategory.TO_SEND, week=week)
    window = clock.window(week)
    offset = 0
    while offset < FORGOTTEN_SCAN_MAX:
        page = list_contacts(session, filters, clock, limit=LIST_MAX_LIMIT, offset=offset)
        for row in page.items:
            rank = row.next_rank
            step = steps.get(rank) if rank is not None else None
            if step is None or rank is None:
                continue
            step.due += 1
            totals.due += 1
            if row.next_message_status is M.SCHEDULED:
                continue
            state = _forgotten_state(row)
            step.forgotten += 1
            totals.forgotten += 1
            setattr(step, f"forgotten_{state}", getattr(step, f"forgotten_{state}") + 1)
            forgotten.append(
                ForgottenProspect(
                    id=row.id,
                    first_name=row.first_name,
                    last_name=row.last_name,
                    civility=row.civility.value if row.civility else None,
                    company_name=row.company_name,
                    cohort_code=row.cohort_code,
                    step=step.step,
                    step_label=step.step_label,
                    rank=rank,
                    state=state,
                    due_at=row.next_due_at,
                    overdue=row.overdue,
                )
            )
        offset += len(page.items)
        if not page.items or offset >= page.total:
            break
    return SchedulingOverview(
        today=clock.today,
        week=window.week.label,
        current_week=clock.current_week.label,
        max_follow_ups=limit,
        totals=totals,
        steps=list(steps.values()),
        days=days,
        forgotten=forgotten,
        messages=_prepared_messages(session),
    )
