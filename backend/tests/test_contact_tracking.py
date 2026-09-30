"""Contact tracking: one current row per prospect, response/appointment fields, status history."""

import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import ContactTracking, ContactTrackingStatusHistory, InternalReferent
from app.models.enums import ContactabilityStatus, ContactTrackingStatus
from app.services import contact_tracking as contact_tracking_service
from app.services import prospects as prospect_service
from app.services.contact_tracking import (
    IGNORED_REASON,
    ContactTrackingInput,
    save_contact_tracking,
)
from app.services.errors import ActorNotAllowedError, TrackingRuleError
from tests.builders import OPERATOR, add_prospect, audit_events

S = ContactTrackingStatus

PLANNED = datetime(2026, 9, 14, 9, 0, tzinfo=UTC)
RESPONSE = datetime(2026, 9, 16, 15, 30, tzinfo=UTC)
APPOINTMENT = datetime(2026, 9, 23, 10, 0, tzinfo=UTC)


def history(session: Session, tracking: ContactTracking) -> list[tuple[str | None, str]]:
    rows = session.execute(
        select(ContactTrackingStatusHistory.from_status, ContactTrackingStatusHistory.to_status)
        .where(ContactTrackingStatusHistory.contact_tracking_id == tracking.id)
        .order_by(ContactTrackingStatusHistory.changed_at)
    )
    return [(from_status, to_status) for from_status, to_status in rows]


def test_tracking_lifecycle_keeps_one_row_and_records_transitions(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    referent = InternalReferent(first_name="Claire", last_name="Référente")
    db_session.add(referent)
    db_session.flush()

    save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(status=ContactTrackingStatus.NEUTRAL, planned_contact_at=PLANNED),
    )
    save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(
            status=ContactTrackingStatus.RESPONSE_RECEIVED,
            planned_contact_at=PLANNED,
            response_received_at=RESPONSE,
        ),
    )
    tracking = save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(
            status=ContactTrackingStatus.APPOINTMENT_OBTAINED,
            planned_contact_at=PLANNED,
            response_received_at=RESPONSE,
            appointment_at=APPOINTMENT,
            referent_id=referent.id,
        ),
    )
    db_session.expire_all()

    assert db_session.execute(select(func.count()).select_from(ContactTracking)).scalar_one() == 1
    assert tracking.status is ContactTrackingStatus.APPOINTMENT_OBTAINED
    assert tracking.planned_contact_at == PLANNED
    assert tracking.response_received_at == RESPONSE
    assert tracking.appointment_at == APPOINTMENT
    assert tracking.referent_id == referent.id
    assert history(db_session, tracking) == [
        (None, "neutral"),
        ("neutral", "response_received"),
        ("response_received", "appointment_obtained"),
    ]


def test_history_snapshots_the_actor(db_session: Session) -> None:
    prospect = add_prospect(db_session)

    tracking = save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(status=ContactTrackingStatus.CONTACTED),
    )

    [entry] = tracking.status_history
    assert (entry.actor_type, entry.actor_id, entry.actor_display) == (
        OPERATOR.type,
        OPERATOR.id,
        OPERATOR.display,
    )
    assert entry.changed_at is not None


def test_saving_the_same_status_adds_no_history(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    first = ContactTrackingInput(status=ContactTrackingStatus.CONTACTED)
    save_contact_tracking(db_session, OPERATOR, prospect.id, first)

    tracking = save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(status=ContactTrackingStatus.CONTACTED, planned_contact_at=PLANNED),
    )

    assert tracking.planned_contact_at == PLANNED
    assert history(db_session, tracking) == [(None, "contacted")]


