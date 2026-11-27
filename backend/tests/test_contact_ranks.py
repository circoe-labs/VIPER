"""Messages by rank up to « max relances » (sequences rework S3): every step from the Contact to
R<max> can be prepared, a rank beyond the maximum cannot (but a message kept beyond a lowered
maximum stays readable and cancellable), « Marquer comme envoyé » is idempotent with the rank the
person saw, a planned but unsent message never moves the level, a change of cohort cancels the
unsent messages of the closed sequence and keeps its history, and the AI drafts any rank without
touching the cohort, the state, the sequence or the level."""

import uuid
from datetime import UTC, date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.contact_steps import (
    level_key,
    level_keys,
    level_label,
    parse_step,
    step_code,
    step_label,
)
from app.models import AppSetting, ContactMessage
from app.models.enums import ContactMessageStatus, ContactTrackingStatus, SequenceEndReason
from app.services import app_settings, contact_sequences
from app.services import contact_messages as service
from app.services.contact_messages import MessageEdit
from app.services.errors import ContactMessageError, InvalidFieldError
from tests.builders import OPERATOR, add_cohort, audit_events
from tests.test_contact_messages import COMPLETE, prospect_with
from tests.test_contact_messages_api import messages, ok, refused

M = ContactMessageStatus
S = ContactTrackingStatus
LATER = datetime.now(UTC) + timedelta(days=3)


def code_of(error: pytest.ExceptionInfo[ContactMessageError]) -> str:
    return error.value.code


def set_max(session: Session, value: int) -> None:
    app_settings.set_max_follow_ups(session, OPERATOR, value)


def level_of(session: Session, prospect_id: uuid.UUID) -> tuple[int, int | None, bool]:
    progress = contact_sequences.prospect_sequence(session, prospect_id).progress
    return progress.sent_count, progress.next_rank, progress.finished


# --- names --------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("rank", "code", "label"),
    [(0, "contact", "Contact"), (1, "r1", "R1"), (4, "r4", "R4"), (12, "r12", "R12")],
)
def test_step_codes_and_labels(rank: int, code: str, label: str) -> None:
    assert (step_code(rank), step_label(rank), parse_step(code)) == (code, label, rank)


@pytest.mark.parametrize("code", ["r0", "rank1", "", "R", "r-1", "S37"])
def test_other_codes_are_not_steps(code: str) -> None:
    assert parse_step(code) is None


def test_levels_follow_the_real_sends_up_to_the_maximum() -> None:
    assert level_keys(4) == [
        "contact_pending",
        "contact_sent",
        "r1_sent",
        "r2_sent",
        "r3_sent",
        "finished",
    ]
    assert [level_label(key) for key in level_keys(2)] == [
        "Contact à envoyer",
        "Contact envoyé",
        "R1 envoyée",
        "Relance terminée",
    ]
    assert level_keys(0) == ["contact_pending", "finished"]
    assert (level_key(3, False), level_key(3, True)) == ("r2_sent", "finished")
    assert [level_key(sent, False) for sent in range(4)] == level_keys(3)[:-1]


# --- ranks up to « max relances » ---------------------------------------------------------------


def old_message(session: Session, prospect_id: uuid.UUID, rank: int) -> ContactMessage:
    """A draft beyond R2, as written before the three-e-mail rule."""
    sequence = contact_sequences.current_sequence(session, prospect_id)
    assert sequence is not None
    message = ContactMessage(
        prospect_id=prospect_id,
        sequence_id=sequence.id,
        rank=rank,
        subject="Ancien objet",
        body_text="Ancien corps",
        to_recipients=["jean.test@exemple.example"],
    )
    session.add(message)
    session.flush()
    session.refresh(message)
    return message


def test_three_e_mails_can_be_prepared_and_no_more(db_session: Session) -> None:
    prospect = prospect_with(db_session)

    for rank in range(3):
        message = service.save_message(db_session, OPERATOR, prospect.id, rank, COMPLETE).message
        assert (message.rank, message.step, message.status) == (rank, step_code(rank), M.DRAFT)
    r2 = service.validate(db_session, OPERATOR, prospect.id, 2, 1).message
    assert service.schedule(db_session, OPERATOR, prospect.id, 2, r2.revision, LATER).message

    for rank in (3, 4):
        with pytest.raises(ContactMessageError) as refused_:
            service.save_message(db_session, OPERATOR, prospect.id, rank, COMPLETE)
        assert code_of(refused_) == "rank_beyond_max"
        assert refused_.value.details["max_follow_ups"] == 2
    with pytest.raises(InvalidFieldError):
        set_max(db_session, 3)


