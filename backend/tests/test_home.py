"""HomeService (Task 16) against the real test database: Home's aggregates on synthetic data.

Prospect counts reuse the Prospection edge cases (`tests.test_prospection.cases`) and must equal
the Prospection counters for the same data. Monthly progress is read from status-history rows
written with explicit times; definitions in doc/features/home-dashboard.md.
"""

import json
from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import ContactTracking, ContactTrackingStatusHistory, ImportBatch, Prospect
from app.models.enums import ContactTrackingStatus, ImportBatchStatus
from app.services import audit, home
from app.services import prospects as prospect_service
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from app.services.home import home_summary, month_start, monthly_progress, next_actions
from app.services.prospection.query import ProspectFilters, count_segments
from app.services.prospection.segments import Segment, SegmentContext
from tests.builders import OPERATOR, add_company, add_email, add_prospect, bind_operator
from tests.test_prospection import (
    CONTEXT,
    EXPECTED,
    TODAY,
    at,
    block,
    cases,  # noqa: F401 — the Prospection edge cases fixture
    random_base,
    statements,
    track,
)

S = ContactTrackingStatus
History = ContactTrackingStatusHistory
IMPORT_ACTOR = ActorType.IMPORT


def moved(
    session: Session,
    prospect: Prospect,
    to_status: S,
    when: datetime,
    actor_type: ActorType = ActorType.HUMAN,
) -> None:
    """A status-history row at an explicit time (the tracking is created on first use)."""
    tracking = session.query(ContactTracking).filter_by(prospect_id=prospect.id).one_or_none()
    if tracking is None:
        tracking = ContactTracking(prospect_id=prospect.id, status=to_status)
        session.add(tracking)
        session.flush()
    previous = (
        session.query(History.to_status)
        .filter_by(contact_tracking_id=tracking.id)
        .order_by(History.changed_at.desc())
        .limit(1)
        .scalar()
    )
    tracking.status = to_status
    session.add(
        History(
            contact_tracking_id=tracking.id,
            from_status=previous,
            to_status=to_status,
            changed_at=when,
            actor_type=actor_type,
            actor_display="Import test.xlsx" if actor_type is IMPORT_ACTOR else "Opératrice Test",
        )
    )
    session.flush()


def person(session: Session, name: str, **fields: object) -> Prospect:
    return add_prospect(session, None, first_name="Mois", last_name=name, **fields)


def current_month(session: Session, today: date = TODAY) -> home.MonthProgress:
    return monthly_progress(session, today)[-1]


# --- counts shared with Prospection -------------------------------------------------------------


@pytest.mark.usefixtures("cases")
def test_counts_are_the_prospection_counters(db_session: Session) -> None:
    summary = home_summary(db_session, CONTEXT)

    assert summary.counts == count_segments(db_session, ProspectFilters(), CONTEXT).counts
    assert summary.counts == {segment: len(EXPECTED[segment]) for segment in Segment}
    # Opposed people are never due, to contact or awaiting an answer, but stay in the outcomes.
    assert summary.counts[Segment.DUE] == 2
    assert summary.counts[Segment.DO_NOT_CONTACT] == 2
    assert (summary.today, summary.stale_threshold_days) == (TODAY, None)


@pytest.mark.parametrize("seed", [4, 5])
def test_counts_equal_prospection_on_random_bases(db_session: Session, seed: int) -> None:
    random_base(db_session, seed)
    context = SegmentContext(today=TODAY, stale_days=90)

    summary = home_summary(db_session, context)

    assert summary.counts == count_segments(db_session, ProspectFilters(), context).counts
    for stage, count in summary.stages.items():
        filtered = count_segments(db_session, ProspectFilters(tracking_status=stage), context)
        assert count == filtered.counts[Segment.ALL], stage


def test_companies_and_commercial_stages_come_from_recorded_statuses(db_session: Session) -> None:
    company = add_company(db_session, "Transports Exemple SARL")
    add_company(db_session, "Entreprise Sans Prospect SAS")
    stages = [S.QUOTE_SENT, S.QUOTE_SENT, S.QUOTE_FOLLOW_UP, S.WON, S.NOT_INTERESTED, S.CONTACTED]
    for n, stage in enumerate(stages):
        track(db_session, add_prospect(db_session, company, last_name=f"Stade{n}"), stage)
    # An appointment date alone never makes a quote or a win.
    track(db_session, add_prospect(db_session, company, last_name="Rdv"), appointment_at=at(TODAY))

    summary = home_summary(db_session, CONTEXT)

    assert summary.companies == 2
    assert summary.stages == {
        S.QUOTE_SENT: 2,
        S.QUOTE_FOLLOW_UP: 1,
        S.WON: 1,
        S.NOT_INTERESTED: 1,
    }


