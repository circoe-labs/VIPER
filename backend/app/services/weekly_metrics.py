"""Weekly read-model (slice S1 of the Prospection / Contact / Home rearchitecture).

One truthful contract for « cette semaine » (`BusinessWeek`: Monday 00:00 inclusive to next Monday
00:00 exclusive, Europe/Paris) and for the Contact operational counters. Nothing is a new metric
system: additions come from `home.weekly_additions`, first contacts / first appointments from
`home.weekly_recorded_firsts`, planning figures from the Contact predicates
(`contact_dashboard.to_send` / `overdue`, `contacted_sql`, `email_error_sql`) and the Prospection
`to_contact` / `has_appointment` segments. Only events the data records are counted as deltas;
a stock count is never differenced. Definitions: doc/features/weekly-metrics.md.
"""

from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import and_, false, func, or_, select
from sqlalchemy.orm import Session

from app.core.business_time import BusinessWeek
from app.db.session import whole_base_plan
from app.models import Company, ContactMessage, ContactTracking, Prospect, Warehouse
from app.models.contact_tracking import ContactTrackingStatusHistory as History
from app.models.enums import (
    ContactMessageStatus,
    QualityAlertType,
    TrackingHistoryStatus,
)
from app.models.enums import (
    ContactTrackingStatus as S,
)
from app.models.quality_alerts import QualityAlert
from app.services import home
from app.services.contact_dashboard import (
    ContactClock,
    contacted_sql,
    in_sequence,
    overdue,
    to_send,
)
from app.services.contact_sequences import (
    EFFECTIVE_ALERT_SOURCES,
    email_error_sql,
    finished_sql,
    next_due_at_sql,
    next_rank_sql,
)
from app.services.prospection.segments import has_appointment, join_segment_sources, to_contact

# Statuses a person can be moved to and that the status history records one event for.
ENTRY_STATUSES = (
    TrackingHistoryStatus.RESPONSE_RECEIVED,
    TrackingHistoryStatus.APPOINTMENT_OBTAINED,
    TrackingHistoryStatus.NOT_INTERESTED,
    TrackingHistoryStatus.IGNORED,
    TrackingHistoryStatus.DISQUALIFIED,
)


@dataclass(frozen=True, slots=True)
class WeeklyAdditions:
    prospects: int
    companies: int
    warehouses: int


@dataclass(frozen=True, slots=True)
class ContactStock:
    """Counts as of now (not weekly)."""

    to_contact: int  # first contact planned, whatever its date (segment `to_contact`)
    to_send: int  # to send by the end of this week, overdue included
    overdue: int  # to_send with a due date before this week's Monday
    first_contact_to_send: int  # to_send at rank 0
    follow_up_to_send: int  # to_send at rank >= 1
    follow_up_overdue: int  # overdue at rank >= 1
    upcoming: int  # sequence in progress, next send due after this week
    contacted: int  # at least one real send, any sequence
    responses: int  # state « Réponse reçue »
    appointments: int  # `has_appointment()`: « RDV pris » or a recorded appointment date
    mail_error: int  # open effective « Erreur sur le mail » (the « mail inactive » figure)


@dataclass(frozen=True, slots=True)
class ContactWeekEvents:
    """Events recorded during the week (each prospect once per figure)."""

    first_contacts: int
    first_appointments: int
    responses: int  # `response_received_at` inside the week
    mail_errors_opened: int  # effective « Erreur sur le mail » raised inside the week
    # Prospects whose status history gained a row entering the state in the week, restatements
    # (imports, migrations 0008/0012) excluded; key = TrackingHistoryStatus value.
    status_entries: dict[str, int]


@dataclass(frozen=True, slots=True)
class WeeklyMetrics:
    timezone: str
    week: str
    week_start: date
    week_end: date  # Sunday, inclusive
    today: date
    additions: WeeklyAdditions
    contact_stock: ContactStock
    contact_events: ContactWeekEvents
    # Prospection segment / activity-status deltas have no event history: not computable.
    prospection_sub_status_deltas: None = None