def test_a_stored_maximum_above_two_changes_nothing(db_session: Session) -> None:
    db_session.add(AppSetting(key="contact.max_follow_ups", value=4))
    db_session.flush()
    prospect = prospect_with(db_session)

    assert app_settings.max_follow_ups(db_session) == 2
    with pytest.raises(ContactMessageError) as refused_:
        service.save_message(db_session, OPERATOR, prospect.id, 3, COMPLETE)
    assert code_of(refused_) == "rank_beyond_max"
    read = service.prospect_messages(db_session, prospect.id, None)
    assert [item.step for item in read.messages] == ["contact", "r1", "r2"]


def test_an_old_r3_stays_readable_and_cancellable_only(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    r3 = old_message(db_session, prospect.id, 3)

    read = service.prospect_messages(db_session, prospect.id, None)
    assert [(item.rank, item.message is not None) for item in read.messages] == [
        (0, False),
        (1, False),
        (2, False),
        (3, True),
    ]
    with pytest.raises(ContactMessageError) as refused_:
        service.validate(db_session, OPERATOR, prospect.id, 3, r3.revision)
    assert code_of(refused_) == "rank_beyond_max"
    edit = MessageEdit(expected_revision=r3.revision, subject="Autre objet")
    with pytest.raises(ContactMessageError) as refused_:
        service.save_message(db_session, OPERATOR, prospect.id, 3, edit)
    assert code_of(refused_) == "rank_beyond_max"
    cancelled = service.cancel(db_session, OPERATOR, prospect.id, 3, r3.revision).message
    assert cancelled.status is M.CANCELLED
    with pytest.raises(ContactMessageError) as refused_:
        service.reopen(db_session, OPERATOR, prospect.id, 3, cancelled.revision)
    assert code_of(refused_) == "rank_beyond_max"


# --- « Marquer comme envoyé » -------------------------------------------------------------------


def test_a_planned_but_unsent_message_never_moves_the_level(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    draft = service.save_message(db_session, OPERATOR, prospect.id, 0, COMPLETE).message
    service.validate(db_session, OPERATOR, prospect.id, 0, draft.revision)
    service.schedule(db_session, OPERATOR, prospect.id, 0, draft.revision, LATER)
    service.save_message(db_session, OPERATOR, prospect.id, 1, COMPLETE)

    assert level_of(db_session, prospect.id) == (0, 0, False)


def test_mark_sent_with_the_rank_is_idempotent(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    sent_at = datetime(2026, 9, 7, 9, tzinfo=UTC)

    first = service.mark_sent(db_session, OPERATOR, prospect.id, rank=0, sent_at=sent_at)
    replay = service.mark_sent(db_session, OPERATOR, prospect.id, rank=0)

    assert (first.created, first.changed) == (True, True)
    assert (replay.created, replay.changed, replay.message.id) == (False, False, first.message.id)
    assert replay.message.sent_at == sent_at
    assert level_of(db_session, prospect.id) == (1, 1, False)
    assert len(audit_events(db_session, action="contact_message.sent")) == 1


def test_mark_sent_refuses_another_rank_than_the_next(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    service.save_message(db_session, OPERATOR, prospect.id, 2, COMPLETE)

    with pytest.raises(ContactMessageError) as refused_:
        service.mark_sent(db_session, OPERATOR, prospect.id, rank=2)

    assert code_of(refused_) == "rank_not_next"
    assert (refused_.value.details["next_rank"], refused_.value.details["next_step"]) == (
        0,
        "contact",
    )
    assert level_of(db_session, prospect.id) == (0, 0, False)


def test_both_send_paths_record_the_same_send(db_session: Session) -> None:
    """A drafted message marked sent and a send declared without a message: same status, source,
    audit event and effect on the level."""
    with_text = prospect_with(db_session)
    without = prospect_with(db_session)
    service.save_message(db_session, OPERATOR, with_text.id, 0, COMPLETE)
    moment = datetime(2026, 9, 7, 9, tzinfo=UTC)

    drafted = service.mark_sent(db_session, OPERATOR, with_text.id, rank=0, sent_at=moment).message
    bare = service.mark_sent(db_session, OPERATOR, without.id, rank=0, sent_at=moment).message

    for message in (drafted, bare):
        assert (message.status, message.sent_at, message.sent_source.value) == (  # type: ignore[union-attr]
            M.SENT,
            moment,
            "manual",
        )
    assert (drafted.subject, bare.subject) == ("Objet de test", "")
    assert level_of(db_session, with_text.id) == level_of(db_session, without.id) == (1, 1, False)
    assert len(audit_events(db_session, action="contact_message.sent")) == 2


def test_reaching_the_maximum_finishes_the_sequence(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    start = datetime(2026, 9, 7, 9, tzinfo=UTC)
    for rank in range(3):
        service.mark_sent(
            db_session, OPERATOR, prospect.id, rank=rank, sent_at=start + timedelta(weeks=rank)
        )

    place = contact_sequences.prospect_sequence(db_session, prospect.id)

    assert (place.progress.finished, place.progress.next_rank, place.progress.level) == (
        True,
        None,
        "finished",
    )
    assert (place.progress.level_label, place.progress.next_due_at) == ("Relance terminée", None)
    # No fourth e-mail can be declared; replaying the R2 send stays harmless.
    with pytest.raises(ContactMessageError) as refused_:
        service.mark_sent(db_session, OPERATOR, prospect.id, rank=3)
    assert code_of(refused_) == "rank_beyond_max"
    assert service.mark_sent(db_session, OPERATOR, prospect.id, rank=2).changed is False


def test_lowering_the_maximum_finishes_sequences_already_past_it(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    for rank in range(2):
        service.mark_sent(
            db_session,
            OPERATOR,
            prospect.id,
            rank=rank,
            sent_at=datetime(2026, 9, 7, 9, tzinfo=UTC) + timedelta(weeks=rank),
        )
    assert level_of(db_session, prospect.id) == (2, 2, False)

    set_max(db_session, 1)

    assert level_of(db_session, prospect.id) == (2, None, True)


# --- change of cohort ---------------------------------------------------------------------------


def test_a_cohort_change_cancels_the_unsent_messages_and_keeps_the_history(
    db_session: Session,
) -> None:
    prospect = prospect_with(db_session)
    service.mark_sent(db_session, OPERATOR, prospect.id, rank=0)
    r1 = service.save_message(db_session, OPERATOR, prospect.id, 1, COMPLETE).message
    service.validate(db_session, OPERATOR, prospect.id, 1, r1.revision)
    service.schedule(db_session, OPERATOR, prospect.id, 1, r1.revision, LATER)
    service.save_message(db_session, OPERATOR, prospect.id, 2, COMPLETE)
    old = contact_sequences.current_sequence(db_session, prospect.id)
    assert old is not None

    change = contact_sequences.change_cohort(
        db_session, OPERATOR, prospect.id, add_cohort(db_session, "S45", date(2026, 11, 2)).id
    )

    assert (change.changed, change.messages.cancelled) == (True, 2)
    rows = db_session.scalars(
        select(ContactMessage)
        .where(ContactMessage.sequence_id == old.id)
        .order_by(ContactMessage.rank)
    ).all()
    assert [(row.rank, row.status, row.cancel_reason) for row in rows] == [
        (0, M.SENT, None),
        (1, M.CANCELLED, "sequence_closed"),
        (2, M.CANCELLED, "sequence_closed"),
    ]
    assert old.end_reason is SequenceEndReason.COHORT_CHANGED
    # The new sequence starts at the Contact; the old one stays in the history.
    assert level_of(db_session, prospect.id) == (0, 0, False)
    history = contact_sequences.sequence_history(db_session, prospect.id)
    assert [(view.cohort.code, view.sent_count) for view in history] == [("S45", 0), ("S41", 1)]
    read = service.prospect_messages(db_session, prospect.id, None)
    assert all(item.message is None for item in read.messages)


# --- HTTP ---------------------------------------------------------------------------------------


def test_ranks_over_http(client: TestClient, db_session: Session) -> None:
    person = prospect_with(db_session)
    path = messages(person.id)

    created = ok(client.put(f"{path}/r2", json={"subject": "Objet R2"}), 201)
    assert (created["message"]["rank"], created["message"]["step"]) == (2, "r2")
    assert created["message"]["step_label"] == "R2"
    refused(client.put(f"{path}/r3", json={"subject": "Trop loin"}), 409, "rank_beyond_max")

    first = ok(client.post(f"{path}/mark-sent", json={"rank": 0}), 201)
    replay = ok(client.post(f"{path}/mark-sent", json={"rank": 0}), 200)
    assert (replay["changed"], replay["message"]["id"]) == (False, first["message"]["id"])
    detail = refused(client.post(f"{path}/mark-sent", json={"rank": 2}), 409, "rank_not_next")
    assert (detail["next_rank"], detail["next_step"]) == (1, "r1")
    assert client.post(f"{path}/mark-sent", json={"rank": -1}).status_code == 422

    body = ok(client.get(path))
    assert (body["sequence"]["sent_count"], body["sequence"]["next_step"]) == (1, "r1")
    assert body["sequence"]["level"] == "contact_sent"
    assert [step["message"] is not None for step in body["steps"]] == [True, False, True]
