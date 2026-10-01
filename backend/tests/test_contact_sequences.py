"""Cohorts, sequences, « max relances » and quality alerts (sequences rework D1-D9), service level:
cohort codes and dates, a change of cohort opens a new sequence and keeps the history, the level
and the next due date agree between Python and SQL, alerts never change a state, and the AI (an
agent) only raises alerts."""

import random
import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import (
    AppSetting,
    ContactMessage,
    ContactSequence,
    ContactTracking,
    Prospect,
)
from app.models.enums import (
    ContactMessageStatus,
    ContactMessageStep,
    ContactTrackingStatus,
    QualityAlertSource,
    QualityAlertType,
    SequenceEndReason,
)
from app.services import (
    app_settings,
    cohorts,
    contact_messages,
    contact_sequences,
    contact_tracking,
    prospects,
    quality_alerts,
)
from app.services.contact_messages import MessageEdit
from app.services.contact_sequences import (
    join_sequence_sources,
    next_due_at_sql,
    prospect_sequence,
)
from app.services.contact_workflow import PauseReason
from app.services.errors import (
    ActorNotAllowedError,
    BusinessRuleError,
    DuplicateValueError,
    InUseError,
    InvalidFieldError,
    NotFoundError,
    TrackingRuleError,
)
from tests.builders import (
    OPERATOR,
    add_cohort,
    add_company,
    add_email,
    add_prospect,
    add_send,
    audit_events,
    rejected,
    start_sequence,
)

S = ContactTrackingStatus
T = QualityAlertType
AGENT = ActorContext(type=ActorType.AGENT, display="Agent de qualification (test)", id="agent.t")
IMPORTER = ActorContext(type=ActorType.IMPORT, display="Import test.xlsx", id="batch-1")
SYSTEM = ActorContext(type=ActorType.SYSTEM, display="Job test", id="job-1")
S39 = date(2026, 9, 28)


def prospect_in(session: Session, code: str = "S39", day: date | None = S39) -> Prospect:
    prospect = add_prospect(session, add_company(session))
    add_email(session, prospect, "jean.test@exemple.example", is_primary=True)
    start_sequence(session, prospect, add_cohort(session, code, day))
    return prospect


# --- cohorts -------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "code"),
    [("S37", "S37"), (" s 37 ", "S37"), ("Sem 037", "S37"), ("semaine 4", "S4"), ("S0", "S0")],
)
def test_cohort_codes_are_normalized(raw: str, code: str) -> None:
    assert cohorts.normalize_code(raw) == code


@pytest.mark.parametrize("raw", ["37", "retraité", "S", "S37 2026", "W37", ""])
def test_other_values_are_not_cohort_codes(raw: str) -> None:
    assert cohorts.normalize_code(raw) is None


def test_s0_exists_out_of_campaign_and_is_fixed(db_session: Session) -> None:
    s0 = cohorts.find_by_code(db_session, "s0")
    assert s0 is not None and (s0.starts_on, s0.out_of_campaign) == (None, True)

    with pytest.raises(BusinessRuleError) as renamed:
        cohorts.update_cohort(db_session, OPERATOR, s0.id, code="S1")
    with pytest.raises(BusinessRuleError) as deleted:
        cohorts.delete_cohort(db_session, OPERATOR, s0.id)
    assert {renamed.value.code, deleted.value.code} == {"cohort_s0_fixed"}


def test_a_cohort_has_its_real_date_entered_by_a_person(db_session: Session) -> None:
    cohort = cohorts.create_cohort(db_session, OPERATOR, "s 39", S39)

    assert (cohort.code, cohort.starts_on, cohort.needs_review) == ("S39", S39, False)
    with pytest.raises(InvalidFieldError) as no_date:
        cohorts.create_cohort(db_session, OPERATOR, "S40", None)
    with pytest.raises(InvalidFieldError) as bad_code:
        cohorts.create_cohort(db_session, OPERATOR, "retraité", S39)
    with pytest.raises(DuplicateValueError) as duplicate:
        cohorts.create_cohort(db_session, OPERATOR, "S039", S39 + timedelta(days=7))
    with pytest.raises(ActorNotAllowedError):
        cohorts.create_cohort(db_session, AGENT, "S41", S39)
    assert (no_date.value.reason, bad_code.value.reason) == ("required", "cohort_code")
    assert duplicate.value.existing is not None and duplicate.value.existing.id == cohort.id
    [event] = audit_events(db_session, action="cohort.created")
    assert event.changes["code"] == {"before": None, "after": "S39"}