def test_tracking_changes_are_audited_by_kind(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    first = ContactTrackingInput(status=ContactTrackingStatus.NEUTRAL, planned_contact_at=PLANNED)

    tracking = save_contact_tracking(db_session, OPERATOR, prospect.id, first)
    save_contact_tracking(db_session, OPERATOR, prospect.id, first)
    save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(
            status=ContactTrackingStatus.RESPONSE_RECEIVED,
            planned_contact_at=PLANNED,
            response_received_at=RESPONSE,
        ),
    )
    save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(
            status=ContactTrackingStatus.RESPONSE_RECEIVED,
            response_received_at=RESPONSE,
            appointment_at=APPOINTMENT,
        ),
    )

    created, moved, dated = audit_events(db_session)
    assert (created.action, created.entity_id) == ("contact_tracking.created", tracking.id)
    assert created.changes["status"] == {"before": None, "after": "neutral"}
    assert created.changes["planned_contact_at"] == {"before": None, "after": PLANNED.isoformat()}
    assert created.changes["prospect_id"] == {"before": None, "after": str(prospect.id)}
    assert moved.action == "contact_tracking.status_changed"
    # A state without a default next action clears the echoed one (Contact rule).
    assert moved.changes == {
        "status": {"before": "neutral", "after": "response_received"},
        "planned_contact_at": {"before": PLANNED.isoformat(), "after": None},
        "response_received_at": {"before": None, "after": RESPONSE.isoformat()},
    }
    assert dated.action == "contact_tracking.updated"
    assert dated.changes == {"appointment_at": {"before": None, "after": APPOINTMENT.isoformat()}}
    for entry in (created, moved, dated):
        assert (entry.subject_type, entry.subject_id) == ("prospect", prospect.id)


# --- Contact rules (reference: tests/contactTrackingService.test.ts) ----------------------------

IMPORTER = ActorContext(type=ActorType.IMPORT, display="Import test.xlsx", id="batch-1")
AGENT = ActorContext(type=ActorType.AGENT, display="Agent test", id="agent-1")


def put(session: Session, prospect_id: uuid.UUID, status: S, **fields: Any) -> ContactTracking:
    return save_contact_tracking(
        session, OPERATOR, prospect_id, ContactTrackingInput(status=status, **fields)
    )