def test_empty_base(db_session: Session) -> None:
    summary = home_summary(db_session, CONTEXT)

    assert set(summary.counts.values()) == {0}
    assert summary.companies == 0
    assert set(summary.stages.values()) == {0}
    assert [month.contacted + month.appointments for month in summary.months] == [0] * 6
    assert summary.next_actions.due == home.ActionGroup(total=0, items=[])
    assert (summary.recent_imports, summary.recent_edits) == ([], [])


# --- monthly progress ---------------------------------------------------------------------------


def test_months_are_the_current_one_and_the_five_before() -> None:
    assert [m.isoformat() for m in (month_start(date(2026, 2, 17), b) for b in (2, 1, 0, -1))] == [
        "2025-12-01",
        "2026-01-01",
        "2026-02-01",
        "2026-03-01",
    ]


def test_months_list_oldest_first(db_session: Session) -> None:
    months = [m.month for m in monthly_progress(db_session, TODAY)]

    assert months == [date(2026, m, 1) for m in range(4, 10)]


def test_first_contact_counts_once_in_its_month(db_session: Session) -> None:
    fresh = person(db_session, "Nouveau")
    moved(db_session, fresh, S.TO_CONTACT, at(date(2026, 8, 20)))
    moved(db_session, fresh, S.CONTACTED, at(date(2026, 9, 2)))
    moved(db_session, fresh, S.FOLLOW_UP_1, at(date(2026, 9, 8)))
    # Contacted in August, followed up in September: August's contact, not September's.
    earlier = person(db_session, "Ancien")
    moved(db_session, earlier, S.CONTACTED, at(date(2026, 8, 5)))
    moved(db_session, earlier, S.FOLLOW_UP_1, at(date(2026, 9, 3)))
    # Created directly at a later stage by hand: a first contact too.
    direct = person(db_session, "Direct")
    moved(db_session, direct, S.RESPONSE_RECEIVED, at(date(2026, 9, 9)))
    # Opposed since: the contact still happened this month.
    opposed = person(db_session, "Opposé", **block())
    moved(db_session, opposed, S.CONTACTED, at(date(2026, 9, 1)))

    months = {m.month.month: m.contacted for m in monthly_progress(db_session, TODAY)}

    assert months == {4: 0, 5: 0, 6: 0, 7: 0, 8: 1, 9: 3}


def test_imported_stages_are_not_new_contacts(db_session: Session) -> None:
    # The import restates a legacy contact: neither its row nor a later follow-up is new.
    legacy = person(db_session, "Historique")
    moved(db_session, legacy, S.CONTACTED, at(date(2026, 9, 1)), IMPORT_ACTOR)
    moved(db_session, legacy, S.FOLLOW_UP_1, at(date(2026, 9, 4)))
    # Imported at « to contact », then contacted by hand this month: a new contact.
    imported = person(db_session, "Importé")
    moved(db_session, imported, S.TO_CONTACT, at(date(2026, 9, 1)), IMPORT_ACTOR)
    moved(db_session, imported, S.CONTACTED, at(date(2026, 9, 7)))
    legacy_appointment = person(db_session, "RdvHistorique")
    moved(db_session, legacy_appointment, S.APPOINTMENT_OBTAINED, at(TODAY), IMPORT_ACTOR)

    month = current_month(db_session)

    assert (month.contacted, month.appointments) == (1, 0)


def test_month_boundaries_follow_paris_time(db_session: Session) -> None:
    # 31 Aug 22:30 UTC is 1 Sep 00:30 in Paris (CEST): September.
    september = person(db_session, "MinuitPasse")
    moved(db_session, september, S.CONTACTED, datetime(2026, 8, 31, 22, 30, tzinfo=UTC))
    # 31 Aug 21:59 UTC is 23:59 in Paris: still August.
    august = person(db_session, "AvantMinuit")
    moved(db_session, august, S.CONTACTED, datetime(2026, 8, 31, 21, 59, tzinfo=UTC))
    # 1 Oct 00:00 Paris belongs to the next month, out of the trend.
    october = person(db_session, "Octobre")
    moved(db_session, october, S.CONTACTED, at(date(2026, 10, 1), 0))
    # 31 Mar 22:30 UTC is 1 Apr 00:30 (DST began on 29 March): April, the oldest month.
    april = person(db_session, "Avril")
    moved(db_session, april, S.CONTACTED, datetime(2026, 3, 31, 22, 30, tzinfo=UTC))

    months = {m.month.month: m.contacted for m in monthly_progress(db_session, TODAY)}

    assert months == {4: 1, 5: 0, 6: 0, 7: 0, 8: 1, 9: 1}