def test_confirming_a_migrated_cohort_clears_its_review_flag(db_session: Session) -> None:
    cohort = add_cohort(db_session, "S41", date(2026, 10, 5))
    cohort.needs_review = True
    db_session.flush()

    cohorts.update_cohort(db_session, OPERATOR, cohort.id, starts_on=date(2026, 10, 6))

    assert (cohort.starts_on, cohort.needs_review) == (date(2026, 10, 6), False)


def test_a_used_cohort_cannot_be_deleted(db_session: Session) -> None:
    prospect_in(db_session, "S39")
    used = cohorts.find_by_code(db_session, "S39")
    unused = add_cohort(db_session, "S50", date(2026, 12, 7))
    assert used is not None

    with pytest.raises(InUseError) as refused:
        cohorts.delete_cohort(db_session, OPERATOR, used.id)
    cohorts.delete_cohort(db_session, OPERATOR, unused.id)

    assert refused.value.usage == {"sequences": 1}
    views = {view.code: view for view in cohorts.list_cohorts(db_session)}
    assert (views["S39"].current_count, views["S39"].sequence_count) == (1, 1)
    assert next(iter(views)) == "S0"
    assert "S50" not in views


def test_the_database_keeps_codes_and_dates_consistent(db_session: Session) -> None:
    cohort = add_cohort(db_session, "S41", date(2026, 10, 5))
    with rejected(db_session, "ck_cohorts_code_format"):
        cohort.code = "s41"
    db_session.refresh(cohort)
    with rejected(db_session, "ck_cohorts_date_unless_s0"):
        cohort.starts_on = None


# --- change of cohort ----------------------------------------------------------------------------


def test_changing_the_cohort_opens_a_new_sequence_and_keeps_the_history(
    db_session: Session,
) -> None:
    prospect = prospect_in(db_session, "S39")
    contact_messages.mark_sent(
        db_session, OPERATOR, prospect.id, sent_at=datetime(2026, 9, 28, 9, tzinfo=UTC)
    )
    draft = contact_messages.save_message(
        db_session, OPERATOR, prospect.id, ContactMessageStep.R1, MessageEdit(subject="R1")
    ).message
    s41 = add_cohort(db_session, "S41", date(2026, 10, 5))
    before = prospect_sequence(db_session, prospect.id)
    assert (before.progress.sent_count, before.progress.level_label) == (1, "R1")

    change = contact_sequences.change_cohort(db_session, OPERATOR, prospect.id, s41.id)

    after = prospect_sequence(db_session, prospect.id)
    assert change.changed and change.sequence is not None
    assert (change.messages.cancelled, draft.status) == (1, ContactMessageStatus.CANCELLED)
    assert draft.cancel_reason == "sequence_closed"
    assert after.cohort is not None and after.cohort.code == "S41"
    assert (after.progress.sent_count, after.progress.level_label) == (0, "Contact")
    history = contact_sequences.sequence_history(db_session, prospect.id)
    assert [(view.cohort.code, view.is_current, view.end_reason) for view in history] == [
        ("S41", True, None),
        ("S39", False, SequenceEndReason.COHORT_CHANGED),
    ]
    assert [message.step for message in history[1].messages] == ["contact", "r1"]
    assert history[1].sent_count == 1
    actions = [event.action for event in audit_events(db_session, entity_type="contact_sequence")]
    assert actions == ["contact_sequence.closed", "contact_sequence.created"]


def test_choosing_the_same_cohort_changes_nothing(db_session: Session) -> None:
    prospect = prospect_in(db_session, "S39")
    s39 = cohorts.find_by_code(db_session, "S39")
    assert s39 is not None

    change = contact_sequences.change_cohort(db_session, OPERATOR, prospect.id, s39.id)

    assert not change.changed
    assert audit_events(db_session, entity_type="contact_sequence") == []