def contact_stock(session: Session, clock: ContactClock) -> ContactStock:
    window = clock.window()
    sending, late, rank = to_send(window), overdue(window), next_rank_sql()
    statement = join_segment_sources(
        select(
            func.count().filter(to_contact()),
            func.count().filter(sending),
            func.count().filter(late),
            func.count().filter(sending, rank == 0),
            func.count().filter(sending, rank >= 1),
            func.count().filter(late, rank >= 1),
            func.count().filter(in_sequence(), ~func.coalesce(sending, false()),
                                next_due_at_sql().is_not(None)),
            func.count().filter(contacted_sql()),
            func.count().filter(ContactTracking.status == S.RESPONSE_RECEIVED),
            func.count().filter(has_appointment()),
            func.count().filter(email_error_sql()),
        )
    )
    with whole_base_plan(session):
        return ContactStock(*session.execute(statement).one())


def contact_events(session: Session, week: BusinessWeek) -> ContactWeekEvents:
    with whole_base_plan(session):
        first_contacts, first_appointments = home.weekly_recorded_firsts(session, week)
        responses = session.scalar(
            select(func.count()).where(
                ContactTracking.response_received_at >= week.start,
                ContactTracking.response_received_at < week.end,
            )
        ) or 0
        mail_errors = session.scalar(
            select(func.count(func.distinct(QualityAlert.prospect_id))).where(
                QualityAlert.type == QualityAlertType.EMAIL_ERROR,
                QualityAlert.source.in_(EFFECTIVE_ALERT_SOURCES),
                QualityAlert.prospect_id.is_not(None),
                QualityAlert.created_at >= week.start,
                QualityAlert.created_at < week.end,
            )
        ) or 0
        entries = dict(
            session.execute(
                select(History.to_status, func.count(func.distinct(History.contact_tracking_id)))
                .where(
                    History.to_status.in_(ENTRY_STATUSES),
                    History.changed_at >= week.start,
                    History.changed_at < week.end,
                    ~home.restated(),
                )
                .group_by(History.to_status)
            ).tuples().all()
        )
    return ContactWeekEvents(
        first_contacts=first_contacts,
        first_appointments=first_appointments,
        responses=responses,
        mail_errors_opened=mail_errors,
        status_entries={
            status.value: int(entries.get(status, 0))
            for status in ENTRY_STATUSES
        },
    )


def weekly_metrics(session: Session, today: date) -> WeeklyMetrics:
    clock = ContactClock(today)
    week = BusinessWeek.of(today)
    added = home.weekly_additions(session, week)
    return WeeklyMetrics(
        timezone="Europe/Paris",
        week=week.label,
        week_start=week.monday,
        week_end=week.sunday,
        today=today,
        additions=WeeklyAdditions(**added),
        contact_stock=contact_stock(session, clock),
        contact_events=contact_events(session, week),
    )


MAX_SERIES_WEEKS = 26


@dataclass(frozen=True, slots=True)
class WeekPoint:
    week: str  # ISO label, e.g. `2026-W43`
    week_start: date
    week_end: date  # Sunday, inclusive
    additions: WeeklyAdditions
    # Rows existing at the end of the week (created_at before the next Monday): the real base size.
    base: WeeklyAdditions
    first_contacts: int  # prospects contacted for the first time in the week
    follow_ups: int  # prospects who received a follow-up (rank >= 1) in the week
    appointments: int  # prospects who obtained an appointment for the first time in the week
    ignored: int  # prospects who declined (« Non intéressé » / « Ignoré ») in the week


@dataclass(frozen=True, slots=True)
class ConversionTotals:
    """Stock as of now. `contacted` / `with_appointment` give the RDV rate; the four `base_*`
    figures split every prospect of the base into exclusive categories (first match wins):
    appointment, ignored (declined, or sequence finished unanswered), contacted, not contacted."""

    contacted: int
    with_appointment: int  # contacted and `has_appointment()`
    base_appointment: int
    base_ignored: int
    base_contacted: int
    base_not_contacted: int