def test_appointment_counts_the_first_entry_into_an_appointment_stage(db_session: Session) -> None:
    obtained = person(db_session, "Obtenu")
    moved(db_session, obtained, S.CONTACTED, at(date(2026, 8, 3)))
    moved(db_session, obtained, S.APPOINTMENT_OBTAINED, at(date(2026, 9, 2)))
    moved(db_session, obtained, S.QUOTE_SENT, at(date(2026, 9, 9)))  # not a second one
    # Straight to « devis envoyé »: an appointment was obtained on the way.
    quoted = person(db_session, "Devis")
    moved(db_session, quoted, S.CONTACTED, at(date(2026, 9, 1)))
    moved(db_session, quoted, S.QUOTE_SENT, at(date(2026, 9, 4)))
    # Obtained in July, won in September: July's appointment.
    won = person(db_session, "Gagné")
    moved(db_session, won, S.APPOINTMENT_OBTAINED, at(date(2026, 7, 10)))
    moved(db_session, won, S.WON, at(date(2026, 9, 5)))
    # A date recorded without the stage is not in the monthly count (only in the segment).
    dated = person(db_session, "DateSeule")
    moved(db_session, dated, S.RESPONSE_RECEIVED, at(date(2026, 9, 3)))
    db_session.query(ContactTracking).filter_by(prospect_id=dated.id).update(
        {"appointment_at": at(date(2026, 9, 15))}
    )

    months = {m.month.month: m.appointments for m in monthly_progress(db_session, TODAY)}

    assert months == {4: 0, 5: 0, 6: 0, 7: 1, 8: 0, 9: 2}


def test_history_written_by_the_tracking_service_counts(db_session: Session) -> None:
    prospect = add_prospect(db_session, None, last_name="Service")
    save_contact_tracking(
        db_session, OPERATOR, prospect.id, ContactTrackingInput(status=S.CONTACTED)
    )
    save_contact_tracking(
        db_session, OPERATOR, prospect.id, ContactTrackingInput(status=S.APPOINTMENT_OBTAINED)
    )
    today = datetime.now(UTC)

    month = current_month(db_session, SegmentContext.at(today).today)

    assert (month.contacted, month.appointments) == (1, 1)


# --- next actions -------------------------------------------------------------------------------


def names(group: home.ActionGroup) -> list[str | None]:
    return [item.last_name for item in group.items]


@pytest.mark.usefixtures("cases")
def test_next_actions_on_the_prospection_cases(db_session: Session) -> None:
    actions = next_actions(db_session, CONTEXT)

    # The `due` segment, oldest planned contact first (the opposed and inactive ones never).
    assert names(actions.due) == ["due_past", "due_today"]
    assert actions.due.total == len(EXPECTED[Segment.DUE])
    # Appointments of the coming week, soonest first — today's included.
    assert names(actions.appointments) == ["appointment_date_only", "appointment"]
    # Answered, no appointment yet, not a refusal.
    assert names(actions.responses) == ["answered"]


def test_next_actions_order_limits_and_windows(db_session: Session) -> None:
    company = add_company(db_session, "Transports Exemple SARL")
    for n in range(7):
        prospect = add_prospect(db_session, company, last_name=f"Echu{n}")
        track(db_session, prospect, planned_contact_at=at(TODAY - timedelta(days=n)))
    for key, day, fields in [
        ("Hier", TODAY - timedelta(days=1), {}),
        ("Demain", TODAY + timedelta(days=1), {}),
        ("J6", TODAY + timedelta(days=6), {}),
        ("J7", TODAY + timedelta(days=7), {}),  # the 8th day: out of the window
        ("Opposé", TODAY + timedelta(days=2), block()),
        ("Parti", TODAY + timedelta(days=2), {"activity_status": "inactive"}),
    ]:
        prospect = add_prospect(db_session, company, last_name=f"Rdv{key}", **fields)
        track(db_session, prospect, S.APPOINTMENT_OBTAINED, appointment_at=at(day, 0))
    for key, response in [("Recente", at(TODAY)), ("Ancienne", at(TODAY - timedelta(days=5)))]:
        prospect = add_prospect(db_session, company, last_name=f"Reponse{key}")
        track(db_session, prospect, S.FOLLOW_UP_1, response_received_at=response)
    track(
        db_session,
        add_prospect(db_session, company, last_name="ReponseSansDate"),
        S.RESPONSE_RECEIVED,
    )
    track(db_session, add_prospect(db_session, company, last_name="Refus"), S.NOT_INTERESTED)

    actions = next_actions(db_session, CONTEXT)

    assert names(actions.due) == [f"Echu{n}" for n in (6, 5, 4, 3, 2)]
    assert actions.due.total == 7
    assert names(actions.appointments) == ["RdvDemain", "RdvJ6"]
    assert actions.appointments.total == 2
    assert names(actions.responses) == ["ReponseAncienne", "ReponseRecente", "ReponseSansDate"]
    item = actions.due.items[0]
    assert (item.company_name, item.tracking_status, item.at) == (
        "Transports Exemple SARL",
        S.TO_CONTACT,
        at(TODAY - timedelta(days=6)),
    )