def test_removing_the_cohort_leaves_the_prospect_unvalidated(db_session: Session) -> None:
    prospect = prospect_in(db_session, "S39")

    change = contact_sequences.change_cohort(db_session, OPERATOR, prospect.id, None)

    place = prospect_sequence(db_session, prospect.id)
    assert (change.changed, change.sequence, place.cohort) == (True, None, None)
    assert place.progress.pause is PauseReason.NO_COHORT
    [former] = contact_sequences.sequence_history(db_session, prospect.id)
    assert (former.is_current, former.end_reason) == (False, SequenceEndReason.COHORT_REMOVED)


def test_a_completed_sequence_restarts_with_its_own_cohort(db_session: Session) -> None:
    prospect = prospect_in(db_session, "S39")
    sequence = contact_sequences.current_sequence(db_session, prospect.id)
    assert sequence is not None
    sequence.closed_at = datetime(2026, 10, 1, tzinfo=UTC)
    sequence.end_reason = SequenceEndReason.COMPLETED
    db_session.flush()
    assert prospect_sequence(db_session, prospect.id).progress.finished

    change = contact_sequences.change_cohort(db_session, OPERATOR, prospect.id, sequence.cohort_id)

    assert change.changed and change.sequence is not None and change.sequence.is_open
    assert not prospect_sequence(db_session, prospect.id).progress.finished
    assert sequence.end_reason is SequenceEndReason.COMPLETED  # its own end is kept


@pytest.mark.parametrize("actor", [AGENT, IMPORTER, SYSTEM])
def test_only_a_person_changes_a_cohort(db_session: Session, actor: ActorContext) -> None:
    prospect = prospect_in(db_session)
    s41 = add_cohort(db_session, "S41", date(2026, 10, 5))

    with pytest.raises(ActorNotAllowedError):
        contact_sequences.change_cohort(db_session, actor, prospect.id, s41.id)


def history_rows(db_session: Session, prospect: Prospect) -> list[tuple[str | None, str]]:
    tracking = db_session.scalar(
        select(ContactTracking).where(ContactTracking.prospect_id == prospect.id)
    )
    assert tracking is not None
    return [(row.from_status, row.to_status) for row in tracking.status_history]


@pytest.mark.parametrize("state", [S.DISQUALIFIED, S.RESPONSE_RECEIVED, S.APPOINTMENT_OBTAINED])
@pytest.mark.parametrize("code", ["S41", "S0"])
def test_a_new_cohort_resumes_the_prospect_in_sequence(
    db_session: Session, state: ContactTrackingStatus, code: str
) -> None:
    prospect = prospect_in(db_session, "S39")
    contact_tracking.save_contact_tracking(
        db_session, OPERATOR, prospect.id, contact_tracking.ContactTrackingInput(status=state)
    )
    target = add_cohort(db_session, code, date(2026, 10, 5))

    change = contact_sequences.change_cohort(db_session, OPERATOR, prospect.id, target.id)

    assert (change.changed, change.resumed_from) == (True, state)
    tracking = db_session.scalar(
        select(ContactTracking).where(ContactTracking.prospect_id == prospect.id)
    )
    assert tracking is not None and tracking.status is S.NEUTRAL
    # The history is appended, never rewritten: the person's choice, then the resumption.
    assert history_rows(db_session, prospect) == [(None, state), (state, "neutral")]
    [event] = audit_events(db_session, action="contact_tracking.status_changed")
    assert event.changes["status"] == {"before": state.value, "after": "neutral"}
    assert event.context["reason"] == contact_sequences.RESUMED_REASON
    assert event.actor_type == ActorType.HUMAN
    place = prospect_sequence(db_session, prospect.id)
    expected = PauseReason.OUT_OF_CAMPAIGN if code == "S0" else None
    assert place.progress.pause is expected


def test_removing_the_cohort_keeps_the_state(db_session: Session) -> None:
    prospect = prospect_in(db_session, "S39")
    contact_tracking.save_contact_tracking(
        db_session, OPERATOR, prospect.id, contact_tracking.ContactTrackingInput(S.DISQUALIFIED)
    )

    change = contact_sequences.change_cohort(db_session, OPERATOR, prospect.id, None)

    assert (change.changed, change.resumed_from) == (True, None)
    assert history_rows(db_session, prospect) == [(None, "disqualified")]


