"""HomeService (Task 16): the global dashboard, read-only.

Every prospect count is a canonical Prospection segment (`prospection.query.count_segments`), so
Home and Prospection always agree. Home adds what Prospection does not count — companies, monthly
progress read from the real sends and the status history, next actions and the recent imports and
edits — in a fixed number of explicit statements whatever the base size. (The « Suivi commercial
léger » group of post-appointment stages was removed with the Contact model, decision P3.)
Definitions: doc/features/home-dashboard.md (decisions I-110 … I-117).
"""

import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any

from sqlalchemy import ColumnElement, and_, func, or_, select, union_all
from sqlalchemy.orm import Session

from app.core.actor import ActorType
from app.core.business_time import start_of_day
from app.db.session import whole_base_plan
from app.models import (
    Company,
    ContactMessage,
    ContactTracking,
    ImportBatch,
    InternalReferent,
    Prospect,
)
from app.models.contact_tracking import ContactTrackingStatusHistory
from app.models.enums import (
    ContactMessageStatus,
    ContactTrackingStatus,
    SendSource,
    TrackingHistoryStatus,
)
from app.services import audit, history, import_batches
from app.services.audit import AuditSource
from app.services.contact_sequences import next_due_at_sql
from app.services.contact_workflow import (
    APPOINTMENT_CODES,
    CONTACT_ATTEMPT_CODES,
    RESTATEMENT_ACTOR_IDS,
)
from app.services.history import HistoryActor
from app.services.prospection.query import ProspectFilters, count_segments
from app.services.prospection.segments import (
    Segment,
    SegmentContext,
    actionable,
    has_appointment,
    join_segment_sources,
    predicate,
    responded,
)

S = ContactTrackingStatus
History = ContactTrackingStatusHistory

# Outcomes that leave nothing to do: never listed as next actions.
CLOSED_STAGES = (S.IGNORED, S.DISQUALIFIED)
# Sends recorded when they happened (a person's « Marquer comme envoyé », the dispatcher); an
# import or a migration restates a send made at an earlier, uncertain moment.
RECORDED_SEND_SOURCES = (SendSource.MANUAL, SendSource.WORKER)
# The current month and the five before it.
TREND_MONTHS = 6
# Appointments from the start of today to the end of the 6th day after it.
APPOINTMENT_WINDOW_DAYS = 7
ACTION_LIMIT = 5
IMPORT_LIMIT = 5
EDIT_LIMIT = 8
# Events read to build EDIT_LIMIT lines (one save writes one event per changed row).
EDIT_EVENTS_READ = 40
# Home's feed is about the prospect base: edits of prospects (and their e-mails, phones,
# tracking, sources) and companies (and their establishments). Settings changes stay out.
EDIT_SUBJECT_TYPES = ("prospect", "company")
# Saves by people and by future agents; imports have their own list, CLI/seed writes none.
EDIT_ACTOR_TYPES = (ActorType.HUMAN, ActorType.AGENT)
# Summaries need no labels: Home shows no value.
NO_LOOKUPS = history.Lookups()


@dataclass(frozen=True, slots=True)
class MonthProgress:
    month: date  # first day of the month, business time
    contacted: int  # prospects contacted for the first time that month
    appointments: int  # prospects who reached an appointment stage for the first time that month


@dataclass(frozen=True, slots=True)
class ActionItem:
    prospect_id: uuid.UUID
    first_name: str | None
    last_name: str | None
    company_name: str | None
    tracking_status: ContactTrackingStatus | None
    # The date the group is ordered by: appointment, next due date or response.
    at: datetime | None
    referent_name: str | None


@dataclass(frozen=True, slots=True)
class ActionGroup:
    total: int
    items: list[ActionItem]


@dataclass(frozen=True, slots=True)
class NextActions:
    appointments: ActionGroup  # actionable, appointment in the next 7 days, soonest first
    due: ActionGroup  # the `due` segment, oldest planned contact first
    responses: ActionGroup  # actionable, answered, no appointment yet, oldest answer first


@dataclass(frozen=True, slots=True)
class EditItem:
    """One save on one prospect or company, as the history groups it (`app.services.history`)."""

    occurred_at: datetime
    actor: HistoryActor
    source: AuditSource | None
    subject_type: str
    subject_id: uuid.UUID | None
    # The person's name or the company's display name; None once the record is deleted.
    subject_label: str | None
    # What the save did, without any value (« E-mail principal modifié », « Suivi : A → B »).
    summary: list[str]


