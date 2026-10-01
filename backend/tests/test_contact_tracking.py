"""Contact tracking: one commercial state per prospect, response/appointment fields, status
history, and the Contact rules (sequences rework D7: states chosen by a person, « Défaillant »
by a person only)."""

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
from app.services.contact_message_cancellation import Cancellation
from app.services.contact_tracking import (
    IGNORED_REASON,
    ContactTrackingInput,
    save_contact_tracking,
)
from app.services.errors import ActorNotAllowedError, TrackingRuleError
from tests.builders import OPERATOR, add_prospect, audit_events

S = ContactTrackingStatus

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

    save_contact_tracking(db_session, OPERATOR, prospect.id, ContactTrackingInput(status=S.NEUTRAL))
    save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(status=S.RESPONSE_RECEIVED, response_received_at=RESPONSE),
    )
    tracking = save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(
            status=S.APPOINTMENT_OBTAINED,
            response_received_at=RESPONSE,
            appointment_at=APPOINTMENT,
            referent_id=referent.id,
        ),
    )
    db_session.expire_all()

    assert db_session.execute(select(func.count()).select_from(ContactTracking)).scalar_one() == 1
    assert tracking.status is S.APPOINTMENT_OBTAINED
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
        db_session, OPERATOR, prospect.id, ContactTrackingInput(status=S.RESPONSE_RECEIVED)
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
    first = ContactTrackingInput(status=S.APPOINTMENT_OBTAINED)
    save_contact_tracking(db_session, OPERATOR, prospect.id, first)

    tracking = save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(status=S.APPOINTMENT_OBTAINED, appointment_at=APPOINTMENT),
    )

    assert tracking.appointment_at == APPOINTMENT
    assert history(db_session, tracking) == [(None, "appointment_obtained")]


def test_tracking_changes_are_audited_by_kind(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    first = ContactTrackingInput(status=S.NEUTRAL)

    tracking = save_contact_tracking(db_session, OPERATOR, prospect.id, first)
    save_contact_tracking(db_session, OPERATOR, prospect.id, first)
    save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(status=S.RESPONSE_RECEIVED, response_received_at=RESPONSE),
    )
    save_contact_tracking(
        db_session,
        OPERATOR,
        prospect.id,
        ContactTrackingInput(
            status=S.RESPONSE_RECEIVED,
            response_received_at=RESPONSE,
            appointment_at=APPOINTMENT,
        ),
    )

    created, moved, dated = audit_events(db_session)
    assert (created.action, created.entity_id) == ("contact_tracking.created", tracking.id)
    assert created.changes["status"] == {"before": None, "after": "neutral"}
    assert "planned_contact_at" not in created.changes
    assert created.changes["prospect_id"] == {"before": None, "after": str(prospect.id)}
    assert moved.action == "contact_tracking.status_changed"
    assert moved.changes == {
        "status": {"before": "neutral", "after": "response_received"},
        "response_received_at": {"before": None, "after": RESPONSE.isoformat()},
    }
    assert dated.action == "contact_tracking.updated"
    assert dated.changes == {"appointment_at": {"before": None, "after": APPOINTMENT.isoformat()}}
    for entry in (created, moved, dated):
        assert (entry.subject_type, entry.subject_id) == ("prospect", prospect.id)


# --- Contact rules ------------------------------------------------------------------------------

IMPORTER = ActorContext(type=ActorType.IMPORT, display="Import test.xlsx", id="batch-1")
AGENT = ActorContext(type=ActorType.AGENT, display="Agent test", id="agent-1")
SYSTEM = ActorContext(type=ActorType.SYSTEM, display="Job test", id="job-1")


def put(session: Session, prospect_id: uuid.UUID, status: S, **fields: Any) -> ContactTracking:
    return save_contact_tracking(
        session, OPERATOR, prospect_id, ContactTrackingInput(status=status, **fields)
    )