def test_an_ignored_or_opposed_prospect_is_not_resumed_by_a_cohort_change(
    db_session: Session,
) -> None:
    ignored = prospect_in(db_session, "S39")
    contact_tracking.save_contact_tracking(
        db_session, OPERATOR, ignored.id, contact_tracking.ContactTrackingInput(S.IGNORED)
    )
    opposed = prospect_in(db_session, "S39")
    prospects.mark_do_not_contact(db_session, OPERATOR, opposed.id, reason="Demande (test)")
    s41 = add_cohort(db_session, "S41", date(2026, 10, 5))
    s0 = add_cohort(db_session, "S0")

    for target in (s41.id, s0.id, None):
        with pytest.raises(TrackingRuleError) as terminal:
            contact_sequences.change_cohort(db_session, OPERATOR, ignored.id, target)
        assert terminal.value.code == "ignored_is_terminal"
        with pytest.raises(BusinessRuleError) as opposition:
            contact_sequences.change_cohort(db_session, OPERATOR, opposed.id, target)
        assert opposition.value.code == "prospect_do_not_contact"
    for prospect in (ignored, opposed):
        place = prospect_sequence(db_session, prospect.id)
        assert place.cohort is not None and place.cohort.code == "S39"
    assert audit_events(db_session, action="contact_sequence.closed") == []
    # Once the opposition is cleared through its own path, the cohort may change.
    prospects.clear_do_not_contact(db_session, OPERATOR, opposed.id, reason="Accord (test)")
    assert contact_sequences.change_cohort(db_session, OPERATOR, opposed.id, s41.id).changed


def test_unknown_prospect_or_cohort(db_session: Session) -> None:
    prospect = prospect_in(db_session)
    with pytest.raises(NotFoundError):
        contact_sequences.change_cohort(db_session, OPERATOR, uuid.uuid4(), None)
    with pytest.raises(NotFoundError):
        contact_sequences.change_cohort(db_session, OPERATOR, prospect.id, uuid.uuid4())


def test_the_database_allows_one_current_and_one_open_sequence(db_session: Session) -> None:
    prospect = prospect_in(db_session)
    s41 = add_cohort(db_session, "S41", date(2026, 10, 5))
    with rejected(db_session, "uq_contact_sequences_current"):
        db_session.add(ContactSequence(prospect_id=prospect.id, cohort_id=s41.id))
    with rejected(db_session, "ck_contact_sequences_open_is_current"):
        db_session.add(ContactSequence(prospect_id=prospect.id, cohort_id=s41.id, is_current=False))
    with rejected(db_session, "ck_contact_sequences_closed_has_reason"):
        db_session.add(
            ContactSequence(
                prospect_id=prospect.id,
                cohort_id=s41.id,
                is_current=False,
                closed_at=datetime(2026, 10, 1, tzinfo=UTC),
            )
        )


def test_a_message_belongs_to_a_sequence_of_its_prospect(db_session: Session) -> None:
    prospect = prospect_in(db_session)
    other = prospect_in(db_session, "S40", date(2026, 10, 5))
    sequence = contact_sequences.current_sequence(db_session, other.id)
    assert sequence is not None

    with rejected(db_session, "fk_contact_messages_sequence"):
        db_session.add(ContactMessage(prospect_id=prospect.id, sequence_id=sequence.id, rank=0))


# --- « max relances » ----------------------------------------------------------------------------


def test_max_follow_ups_defaults_to_four_and_is_set_by_a_person(db_session: Session) -> None:
    assert app_settings.max_follow_ups(db_session) == 4

    assert app_settings.set_max_follow_ups(db_session, OPERATOR, 2) == 2
    app_settings.set_max_follow_ups(db_session, OPERATOR, 2)  # unchanged: no event
    app_settings.set_max_follow_ups(db_session, OPERATOR, 3)

    assert app_settings.max_follow_ups(db_session) == 3
    with pytest.raises(InvalidFieldError) as out_of_range:
        app_settings.set_max_follow_ups(db_session, OPERATOR, 21)
    with pytest.raises(ActorNotAllowedError):
        app_settings.set_max_follow_ups(db_session, AGENT, 5)
    assert out_of_range.value.reason == "out_of_range"
    actions = [event.action for event in audit_events(db_session, entity_type="app_setting")]
    assert actions == ["app_setting.created", "app_setting.updated"]