@dataclass(frozen=True, slots=True)
class HomeSummary:
    today: date
    stale_threshold_days: int | None
    counts: dict[Segment, int]
    companies: int
    months: list[MonthProgress]  # oldest first; the last one is the current month
    next_actions: NextActions
    recent_imports: list[ImportBatch]
    recent_edits: list[EditItem]


def home_summary(session: Session, context: SegmentContext) -> HomeSummary:
    counted = count_segments(session, ProspectFilters(), context)
    companies = session.execute(select(func.count()).select_from(Company)).scalar_one()
    return HomeSummary(
        today=context.today,
        stale_threshold_days=context.stale_days,
        counts=counted.counts,
        companies=companies,
        months=monthly_progress(session, context.today),
        next_actions=next_actions(session, context),
        recent_imports=import_batches.list_batches(session, limit=IMPORT_LIMIT),
        recent_edits=recent_edits(session),
    )


# --- monthly progress ---------------------------------------------------------------------------


def month_start(day: date, months_back: int = 0) -> date:
    """First day of the month `months_back` months before `day`'s (negative: after)."""
    index = day.year * 12 + day.month - 1 - months_back
    return date(index // 12, index % 12 + 1, 1)


def _restated() -> ColumnElement[bool]:
    """A history row that restates a state reached earlier: written by an import, or appended by
    migration 0008/0010 (a conversion)."""
    return or_(
        History.actor_type == ActorType.IMPORT,
        and_(History.actor_type == ActorType.SYSTEM, History.actor_id.in_(RESTATEMENT_ACTOR_IDS)),
    )


def _history_events(codes: tuple[TrackingHistoryStatus, ...]) -> Any:
    """(prospect, moment, recorded) of every history row entering one of `codes`."""
    return (
        select(
            ContactTracking.prospect_id.label("prospect_id"),
            History.changed_at.label("at"),
            (~_restated()).label("recorded"),
        )
        .join(ContactTracking, ContactTracking.id == History.contact_tracking_id)
        .where(History.to_status.in_(codes))
    )


def _firsts(events: Any) -> Any:
    """Per prospect: the first event, and the first one recorded when it happened. The two are
    equal only when the first one was recorded in VIPER — an import or a migration restates a
    contact made at an unknown earlier date."""
    rows = events.subquery()
    return (
        select(
            func.min(rows.c.at).label("first"),
            func.min(rows.c.at).filter(rows.c.recorded).label("recorded"),
        )
        .group_by(rows.c.prospect_id)
        .subquery()
    )


def monthly_progress(session: Session, today: date) -> list[MonthProgress]:
    """Prospects contacted for the first time and appointments obtained per month (business
    time), for the current month and the ones before it. A first contact is the first message
    really sent (any sequence) or, for contacts made before the sends existed, the first history
    row of a contact-attempt state; an appointment is read from the status history."""
    sends = select(
        ContactMessage.prospect_id.label("prospect_id"),
        ContactMessage.sent_at.label("at"),
        ContactMessage.sent_source.in_(RECORDED_SEND_SOURCES).label("recorded"),
    ).where(ContactMessage.status == ContactMessageStatus.SENT)
    contacts = _firsts(union_all(sends, _history_events(CONTACT_ATTEMPT_CODES)))
    appointments = _firsts(_history_events(APPOINTMENT_CODES))
    months = [month_start(today, back) for back in range(TREND_MONTHS - 1, -1, -1)]

    def per_month(firsts: Any) -> list[int]:
        row = session.execute(
            select(
                *(
                    func.count().filter(
                        firsts.c.first == firsts.c.recorded,
                        firsts.c.first >= start_of_day(month),
                        firsts.c.first < start_of_day(month_start(month, -1)),
                    )
                    for month in months
                )
            ).select_from(firsts)
        ).one()
        return list(row)

    # Whole-base reads over the history and the sends (joins included): no nested loops.
    with whole_base_plan(session):
        contacted = per_month(contacts)
        obtained = per_month(appointments)
    return [
        MonthProgress(month=month, contacted=contacted[index], appointments=obtained[index])
        for index, month in enumerate(months)
    ]


# --- next actions -------------------------------------------------------------------------------


def _action_group(
    session: Session, condition: ColumnElement[bool], at: Any, *, nulls_last: bool = False
) -> ActionGroup:
    referent = func.concat_ws(" ", InternalReferent.first_name, InternalReferent.last_name)
    order = at.asc().nulls_last() if nulls_last else at.asc()
    rows = session.execute(
        join_segment_sources(
            select(
                Prospect.id,
                Prospect.first_name,
                Prospect.last_name,
                Company.display_name,
                ContactTracking.status,
                at,
                referent,
                func.count().over(),
            )
        )
        .outerjoin(InternalReferent, InternalReferent.id == ContactTracking.referent_id)
        .where(condition)
        .order_by(order, Prospect.id)
        .limit(ACTION_LIMIT)
    ).all()
    return ActionGroup(
        total=rows[0][-1] if rows else 0,
        items=[
            ActionItem(
                prospect_id=row[0],
                first_name=row[1],
                last_name=row[2],
                company_name=row[3],
                tracking_status=row[4],
                at=row[5],
                referent_name=row[6] or None,
            )
            for row in rows
        ],
    )


def next_actions(session: Session, context: SegmentContext) -> NextActions:
    """Three short lists, in this priority: appointments of the coming week (time-bound), due
    contacts (overdue work), answers still waiting for an appointment (conversion)."""
    window_end = start_of_day(context.today + timedelta(days=APPOINTMENT_WINDOW_DAYS))
    upcoming = and_(
        actionable(),
        ContactTracking.appointment_at >= start_of_day(context.today),
        ContactTracking.appointment_at < window_end,
    )
    awaiting = and_(
        actionable(),
        responded(),
        ~has_appointment(),
        ContactTracking.status.not_in(CLOSED_STAGES),
    )
    # Each group counts its whole segment (`count(*) OVER ()`) before keeping the first five.
    with whole_base_plan(session):
        return NextActions(
            appointments=_action_group(session, upcoming, ContactTracking.appointment_at),
            due=_action_group(session, predicate(Segment.DUE, context), next_due_at_sql()),
            responses=_action_group(
                session, awaiting, ContactTracking.response_received_at, nulls_last=True
            ),
        )


# --- recent edits -------------------------------------------------------------------------------


def _subject_labels(
    session: Session, subjects: set[tuple[str | None, uuid.UUID | None]]
) -> dict[tuple[str, uuid.UUID], str]:
    """Current names of the feed's subjects: one query per subject type present."""
    sources = {
        "prospect": (Prospect.id, func.concat_ws(" ", Prospect.first_name, Prospect.last_name)),
        "company": (Company.id, Company.display_name),
    }
    labels: dict[tuple[str, uuid.UUID], str] = {}
    for subject_type, (key, label) in sources.items():
        ids = {subject_id for kind, subject_id in subjects if kind == subject_type and subject_id}
        if ids:
            for subject_id, name in session.execute(select(key, label).where(key.in_(ids))):
                if name:
                    labels[(subject_type, subject_id)] = name
    return labels


def recent_edits(session: Session) -> list[EditItem]:
    """The latest saves by people (and, later, agents) on prospects and companies, newest first,
    grouped and summarized by the history formatter — value-free phrases only: Home shows what
    changed, the editors' history shows the values."""
    events = audit.recent_activity(
        session,
        limit=EDIT_EVENTS_READ,
        subject_types=EDIT_SUBJECT_TYPES,
        actor_types=EDIT_ACTOR_TYPES,
    )
    groups = history.group_events(events, across_records=True)[:EDIT_LIMIT]
    entries = [history.describe(group, NO_LOOKUPS) for group in groups]
    labels = _subject_labels(session, {(entry.subject_type, entry.subject_id) for entry in entries})
    return [
        EditItem(
            occurred_at=entry.occurred_at,
            actor=entry.actor,
            source=entry.source,
            subject_type=entry.subject_type,
            subject_id=entry.subject_id,
            subject_label=(
                labels.get((entry.subject_type, entry.subject_id)) if entry.subject_id else None
            ),
            summary=entry.summary,
        )
        for entry in entries
    ]
