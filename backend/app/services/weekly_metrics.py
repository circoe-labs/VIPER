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
from datetime import date

from sqlalchemy import false, func, select
from sqlalchemy.orm import Session

from app.core.business_time import BusinessWeek
from app.db.session import whole_base_plan
from app.models import ContactTracking
from app.models.contact_tracking import ContactTrackingStatusHistory as History
from app.models.enums import (
    ContactTrackingStatus as S,
)
from app.models.enums import (
    QualityAlertType,
    TrackingHistoryStatus,
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
