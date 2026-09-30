"""Contact message state machine (Contact port Slice S3, handoff Task 12): every transition from
every status, revalidation after an edit, sent immutability, optimistic concurrency, closed
sequences, and the mechanical cancellation after a sequence-closing state (decision 29)."""

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import ContactMessage, ContactTracking, Prospect
from app.models.enums import ContactMessageStatus, ContactMessageStep, ContactTrackingStatus
from app.services import contact_messages as service
from app.services.contact_message_cancellation import Cancellation
from app.services.contact_messages import MessageEdit, MessageResult
from app.services.contact_tracking import ContactTrackingInput, apply_contact_tracking
from app.services.errors import (
    ActorNotAllowedError,
    ContactMessageError,
    InvalidFieldError,
    NotFoundError,
)
from app.services.prospects import record_do_not_contact
from tests.builders import OPERATOR, add_company, add_email, add_prospect, audit_events, rejected

M = ContactMessageStatus
S = ContactTrackingStatus
STEP = ContactMessageStep.CONTACT
SENDER = "prospection@exemple.example"
LATER = datetime.now(UTC) + timedelta(days=3)
COMPLETE = MessageEdit(
    from_email=SENDER,
    subject="Objet de test",
    body_text="Corps de test",
    to=["jean.test@exemple.example"],
    provided=frozenset({"from_email"}),
)


def prospect_with(session: Session, state: S | None = S.CONTACTED) -> Prospect:
    prospect = add_prospect(session, add_company(session))
    add_email(session, prospect, "jean.test@exemple.example", is_primary=True)
    if state is not None:
        session.add(ContactTracking(prospect_id=prospect.id, status=state))
        session.flush()
    session.refresh(prospect)
    return prospect


def code_of(error: pytest.ExceptionInfo[ContactMessageError]) -> str:
    return error.value.code


def create(session: Session, prospect: Prospect, step: ContactMessageStep = STEP) -> ContactMessage:
    return service.save_message(session, OPERATOR, prospect.id, step, COMPLETE).message


def message_in(session: Session, prospect: Prospect, status: M) -> ContactMessage:
    """A complete message brought to `status` through the service (`sent` written directly: only
    the dispatcher may send)."""
    message = create(session, prospect)
    if status is M.DRAFT:
        return message
    if status is M.CANCELLED:
        return service.cancel(session, OPERATOR, prospect.id, STEP, message.revision).message
    message = service.validate(session, OPERATOR, prospect.id, STEP, message.revision).message
    if status is M.VALIDATED:
        return message
    message = service.schedule(
        session, OPERATOR, prospect.id, STEP, message.revision, LATER
    ).message
    if status is M.SENT:
        message.status = M.SENT
        message.sent_at = datetime.now(UTC)
        session.flush()
    return message


Action = Callable[[Session, Prospect, ContactMessage], MessageResult]


def edit(session: Session, prospect: Prospect, message: ContactMessage) -> MessageResult:
    change = MessageEdit(expected_revision=message.revision, subject="Objet modifié")
    return service.save_message(session, OPERATOR, prospect.id, STEP, change)


def by_revision(
    operation: Callable[[Session, ActorContext, uuid.UUID, ContactMessageStep, int], MessageResult],
) -> Action:
    def run(session: Session, prospect: Prospect, message: ContactMessage) -> MessageResult:
        return operation(session, OPERATOR, prospect.id, STEP, message.revision)

    return run


def schedule(session: Session, prospect: Prospect, message: ContactMessage) -> MessageResult:
    return service.schedule(session, OPERATOR, prospect.id, STEP, message.revision, LATER)