def test_the_level_finishes_after_the_maximum(db_session: Session) -> None:
    prospect = prospect_in(db_session)
    sequence = contact_sequences.current_sequence(db_session, prospect.id)
    assert sequence is not None
    for rank in range(3):
        add_send(
            db_session, sequence, rank, datetime(2026, 9, 28, tzinfo=UTC) + timedelta(weeks=rank)
        )

    assert prospect_sequence(db_session, prospect.id).progress.level_label == "R3"
    app_settings.set_max_follow_ups(db_session, OPERATOR, 2)
    finished = prospect_sequence(db_session, prospect.id).progress
    assert (finished.finished, finished.level_label, finished.next_due_at) == (
        True,
        "Relance terminée",
        None,
    )


# --- quality alerts ------------------------------------------------------------------------------


def alert(
    session: Session,
    actor: ActorContext,
    prospect: Prospect,
    kind: QualityAlertType = T.EMAIL_ERROR,
) -> uuid.UUID:
    return quality_alerts.raise_alert(
        session, actor, quality_alerts.AlertInput(kind, prospect_id=prospect.id)
    ).id


def test_an_email_error_pauses_the_sequence_and_keeps_cohort_state_and_level(
    db_session: Session,
) -> None:
    prospect = prospect_in(db_session)
    db_session.add(ContactTracking(prospect_id=prospect.id, status=S.NEUTRAL))
    db_session.flush()
    before = prospect_sequence(db_session, prospect.id)

    alert_id = alert(db_session, OPERATOR, prospect)

    paused = prospect_sequence(db_session, prospect.id)
    assert (paused.email_error, paused.progress.pause) == (True, PauseReason.EMAIL_ERROR)
    assert paused.progress.next_due_at is None
    assert (paused.cohort, paused.progress.level_label) == (
        before.cohort,
        before.progress.level_label,
    )
    tracking = db_session.scalars(select(ContactTracking)).one()
    assert tracking.status is S.NEUTRAL  # never a state change
    quality_alerts.resolve_alert(db_session, OPERATOR, alert_id, note="Nouvelle adresse trouvée")
    assert (
        prospect_sequence(db_session, prospect.id).progress.next_due_at
        == before.progress.next_due_at
    )


def test_the_ai_only_proposes_an_alert(db_session: Session) -> None:
    prospect = prospect_in(db_session)

    proposal = quality_alerts.raise_alert(
        db_session, AGENT, quality_alerts.AlertInput(T.EMAIL_ERROR, prospect_id=prospect.id)
    )

    assert (proposal.source, proposal.raised_by_type) == (QualityAlertSource.AI, ActorType.AGENT)
    # A proposal takes nothing out of the automatic actions; a person confirms by raising hers.
    assert prospect_sequence(db_session, prospect.id).progress.pause is None
    with pytest.raises(ActorNotAllowedError):
        quality_alerts.resolve_alert(db_session, AGENT, proposal.id)
    # The AI never changes a cohort, a state or a sequence.
    with pytest.raises(ActorNotAllowedError):
        contact_sequences.change_cohort(db_session, AGENT, prospect.id, None)
    from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking

    with pytest.raises(ActorNotAllowedError):
        save_contact_tracking(db_session, AGENT, prospect.id, ContactTrackingInput(S.DISQUALIFIED))
    with pytest.raises(ActorNotAllowedError):
        quality_alerts.raise_alert(
            db_session, SYSTEM, quality_alerts.AlertInput(T.EMAIL_ERROR, prospect_id=prospect.id)
        )


def test_one_open_email_error_per_source(db_session: Session) -> None:
    prospect = prospect_in(db_session)
    first = alert(db_session, OPERATOR, prospect)
    alert(db_session, AGENT, prospect)  # the AI's proposal is another source

    with pytest.raises(BusinessRuleError) as refused:
        alert(db_session, OPERATOR, prospect)
    assert (refused.value.code, refused.value.details["alert_id"]) == ("alert_exists", str(first))
    quality_alerts.resolve_alert(db_session, OPERATOR, first)
    alert(db_session, OPERATOR, prospect)  # a new error after the first was resolved
    with pytest.raises(BusinessRuleError) as resolved:
        quality_alerts.resolve_alert(db_session, OPERATOR, first)
    assert resolved.value.code == "alert_resolved"