def test_any_state_may_be_chosen_by_hand_back_to_neutral_included(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    for state in (S.RESPONSE_RECEIVED, S.NEUTRAL, S.DISQUALIFIED, S.APPOINTMENT_OBTAINED):
        put(db_session, prospect.id, state)

    tracking = put(db_session, prospect.id, S.NEUTRAL)

    assert tracking.status is S.NEUTRAL
    assert len(history(db_session, tracking)) == 5


def test_an_agent_never_chooses_a_state_but_imports_and_system_jobs_may(
    db_session: Session,
) -> None:
    prospect = add_prospect(db_session)
    save_contact_tracking(
        db_session, IMPORTER, prospect.id, ContactTrackingInput(S.APPOINTMENT_OBTAINED)
    )

    with pytest.raises(ActorNotAllowedError):
        save_contact_tracking(db_session, AGENT, prospect.id, ContactTrackingInput(S.NEUTRAL))
    # Dates only: not a state change, allowed.
    tracking = save_contact_tracking(
        db_session,
        AGENT,
        prospect.id,
        ContactTrackingInput(S.APPOINTMENT_OBTAINED, appointment_at=APPOINTMENT),
    )
    assert (tracking.status, tracking.appointment_at) == (S.APPOINTMENT_OBTAINED, APPOINTMENT)


@pytest.mark.parametrize("actor", [IMPORTER, AGENT, SYSTEM])
def test_disqualified_is_a_decision_of_a_person_only(
    db_session: Session, actor: ActorContext
) -> None:
    prospect = add_prospect(db_session)

    with pytest.raises(ActorNotAllowedError):
        save_contact_tracking(db_session, actor, prospect.id, ContactTrackingInput(S.DISQUALIFIED))

    tracking = put(db_session, prospect.id, S.DISQUALIFIED)
    assert tracking.status is S.DISQUALIFIED
    # Leaving it is a person's choice too, but any non-agent actor may echo it unchanged.
    assert (
        save_contact_tracking(
            db_session, IMPORTER, prospect.id, ContactTrackingInput(S.DISQUALIFIED)
        ).status
        is S.DISQUALIFIED
    )


def test_response_received_dates_the_response_once(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    before = datetime.now(UTC)

    tracking = put(db_session, prospect.id, S.RESPONSE_RECEIVED)
    stamped = tracking.response_received_at
    assert stamped is not None and stamped >= before
    put(db_session, prospect.id, S.NEUTRAL, response_received_at=stamped)
    tracking = put(db_session, prospect.id, S.RESPONSE_RECEIVED, response_received_at=stamped)
    assert tracking.response_received_at == stamped
    # A given date is kept.
    other = add_prospect(db_session, last_name="Datee")
    dated = put(db_session, other.id, S.RESPONSE_RECEIVED, response_received_at=RESPONSE)
    assert dated.response_received_at == RESPONSE


def test_ignored_reinforces_do_not_contact_and_is_terminal(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    put(db_session, prospect.id, S.NEUTRAL)

    tracking = put(db_session, prospect.id, S.IGNORED)

    assert tracking.status is S.IGNORED
    assert prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT
    assert prospect.do_not_contact_reason == IGNORED_REASON
    events = audit_events(db_session, action="prospect.do_not_contact.set")
    assert [(e.actor_id, e.context["reason"]) for e in events] == [(OPERATOR.id, IGNORED_REASON)]
    for state in (S.NEUTRAL, S.DISQUALIFIED, S.RESPONSE_RECEIVED):
        with pytest.raises(TrackingRuleError) as refused:
            put(db_session, prospect.id, state)
        assert refused.value.code == "ignored_is_terminal"
    # Not even an import: a re-import never reactivates it.
    with pytest.raises(TrackingRuleError):
        save_contact_tracking(db_session, IMPORTER, prospect.id, ContactTrackingInput(S.NEUTRAL))
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

    def cancel(session: Session, actor: ActorContext, tracking: ContactTracking) -> Cancellation:
        calls.append(tracking.status)
        return Cancellation()

    monkeypatch.setattr(contact_tracking_service, "cancel_future_messages", cancel)
    prospect = add_prospect(db_session)
    for state in (S.NEUTRAL, S.RESPONSE_RECEIVED, S.RESPONSE_RECEIVED, S.NEUTRAL):
        put(db_session, prospect.id, state)
    put(db_session, prospect.id, S.DISQUALIFIED)
    put(db_session, prospect.id, S.APPOINTMENT_OBTAINED)
    put(db_session, prospect.id, S.IGNORED)

    assert calls == [S.RESPONSE_RECEIVED, S.DISQUALIFIED, S.APPOINTMENT_OBTAINED, S.IGNORED]


def test_a_failing_cancellation_rolls_the_state_change_back(
    db_session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    def cancel(session: Session, actor: ActorContext, tracking: ContactTracking) -> Cancellation:
        raise RuntimeError("cancellation failed")

    monkeypatch.setattr(contact_tracking_service, "cancel_future_messages", cancel)
    prospect = add_prospect(db_session)
    put(db_session, prospect.id, S.NEUTRAL)

    with pytest.raises(RuntimeError), db_session.begin_nested():
        put(db_session, prospect.id, S.RESPONSE_RECEIVED)

    db_session.expire_all()
    tracking = db_session.scalars(
        select(ContactTracking).where(ContactTracking.prospect_id == prospect.id)
    ).one()
    assert tracking.status is S.NEUTRAL
    assert history(db_session, tracking) == [(None, "neutral")]


def test_former_states_are_refused(db_session: Session) -> None:
    prospect = add_prospect(db_session)
    tracking = put(db_session, prospect.id, S.NEUTRAL)

    for code in ("contacted", "r1", "r2", "failure"):
        with pytest.raises(ValueError):
            S(code)
    assert tracking.status is S.NEUTRAL