ACTIONS: dict[str, Action] = {
    "edit": edit,
    "validate": by_revision(service.validate),
    "schedule": schedule,
    "unschedule": by_revision(service.unschedule),
    "cancel": by_revision(service.cancel),
    "reopen": by_revision(service.reopen),
}
# (action, from) -> resulting status, or the refusal code.
EXPECTED: dict[tuple[str, M], M | str] = {
    ("edit", M.DRAFT): M.DRAFT,
    ("edit", M.VALIDATED): M.DRAFT,
    ("edit", M.SCHEDULED): M.DRAFT,
    ("edit", M.CANCELLED): "message_cancelled",
    ("validate", M.DRAFT): M.VALIDATED,
    ("validate", M.VALIDATED): "invalid_transition",
    ("validate", M.SCHEDULED): "invalid_transition",
    ("validate", M.CANCELLED): "invalid_transition",
    ("schedule", M.DRAFT): "invalid_transition",
    ("schedule", M.VALIDATED): M.SCHEDULED,
    ("schedule", M.SCHEDULED): "invalid_transition",
    ("schedule", M.CANCELLED): "invalid_transition",
    ("unschedule", M.DRAFT): "invalid_transition",
    ("unschedule", M.VALIDATED): "invalid_transition",
    ("unschedule", M.SCHEDULED): M.VALIDATED,
    ("unschedule", M.CANCELLED): "invalid_transition",
    ("cancel", M.DRAFT): M.CANCELLED,
    ("cancel", M.VALIDATED): M.CANCELLED,
    ("cancel", M.SCHEDULED): M.CANCELLED,
    ("cancel", M.CANCELLED): "invalid_transition",
    ("reopen", M.DRAFT): "invalid_transition",
    ("reopen", M.VALIDATED): "invalid_transition",
    ("reopen", M.SCHEDULED): "invalid_transition",
    ("reopen", M.CANCELLED): M.DRAFT,
    **{(action, M.SENT): "message_sent_immutable" for action in ACTIONS},
}


@pytest.mark.parametrize(("action", "status"), list(EXPECTED))
def test_every_action_from_every_status(db_session: Session, action: str, status: M) -> None:
    prospect = prospect_with(db_session)
    message = message_in(db_session, prospect, status)
    expected = EXPECTED[(action, status)]

    if not isinstance(expected, M):
        with pytest.raises(ContactMessageError) as refused:
            ACTIONS[action](db_session, prospect, message)
        assert code_of(refused) == expected
        return
    result = ACTIONS[action](db_session, prospect, message)
    assert result.message.status is expected


def test_a_new_message_takes_the_defaults_and_starts_as_a_draft(db_session: Session) -> None:
    prospect = prospect_with(db_session)

    result = service.save_message(
        db_session, OPERATOR, prospect.id, STEP, MessageEdit(), default_from=SENDER
    )

    message = result.message
    assert (result.created, message.status, message.revision) == (True, M.DRAFT, 1)
    assert (message.from_email, message.to_recipients) == (SENDER, ["jean.test@exemple.example"])
    assert (message.subject, message.body_text, message.cc_recipients) == ("", "", [])
    [event] = audit_events(db_session, entity_type="contact_message")
    assert (event.action, event.subject_id) == ("contact_message.created", prospect.id)
    # The content never enters the audit log in clear.
    assert event.changes["to_recipients"]["after"] == "[masked]"
    assert "Objet" not in str(event.changes)