def test_any_state_may_be_chosen_by_hand_back_to_neutral_included(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    for state in (S.CONTACTED, S.R2, S.NEUTRAL, S.FAILURE, S.R1, S.APPOINTMENT_OBTAINED):
        put(db_session, prospect.id, state)

    tracking = put(db_session, prospect.id, S.CONTACTED)

    assert tracking.status is S.CONTACTED
    assert len(history(db_session, tracking)) == 7


def test_an_agent_never_chooses_a_state_but_imports_and_system_jobs_may(
    db_session: Session,
) -> None:
    prospect = add_prospect(db_session)
    save_contact_tracking(db_session, IMPORTER, prospect.id, ContactTrackingInput(S.CONTACTED))

    with pytest.raises(ActorNotAllowedError):
        save_contact_tracking(db_session, AGENT, prospect.id, ContactTrackingInput(S.R1))
    # Dates only: not a state change, allowed.
    tracking = save_contact_tracking(
        db_session,
        AGENT,
        prospect.id,
        ContactTrackingInput(S.CONTACTED, planned_contact_at=PLANNED),
    )
    assert (tracking.status, tracking.planned_contact_at) == (S.CONTACTED, PLANNED)


def test_sequence_states_keep_the_week_the_others_clear_an_echoed_one(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    put(db_session, prospect.id, S.NEUTRAL, planned_contact_at=PLANNED)
    for state in (S.CONTACTED, S.R1, S.R2):
        assert put(db_session, prospect.id, state, planned_contact_at=PLANNED).planned_contact_at
    for state in (S.RESPONSE_RECEIVED, S.APPOINTMENT_OBTAINED, S.FAILURE):
        put(db_session, prospect.id, S.R2, planned_contact_at=PLANNED)
        tracking = put(db_session, prospect.id, state, planned_contact_at=PLANNED)
        assert tracking.planned_contact_at is None, state
        # A person may set a week again afterwards (the state stays).
        tracking = put(db_session, prospect.id, state, planned_contact_at=PLANNED)
        assert (tracking.status, tracking.planned_contact_at) == (state, PLANNED)


def test_an_explicit_new_week_with_the_state_change_is_kept(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    put(db_session, prospect.id, S.R2, planned_contact_at=PLANNED)

    tracking = put(db_session, prospect.id, S.FAILURE, planned_contact_at=APPOINTMENT)

    assert tracking.planned_contact_at == APPOINTMENT


def test_response_received_dates_the_response_once(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    before = datetime.now(UTC)

    tracking = put(db_session, prospect.id, S.RESPONSE_RECEIVED)
    stamped = tracking.response_received_at
    assert stamped is not None and stamped >= before
    put(db_session, prospect.id, S.R1, response_received_at=stamped)
    tracking = put(db_session, prospect.id, S.RESPONSE_RECEIVED, response_received_at=stamped)
    assert tracking.response_received_at == stamped
    # A given date is kept.
    other = add_prospect(db_session, last_name="Datee")
    dated = put(db_session, other.id, S.RESPONSE_RECEIVED, response_received_at=RESPONSE)
    assert dated.response_received_at == RESPONSE


def test_ignored_reinforces_do_not_contact_clears_the_week_and_is_terminal(
    db_session: Session,
) -> None:
    prospect = add_prospect(db_session)
    put(db_session, prospect.id, S.R1, planned_contact_at=PLANNED)

    tracking = put(db_session, prospect.id, S.IGNORED, planned_contact_at=PLANNED)

    assert (tracking.status, tracking.planned_contact_at) == (S.IGNORED, None)
    assert prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT
    assert prospect.do_not_contact_reason == IGNORED_REASON
    events = audit_events(db_session, action="prospect.do_not_contact.set")
    assert [(e.actor_id, e.context["reason"]) for e in events] == [(OPERATOR.id, IGNORED_REASON)]
    for state in (S.NEUTRAL, S.CONTACTED, S.RESPONSE_RECEIVED):
        with pytest.raises(TrackingRuleError) as refused:
            put(db_session, prospect.id, state)
        assert refused.value.code == "ignored_is_terminal"
    # Not even an import: a re-import never reactivates it.
    with pytest.raises(TrackingRuleError):
        save_contact_tracking(db_session, IMPORTER, prospect.id, ContactTrackingInput(S.NEUTRAL))
    with pytest.raises(TrackingRuleError) as refused:
        put(db_session, prospect.id, S.IGNORED, planned_contact_at=PLANNED)
    assert refused.value.code == "ignored_has_no_next_action"
    # The editor echoing the state is no transition.
    assert put(db_session, prospect.id, S.IGNORED).status is S.IGNORED
    assert len(history(db_session, tracking)) == 2
    # The opposition cannot be lifted while ignored.
    with pytest.raises(TrackingRuleError):
        prospect_service.clear_do_not_contact(db_session, OPERATOR, prospect.id, reason="Erreur")


def test_ignored_on_an_opposed_prospect_keeps_its_opposition(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    prospect_service.mark_do_not_contact(db_session, OPERATOR, prospect.id, reason="Demande")
    since = prospect.do_not_contact_at

    put(db_session, prospect.id, S.IGNORED)

    assert (prospect.do_not_contact_at, prospect.do_not_contact_reason) == (since, "Demande")
    assert len(audit_events(db_session, action="prospect.do_not_contact.set")) == 1


def test_sequence_closing_states_call_the_cancellation_seam_once(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[S] = []

    def cancel(session: Session, actor: ActorContext, tracking: ContactTracking) -> int:
        calls.append(tracking.status)
        return 0

    monkeypatch.setattr(contact_tracking_service, "cancel_future_messages", cancel)
    prospect = add_prospect(db_session)
    for state in (S.CONTACTED, S.RESPONSE_RECEIVED, S.RESPONSE_RECEIVED, S.R1, S.FAILURE):
        put(db_session, prospect.id, state)
    put(db_session, prospect.id, S.APPOINTMENT_OBTAINED)
    put(db_session, prospect.id, S.IGNORED)

    assert calls == [S.RESPONSE_RECEIVED, S.APPOINTMENT_OBTAINED, S.IGNORED]


def test_a_failing_cancellation_rolls_the_state_change_back(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    def cancel(session: Session, actor: ActorContext, tracking: ContactTracking) -> int:
        raise RuntimeError("cancellation failed")

    monkeypatch.setattr(contact_tracking_service, "cancel_future_messages", cancel)
    prospect = add_prospect(db_session)
    put(db_session, prospect.id, S.CONTACTED)

    with pytest.raises(RuntimeError), db_session.begin_nested():
        put(db_session, prospect.id, S.RESPONSE_RECEIVED)

    db_session.expire_all()
    tracking = db_session.scalars(
        select(ContactTracking).where(ContactTracking.prospect_id == prospect.id)
    ).one()
    assert tracking.status is S.CONTACTED
    assert history(db_session, tracking) == [(None, "contacted")]


def test_no_state_changes_with_time_or_an_overdue_week(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    past = datetime(2020, 1, 6, tzinfo=UTC)
    put(db_session, prospect.id, S.R2, planned_contact_at=past)

    tracking = put(db_session, prospect.id, S.R2, planned_contact_at=past)

    assert tracking.status is S.R2  # never an automatic failure
    assert len(history(db_session, tracking)) == 1