# --- recent activity ----------------------------------------------------------------------------


def test_recent_edits_group_one_save_and_leave_values_out(db_session: Session) -> None:
    company = add_company(db_session, "Transports Exemple SARL")
    other = add_company(db_session, "Nouvel Employeur SAS")
    prospect = add_prospect(db_session, company, first_name="Jean", last_name="Témoin")
    add_email(db_session, prospect, "jean.temoin@exemple.example", is_primary=True)
    # An import's writes are in the import history, not in the edits feed.
    import_actor = ActorContext(type=ActorType.IMPORT, display="Import test.xlsx", id="batch")
    save_contact_tracking(
        db_session, import_actor, prospect.id, ContactTrackingInput(status=S.TO_CONTACT)
    )
    bind_operator(db_session)

    save_contact_tracking(
        db_session, OPERATOR, prospect.id, ContactTrackingInput(status=S.CONTACTED)
    )
    audit.annotate(db_session, OPERATOR, company)
    company.display_name = "Transports Exemple Renommée SARL"
    db_session.flush()
    prospect_service.change_company(db_session, OPERATOR, prospect.id, other.id)
    prospect_service.mark_do_not_contact(db_session, OPERATOR, prospect.id, reason="Demande écrite")

    edits = home.recent_edits(db_session)

    assert [(e.subject_type, e.subject_label) for e in edits] == [
        ("prospect", "Jean Témoin"),
        ("company", "Transports Exemple Renommée SARL"),
        ("prospect", "Jean Témoin"),
    ]
    latest, renamed, tracked = edits
    assert [a.action for a in latest.actions][:1] == ["prospect.company_changed"]
    assert "prospect.do_not_contact.set" in [a.action for a in latest.actions]
    assert (renamed.actions[0].action, renamed.actor_display) == (
        "company.updated",
        "Opératrice Test",
    )
    (status,) = tracked.actions
    assert (status.action, status.status_before, status.status_after) == (
        "contact_tracking.status_changed",
        S.TO_CONTACT,
        S.CONTACTED,
    )
    assert latest.source is audit.AuditSource.UI
    serialized = json.dumps([str(edit) for edit in edits])
    for value in ("jean.temoin@exemple.example", "Demande écrite", "before_label"):
        assert value not in serialized


def test_recent_edits_keep_a_deleted_subject_unnamed(db_session: Session) -> None:
    bind_operator(db_session)
    prospect = add_prospect(db_session, None, first_name="Éphémère", last_name="Test")
    db_session.delete(prospect)
    db_session.flush()

    (edit,) = home.recent_edits(db_session)

    assert edit.subject_label is None
    assert [a.action for a in edit.actions] == ["prospect.created", "prospect.deleted"]


def test_recent_imports_are_the_latest_batches(db_session: Session) -> None:
    for n in range(7):
        db_session.add(
            ImportBatch(
                filename=f"base_{n}.xlsx",
                status=ImportBatchStatus.FAILED,
                actor_type=ActorType.HUMAN,
                actor_display="Opératrice Test",
                created_at=datetime(2026, 9, 1 + n, tzinfo=UTC),
            )
        )
    db_session.flush()

    imports = home_summary(db_session, CONTEXT).recent_imports

    assert [batch.filename for batch in imports] == [f"base_{n}.xlsx" for n in (6, 5, 4, 3, 2)]


# --- cost -----------------------------------------------------------------------------------------


@pytest.mark.parametrize("size", [3, 60])
def test_statement_count_does_not_grow_with_rows(db_session: Session, size: int) -> None:
    random_base(db_session, seed=12, size=size)
    bind_operator(db_session)
    for prospect in db_session.query(Prospect).limit(size):
        prospect.exact_job_title = "Poste modifié"
    db_session.flush()
    db_session.expunge_all()

    with statements(db_session) as executed:
        home_summary(db_session, CONTEXT)

    # Segments, companies + stages, months, 3 action groups, imports, edits, subject names.
    assert len(executed) == 9