def test_the_three_steps_are_independent_and_unique(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    for step in ContactMessageStep:
        create(db_session, prospect, step)

    read = service.prospect_messages(db_session, prospect.id, None)
    assert [step for step, message in read.messages.items() if message] == list(ContactMessageStep)
    # Saving without a revision again is a creation attempt: refused, the step exists.
    with pytest.raises(ContactMessageError) as refused:
        service.save_message(db_session, OPERATOR, prospect.id, ContactMessageStep.R1, COMPLETE)
    assert code_of(refused) == "message_exists"
    with rejected(db_session, "uq_contact_messages_prospect_id_step"):
        db_session.add(ContactMessage(prospect_id=prospect.id, step=ContactMessageStep.R2))


def test_editing_a_scheduled_message_sends_it_back_to_draft(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = message_in(db_session, prospect, M.SCHEDULED)
    revision = message.revision

    result = edit(db_session, prospect, message)

    message = result.message
    assert (result.unvalidated, message.status, message.revision) == (True, M.DRAFT, revision + 1)
    assert (message.validated_revision, message.validated_at, message.scheduled_at) == (
        None,
        None,
        None,
    )
    assert audit_events(db_session, action="contact_message.unvalidated")
    # A new validation is needed, of the new revision.
    message = service.validate(db_session, OPERATOR, prospect.id, STEP, message.revision).message
    assert message.validated_revision == revision + 1
    assert message.validated_by_display == OPERATOR.display


def test_validating_and_scheduling_keep_the_revision(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = message_in(db_session, prospect, M.SCHEDULED)
    assert (message.revision, message.validated_revision, message.scheduled_at) == (1, 1, LATER)

    message = service.unschedule(db_session, OPERATOR, prospect.id, STEP, 1).message
    assert (message.status, message.validated_revision, message.scheduled_at) == (
        M.VALIDATED,
        1,
        None,
    )


def test_an_identical_save_changes_nothing(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = message_in(db_session, prospect, M.VALIDATED)
    same = MessageEdit(
        expected_revision=1, subject=message.subject, to=["JEAN.test@exemple.example"]
    )

    result = service.save_message(db_session, OPERATOR, prospect.id, STEP, same)

    assert (result.changed, result.message.status, result.message.revision) == (
        False,
        M.VALIDATED,
        1,
    )


def test_a_stale_revision_is_a_conflict(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = create(db_session, prospect)
    edit(db_session, prospect, message)  # revision 2 now

    for action in ("edit", "validate", "cancel"):
        stale = MessageEdit(expected_revision=1, subject="Autre objet")
        with pytest.raises(ContactMessageError) as refused:
            if action == "edit":
                service.save_message(db_session, OPERATOR, prospect.id, STEP, stale)
            elif action == "validate":
                service.validate(db_session, OPERATOR, prospect.id, STEP, 1)
            else:
                service.cancel(db_session, OPERATOR, prospect.id, STEP, 1)
        assert code_of(refused) == "revision_conflict"


def test_validation_needs_a_complete_message(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = service.save_message(
        db_session, OPERATOR, prospect.id, STEP, MessageEdit(to=[])
    ).message

    with pytest.raises(ContactMessageError) as refused:
        service.validate(db_session, OPERATOR, prospect.id, STEP, message.revision)

    assert code_of(refused) == "message_incomplete"
    assert refused.value.details == {"fields": ["from_email", "to", "subject", "body_text"]}


def test_addresses_are_normalized_and_an_invalid_one_is_refused(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    addresses = MessageEdit(to=[" A@Exemple.example ", "", "a@exemple.example"], cc=["b@x.example"])
    message = service.save_message(db_session, OPERATOR, prospect.id, STEP, addresses).message
    assert (message.to_recipients, message.cc_recipients) == (
        ["a@exemple.example"],
        ["b@x.example"],
    )

    bad = MessageEdit(expected_revision=message.revision, bcc=["ok@x.example", "pas-une-adresse"])
    with pytest.raises(InvalidFieldError) as refused:
        service.save_message(db_session, OPERATOR, prospect.id, STEP, bad)
    assert refused.value.field == "bcc.1"
    clear = MessageEdit(expected_revision=message.revision, provided=frozenset({"from_email"}))
    message = service.save_message(db_session, OPERATOR, prospect.id, STEP, clear).message
    assert message.from_email is None


def test_scheduling_needs_a_future_moment(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = message_in(db_session, prospect, M.VALIDATED)
    now = datetime(2026, 10, 1, 9, tzinfo=UTC)

    for moment in (now, now - timedelta(minutes=1)):
        with pytest.raises(InvalidFieldError) as refused:
            service.schedule(db_session, OPERATOR, prospect.id, STEP, 1, moment, now=now)
        assert refused.value.reason == "not_future"
    with pytest.raises(InvalidFieldError):
        service.schedule(db_session, OPERATOR, prospect.id, STEP, 1, datetime(2030, 1, 1), now=now)
    scheduled = service.schedule(
        db_session,
        OPERATOR,
        prospect.id,
        STEP,
        message.revision,
        now + timedelta(minutes=1),
        now=now,
    )
    assert scheduled.message.status is M.SCHEDULED


def test_reopening_keeps_the_content_and_needs_a_new_validation(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = message_in(db_session, prospect, M.VALIDATED)
    message = service.cancel(db_session, OPERATOR, prospect.id, STEP, 1).message
    assert (message.cancel_reason, message.cancelled_at is not None) == ("manual", True)

    message = service.reopen(db_session, OPERATOR, prospect.id, STEP, 1).message

    assert (message.status, message.revision, message.subject) == (M.DRAFT, 2, "Objet de test")
    assert (message.cancelled_at, message.validated_revision) == (None, None)


def test_only_a_person_handles_messages(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    agent = ActorContext(type=ActorType.AGENT, display="Agent", id="agent")
    with pytest.raises(ActorNotAllowedError):
        service.save_message(db_session, agent, prospect.id, STEP, COMPLETE)
    message = create(db_session, prospect)
    with pytest.raises(ActorNotAllowedError):
        service.validate(db_session, agent, prospect.id, STEP, message.revision)


def test_unknown_prospect_and_missing_message(db_session: Session) -> None:
    with pytest.raises(NotFoundError):
        service.save_message(db_session, OPERATOR, uuid.uuid4(), STEP, COMPLETE)
    prospect = prospect_with(db_session)
    with pytest.raises(ContactMessageError) as refused:
        service.validate(db_session, OPERATOR, prospect.id, STEP, 1)
    assert code_of(refused) == "message_not_found"
    with pytest.raises(ContactMessageError) as refused:
        service.save_message(
            db_session, OPERATOR, prospect.id, STEP, MessageEdit(expected_revision=1)
        )
    assert code_of(refused) == "message_not_found"


@pytest.mark.parametrize("state", [S.RESPONSE_RECEIVED, S.APPOINTMENT_OBTAINED, S.IGNORED])
def test_a_closed_sequence_refuses_a_new_message(db_session: Session, state: S) -> None:
    prospect = prospect_with(db_session, state)
    with pytest.raises(ContactMessageError) as refused:
        create(db_session, prospect)
    assert code_of(refused) == "prospect_sequence_closed"


def test_closing_the_sequence_by_hand_keeps_unscheduling_and_cancelling(
    db_session: Session,
) -> None:
    prospect = prospect_with(db_session)
    draft = create(db_session, prospect, ContactMessageStep.R1)
    message = message_in(db_session, prospect, M.SCHEDULED)
    tracking = db_session.scalars(
        select(ContactTracking).where(ContactTracking.prospect_id == prospect.id)
    ).one()
    # A state written without the service (e.g. a raw fix): the messages stay, the rules hold.
    tracking.status = S.RESPONSE_RECEIVED
    db_session.flush()

    for action in ("edit", "validate", "reopen"):
        with pytest.raises(ContactMessageError) as refused:
            ACTIONS[action](db_session, prospect, draft)
        assert code_of(refused) in ("prospect_sequence_closed", "invalid_transition")
    message = service.unschedule(db_session, OPERATOR, prospect.id, STEP, 1).message
    assert service.cancel(db_session, OPERATOR, prospect.id, STEP, 1).message.status is M.CANCELLED
    with pytest.raises(ContactMessageError) as refused:
        service.reopen(db_session, OPERATOR, prospect.id, STEP, 1)
    assert code_of(refused) == "prospect_sequence_closed"
    assert message.id is not None


def test_do_not_contact_cancels_the_unsent_messages_and_closes_the_sequence(
    db_session: Session,
) -> None:
    prospect = prospect_with(db_session)
    scheduled = message_in(db_session, prospect, M.SCHEDULED)

    recorded = record_do_not_contact(db_session, OPERATOR, prospect.id, reason="Demande")

    assert recorded.messages == Cancellation(cancelled=1, in_flight=0)
    db_session.refresh(scheduled)
    assert (scheduled.status, scheduled.cancel_reason) == (M.CANCELLED, "do_not_contact")
    [event] = audit_events(db_session, action="contact_message.cancelled")
    assert event.context["reason"] == "do_not_contact"
    with pytest.raises(ContactMessageError) as refused:
        create(db_session, prospect, ContactMessageStep.R1)
    assert code_of(refused) == "prospect_do_not_contact"
    assert service.prospect_messages(db_session, prospect.id, None).context.closed
    # Idempotent: marking again finds nothing left to cancel.
    again = record_do_not_contact(db_session, OPERATOR, prospect.id)
    assert again.messages == Cancellation()


@pytest.mark.parametrize("state", [S.RESPONSE_RECEIVED, S.APPOINTMENT_OBTAINED, S.IGNORED])
def test_a_sequence_closing_state_cancels_the_unsent_messages(
    db_session: Session, state: S
) -> None:
    prospect = prospect_with(db_session)
    scheduled = message_in(db_session, prospect, M.SCHEDULED)
    draft = create(db_session, prospect, ContactMessageStep.R1)

    saved = apply_contact_tracking(db_session, OPERATOR, prospect.id, ContactTrackingInput(state))

    assert saved.messages.cancelled == 2
    for message in (scheduled, draft):
        db_session.refresh(message)
        assert (message.status, message.cancel_reason) == (M.CANCELLED, f"prospect_state:{state}")
    events = audit_events(db_session, action="contact_message.cancelled")
    assert [event.context.get("reason") for event in events] == [f"prospect_state:{state}"] * 2


def test_the_cancellation_spares_sent_cancelled_and_in_flight_messages(
    db_session: Session,
) -> None:
    prospect = prospect_with(db_session)
    sent = message_in(db_session, prospect, M.SENT)
    cancelled = create(db_session, prospect, ContactMessageStep.R1)
    service.cancel(db_session, OPERATOR, prospect.id, ContactMessageStep.R1, 1)
    claimed = create(db_session, prospect, ContactMessageStep.R2)
    claimed = service.validate(
        db_session, OPERATOR, prospect.id, ContactMessageStep.R2, claimed.revision
    ).message
    claimed = service.schedule(
        db_session, OPERATOR, prospect.id, ContactMessageStep.R2, claimed.revision, LATER
    ).message
    claimed.dispatch_claim_id = uuid.uuid4()
    claimed.dispatch_claimed_at = datetime.now(UTC)
    db_session.flush()

    saved = apply_contact_tracking(
        db_session, OPERATOR, prospect.id, ContactTrackingInput(S.APPOINTMENT_OBTAINED)
    )

    assert saved.messages == Cancellation(cancelled=0, in_flight=1)
    for message, status in ((sent, M.SENT), (cancelled, M.CANCELLED), (claimed, M.SCHEDULED)):
        db_session.refresh(message)
        assert message.status is status
    # A claimed message is locked for people too.
    with pytest.raises(ContactMessageError) as refused:
        service.cancel(db_session, OPERATOR, prospect.id, ContactMessageStep.R2, claimed.revision)
    assert code_of(refused) == "dispatch_in_progress"


def test_ignored_cancels_with_its_own_reason_and_counts_claimed_messages_once(
    db_session: Session,
) -> None:
    prospect = prospect_with(db_session)
    draft = create(db_session, prospect)
    claimed = create(db_session, prospect, ContactMessageStep.R1)
    claimed = service.validate(
        db_session, OPERATOR, prospect.id, ContactMessageStep.R1, claimed.revision
    ).message
    claimed = service.schedule(
        db_session, OPERATOR, prospect.id, ContactMessageStep.R1, claimed.revision, LATER
    ).message
    claimed.dispatch_claim_id = uuid.uuid4()
    claimed.dispatch_claimed_at = datetime.now(UTC)
    db_session.flush()

    saved = apply_contact_tracking(
        db_session, OPERATOR, prospect.id, ContactTrackingInput(S.IGNORED)
    )

    assert saved.messages == Cancellation(cancelled=1, in_flight=1)
    db_session.refresh(draft)
    assert draft.cancel_reason == "prospect_state:ignored"
    events = audit_events(db_session, action="contact_message.cancelled")
    assert [event.context["reason"] for event in events] == ["prospect_state:ignored"]


def test_other_state_changes_cancel_nothing(db_session: Session) -> None:
    prospect = prospect_with(db_session, S.NEUTRAL)
    create(db_session, prospect)
    for state in (S.CONTACTED, S.R1, S.R2, S.FAILURE):
        saved = apply_contact_tracking(
            db_session, OPERATOR, prospect.id, ContactTrackingInput(state)
        )
        assert saved.messages.cancelled == 0
    assert service.get_message(db_session, prospect.id, STEP).status is M.DRAFT  # type: ignore[union-attr]


def test_the_database_keeps_a_sent_message_immutable(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = message_in(db_session, prospect, M.SENT)

    with pytest.raises(Exception, match="is sent and cannot be changed"), db_session.begin_nested():
        db_session.execute(
            text("UPDATE contact_messages SET subject = 'x' WHERE id = :id"), {"id": message.id}
        )
    # Deleting the prospect still removes its messages.
    db_session.execute(text("DELETE FROM prospects WHERE id = :id"), {"id": prospect.id})
    assert (
        db_session.scalar(select(ContactMessage.id).where(ContactMessage.id == message.id)) is None
    )


def test_the_database_refuses_a_stale_validation(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = message_in(db_session, prospect, M.VALIDATED)
    with rejected(db_session, "ck_contact_messages_validation_current"):
        message.revision = 2
    db_session.refresh(message)
    with rejected(db_session, "ck_contact_messages_scheduled_has_moment"):
        message.status = M.SCHEDULED


def test_control_characters_are_refused_in_headers(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    sender = frozenset({"from_email"})
    for change, field in (
        (MessageEdit(subject="Objet\r\nBcc: x@exemple.example"), "subject"),
        (MessageEdit(to=["a@exemple.example\n"]), "to.0"),
        (MessageEdit(from_email="a@exemple.example\r", provided=sender), "from_email"),
        (MessageEdit(subject="Objet\x00"), "subject"),
    ):
        with pytest.raises(InvalidFieldError) as refused:
            service.save_message(db_session, OPERATOR, prospect.id, STEP, change)
        assert (refused.value.field, refused.value.reason) == (field, "control_character")
    # The body is free text: line breaks are its content.
    body = MessageEdit(body_text="Bonjour,\r\n\r\nCordialement")
    assert service.save_message(db_session, OPERATOR, prospect.id, STEP, body).created


def test_an_address_receives_the_mail_once(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    edit = MessageEdit(
        to=["a@exemple.example"],
        cc=["A@exemple.example", "b@exemple.example"],
        bcc=["b@exemple.example", "a@exemple.example", "c@exemple.example"],
    )

    message = service.save_message(db_session, OPERATOR, prospect.id, STEP, edit).message

    assert (message.to_recipients, message.cc_recipients, message.bcc_recipients) == (
        ["a@exemple.example"],
        ["b@exemple.example"],
        ["c@exemple.example"],
    )


def test_scheduling_at_most_a_year_ahead(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message_in(db_session, prospect, M.VALIDATED)
    now = datetime(2026, 10, 1, 9, tzinfo=UTC)

    with pytest.raises(InvalidFieldError) as refused:
        service.schedule(
            db_session, OPERATOR, prospect.id, STEP, 1, now + timedelta(days=400), now=now
        )
    assert refused.value.reason == "too_far"
    ok = service.schedule(
        db_session, OPERATOR, prospect.id, STEP, 1, now + timedelta(days=365), now=now
    )
    assert ok.message.status is M.SCHEDULED


def test_a_person_without_an_id_is_not_an_identified_person(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = create(db_session, prospect)
    anonymous = ActorContext(type=ActorType.HUMAN, display="Sans identifiant", id=None)
    with pytest.raises(ActorNotAllowedError):
        service.validate(db_session, anonymous, prospect.id, STEP, message.revision)


def test_an_identical_save_on_a_closed_sequence_changes_nothing(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = create(db_session, prospect)
    tracking = db_session.scalars(
        select(ContactTracking).where(ContactTracking.prospect_id == prospect.id)
    ).one()
    tracking.status = S.RESPONSE_RECEIVED  # a raw write: the draft survived
    db_session.flush()

    same = MessageEdit(expected_revision=message.revision, subject=message.subject)
    result = service.save_message(db_session, OPERATOR, prospect.id, STEP, same)
    assert result.changed is False
    with pytest.raises(ContactMessageError) as refused:
        edit(db_session, prospect, message)
    assert code_of(refused) == "prospect_sequence_closed"