@dataclass(frozen=True, slots=True)
class WeeklySeries:
    timezone: str
    today: date
    weeks: list[WeekPoint]  # oldest first, the current week last
    totals: ConversionTotals


def weekly_series(session: Session, today: date, count: int = 12) -> WeeklySeries:
    """The last `count` business weeks (current one included), each from the same rules as
    `weekly_metrics` (created_at, recorded events, restatements excluded). A week without
    recorded event is an honest zero; see doc/features/weekly-metrics.md for the limits."""
    current = BusinessWeek.of(today)
    mondays = [current.monday - timedelta(weeks=back) for back in range(count - 1, -1, -1)]
    weeks = [BusinessWeek(monday) for monday in mondays]
    first, last = weeks[0], weeks[-1]
    models = {"prospects": Prospect, "companies": Company, "warehouses": Warehouse}
    with whole_base_plan(session):
        added = {
            key: session.execute(
                select(*(
                    func.count().filter(model.created_at >= week.start, model.created_at < week.end)
                    for week in weeks
                )).where(model.created_at >= first.start, model.created_at < last.end)
            ).one()
            for key, model in models.items()
        }
        sizes = {
            key: session.execute(
                select(*(func.count().filter(model.created_at < week.end) for week in weeks))
            ).one()
            for key, model in models.items()
        }
        firsts = home.weekly_recorded_firsts_series(session, weeks)
        follow_ups = session.execute(
            select(*(
                func.count(func.distinct(ContactMessage.prospect_id)).filter(
                    ContactMessage.sent_at >= week.start, ContactMessage.sent_at < week.end
                )
                for week in weeks
            )).where(
                ContactMessage.status == ContactMessageStatus.SENT,
                ContactMessage.rank >= 1,
                ContactMessage.sent_source.in_(home.RECORDED_SEND_SOURCES),
                ContactMessage.sent_at >= first.start,
                ContactMessage.sent_at < last.end,
            )
        ).one()
        declined = session.execute(
            select(*(
                func.count(func.distinct(History.contact_tracking_id)).filter(
                    History.changed_at >= week.start, History.changed_at < week.end
                )
                for week in weeks
            )).where(
                History.to_status.in_(
                    (TrackingHistoryStatus.NOT_INTERESTED, TrackingHistoryStatus.IGNORED)
                ),
                History.changed_at >= first.start,
                History.changed_at < last.end,
                ~home.restated(),
            )
        ).one()
        # Prospects without a tracking row make these predicates NULL: coalesce so `~` stays exact.
        is_appointment = func.coalesce(has_appointment(), false())
        is_ignored = func.coalesce(
            or_(
                ContactTracking.status.in_((S.NOT_INTERESTED, S.IGNORED)),
                and_(in_sequence(), finished_sql()),
            ),
            false(),
        )
        is_contacted = func.coalesce(contacted_sql(), false())
        totals = session.execute(
            join_segment_sources(
                select(
                    func.count().filter(contacted_sql()),
                    func.count().filter(contacted_sql(), has_appointment()),
                    func.count().filter(is_appointment),
                    func.count().filter(~is_appointment, is_ignored),
                    func.count().filter(~is_appointment, ~is_ignored, is_contacted),
                    func.count().filter(~is_appointment, ~is_ignored, ~is_contacted),
                )
            )
        ).one()
    points = [
        WeekPoint(
            week=week.label,
            week_start=week.monday,
            week_end=week.sunday,
            additions=WeeklyAdditions(**{key: int(added[key][index]) for key in models}),
            base=WeeklyAdditions(**{key: int(sizes[key][index]) for key in models}),
            first_contacts=firsts[index][0],
            follow_ups=int(follow_ups[index]),
            appointments=firsts[index][1],
            ignored=int(declined[index]),
        )
        for index, week in enumerate(weeks)
    ]
    return WeeklySeries("Europe/Paris", today, points, ConversionTotals(*totals))