def test_alert_subjects_and_types(db_session: Session) -> None:
    prospect = prospect_in(db_session)
    company = add_company(db_session, "Entreprise Alerte SAS")

    on_company = quality_alerts.raise_alert(
        db_session,
        IMPORTER,
        quality_alerts.AlertInput(
            T.IMPORT_CONFLICT, company_id=company.id, detail={"field": "siren"}
        ),
    )
    with pytest.raises(InvalidFieldError) as wrong_subject:
        quality_alerts.raise_alert(
            db_session, OPERATOR, quality_alerts.AlertInput(T.EMAIL_ERROR, company_id=company.id)
        )
    with pytest.raises(InvalidFieldError) as company_only:
        alert(db_session, OPERATOR, prospect, T.COMPANY_TO_CHECK)
    with pytest.raises(InvalidFieldError) as both:
        quality_alerts.raise_alert(
            db_session,
            OPERATOR,
            quality_alerts.AlertInput(
                T.DATA_INCONSISTENT, prospect_id=prospect.id, company_id=company.id
            ),
        )

    assert on_company.source is QualityAlertSource.IMPORT
    assert (wrong_subject.value.reason, company_only.value.reason) == ("subject_type",) * 2
    assert both.value.reason == "subject"
    [event] = audit_events(db_session, action="quality_alert.created")
    assert (event.subject_type, event.subject_id) == ("company", company.id)
    assert event.changes["detail"]["after"] == "[masked]"
    page = quality_alerts.list_alerts(
        db_session, quality_alerts.AlertFilters(company_id=company.id)
    )
    assert [item.id for item in page.items] == [on_company.id] and page.total == 1


# --- Python and SQL agree ------------------------------------------------------------------------


def test_the_sql_next_due_date_is_the_python_one(db_session: Session) -> None:
    rng = random.Random(10)
    s0 = cohorts.find_by_code(db_session, "S0")
    assert s0 is not None
    prospects = []
    for n in range(40):
        prospect = add_prospect(db_session, None, last_name=f"Parite{n}")
        prospects.append(prospect)
        if rng.random() < 0.6:
            db_session.add(
                ContactTracking(
                    prospect_id=prospect.id,
                    status=rng.choice([S.NEUTRAL, S.NEUTRAL, S.RESPONSE_RECEIVED, S.DISQUALIFIED]),
                )
            )
        if rng.random() < 0.15:
            continue
        start = date(2026, 8, 3) + timedelta(days=rng.randrange(0, 60))
        cohort = s0 if rng.random() < 0.1 else add_cohort(db_session, f"S{n + 100}", start)
        sequence = start_sequence(db_session, prospect, cohort)
        sends = rng.randrange(0, 7)
        for rank in range(sends):
            moment = datetime(start.year, start.month, start.day, 9, tzinfo=UTC)
            add_send(
                db_session, sequence, rank, moment + timedelta(days=rank * 6 + rng.randrange(3))
            )
        if rng.random() < 0.1:
            sequence.closed_at = datetime(2026, 10, 1, tzinfo=UTC)
            sequence.end_reason = SequenceEndReason.COMPLETED
        if rng.random() < 0.15:
            alert(db_session, rng.choice([OPERATOR, AGENT]), prospect)
    db_session.add(AppSetting(key="contact.max_follow_ups", value=3))
    db_session.flush()

    statement = join_sequence_sources(
        select(Prospect.id, next_due_at_sql())
        .select_from(Prospect)
        .outerjoin(ContactTracking, ContactTracking.prospect_id == Prospect.id)
    )
    rows = {prospect_id: due for prospect_id, due in db_session.execute(statement).tuples()}

    for prospect in prospects:
        expected = prospect_sequence(db_session, prospect.id).progress.next_due_at
        assert rows[prospect.id] == expected, prospect.last_name
    assert any(value is not None for value in rows.values())
