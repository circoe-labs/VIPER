"""Versions of a step's text and saved mails (`contact_message_versions`): every generation, manual
edit and restoration is kept; nothing is lost by a validation; « Sauvegarder » adds a rating, a
comment and the generation config; the default sender needs no typing."""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select, text
from sqlalchemy.orm import Session

from app.core.config import DEFAULT_SENDER_EMAIL, Settings
from app.models import ContactMessageVersion
from app.models.enums import ContactMessageStatus, ContactTrackingStatus
from app.services import contact_message_versions as versions
from app.services import contact_messages as service
from app.services.contact_messages import GeneratedContent, MessageEdit
from app.services.errors import ContactMessageError
from tests.builders import OPERATOR
from tests.test_contact_messages import STEP, create, prospect_with
from tests.test_contact_messages_api import SENDER, messages, ok, prospect_id, refused

M = ContactMessageStatus


@pytest.fixture
def app_with_sender(app: FastAPI) -> FastAPI:
    app.state.settings = Settings(
        database_url=app.state.settings.database_url, default_outbound_email=SENDER
    )
    return app


def kept(session: Session, prospect_id_: object) -> list[ContactMessageVersion]:
    session.flush()
    return list(
        session.scalars(
            select(ContactMessageVersion)
            .where(ContactMessageVersion.prospect_id == prospect_id_)
            .order_by(ContactMessageVersion.created_at, ContactMessageVersion.id)
        )
    )


def ai(subject: str, body: str, **config: object) -> GeneratedContent:
    return GeneratedContent(
        subject=subject, body_text=body, model="fake-model", prompt_version="v1", config=config
    )


def test_a_created_message_is_its_first_manual_version(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    create(db_session, prospect)

    (version,) = kept(db_session, prospect.id)
    assert (version.source, version.subject, version.body_text) == (
        "manual",
        "Objet de test",
        "Corps de test",
    )
    assert version.saved_at is None


def test_consecutive_manual_saves_are_one_version_but_an_ai_text_is_always_a_new_one(
    db_session: Session,
) -> None:
    prospect = prospect_with(db_session)
    message = create(db_session, prospect)
    message = service.save_message(
        db_session,
        OPERATOR,
        prospect.id,
        STEP,
        MessageEdit(expected_revision=message.revision, body_text="Corps 2"),
    ).message
    message = service.save_message(
        db_session,
        OPERATOR,
        prospect.id,
        STEP,
        MessageEdit(expected_revision=message.revision, body_text="Corps 3"),
    ).message
    # A typing session: the manual version follows the text.
    (only,) = kept(db_session, prospect.id)
    assert only.body_text == "Corps 3"

    service.save_generated(
        db_session, OPERATOR, prospect.id, STEP, ai("Objet IA", "Corps IA"), message.revision
    )

    assert [(v.source, v.body_text) for v in kept(db_session, prospect.id)] == [
        ("manual", "Corps 3"),
        ("ai", "Corps IA"),
    ]


def test_an_ai_generation_keeps_the_text_it_replaces_and_its_config(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = create(db_session, prospect)
    # A text that no version holds (written before this table existed).
    db_session.execute(text("DELETE FROM contact_message_versions"))
    db_session.expire_all()

    service.save_generated(
        db_session,
        OPERATOR,
        prospect.id,
        STEP,
        ai("Objet IA", "Corps IA", tone=4, sender="person", instruction="plus court"),
        message.revision,
    )

    old, new = kept(db_session, prospect.id)
    assert (old.source, old.subject) == ("manual", "Objet de test")
    assert (new.source, new.subject) == ("ai", "Objet IA")
    assert new.config == {
        "tone": 4,
        "sender": "person",
        "instruction": "plus court",
        "model": "fake-model",
        "prompt_version": "v1",
    }


def test_restoring_a_version_makes_it_the_draft_and_is_itself_a_version(
    db_session: Session,
) -> None:
    prospect = prospect_with(db_session)
    message = create(db_session, prospect)
    generated = service.save_generated(
        db_session, OPERATOR, prospect.id, STEP, ai("Objet IA", "Corps IA"), message.revision
    ).message
    first = kept(db_session, prospect.id)[0]

    result = service.restore_version(
        db_session, OPERATOR, prospect.id, STEP, first.id, generated.revision
    )

    assert (result.message.subject, result.message.body_text) == ("Objet de test", "Corps de test")
    assert result.message.status is M.DRAFT
    assert result.message.generation_model is None
    sources = [v.source for v in kept(db_session, prospect.id)]
    assert sources == ["manual", "ai", "restore"]
    assert kept(db_session, prospect.id)[-1].config["restored_from"] == str(first.id)


def test_restoring_goes_through_the_edit_rules(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = create(db_session, prospect)
    first = kept(db_session, prospect.id)[0]
    validated = service.validate(db_session, OPERATOR, prospect.id, STEP, message.revision).message
    service.save_message(
        db_session,
        OPERATOR,
        prospect.id,
        STEP,
        MessageEdit(expected_revision=validated.revision, body_text="Autre corps"),
    )
    current = service.get_message(db_session, prospect.id, STEP)
    assert current is not None and current.status is M.DRAFT

    with pytest.raises(ContactMessageError) as stale:
        service.restore_version(
            db_session, OPERATOR, prospect.id, STEP, first.id, current.revision - 1
        )
    assert stale.value.code == "revision_conflict"

    # A validated message restored goes back to draft (the confirmation is the UI's).
    again = service.validate(db_session, OPERATOR, prospect.id, STEP, current.revision).message
    restored = service.restore_version(
        db_session, OPERATOR, prospect.id, STEP, first.id, again.revision
    )
    assert restored.unvalidated and restored.message.status is M.DRAFT


def test_versions_survive_a_validation_and_the_deletion_of_the_draft(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = create(db_session, prospect)
    service.validate(db_session, OPERATOR, prospect.id, STEP, message.revision)
    assert len(kept(db_session, prospect.id)) == 1

    # Deleting a draft is explicit; the versions stay, detached from the deleted row.
    reopened = service.get_message(db_session, prospect.id, STEP)
    assert reopened is not None
    service.cancel(db_session, OPERATOR, prospect.id, STEP, reopened.revision)
    service.reopen(db_session, OPERATOR, prospect.id, STEP, reopened.revision)
    draft = service.get_message(db_session, prospect.id, STEP)
    assert draft is not None
    service.delete_draft(db_session, OPERATOR, prospect.id, STEP, draft.revision)

    (version,) = kept(db_session, prospect.id)
    assert version.message_id is None


def test_save_snapshot_marks_the_latest_version_and_keeps_the_config(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = create(db_session, prospect)
    generated = service.save_generated(
        db_session,
        OPERATOR,
        prospect.id,
        STEP,
        ai("Objet IA", "Corps IA", tone=2),
        message.revision,
    ).message

    saved = versions.save_snapshot(
        db_session, OPERATOR, generated, rating=9, comment="  Super style  ", humanizer_score=84
    )

    assert (saved.rating, saved.comment, saved.saved_by_display) == (
        9,
        "Super style",
        OPERATOR.display,
    )
    assert saved.config["humanizer_score"] == 84 and saved.config["tone"] == 2
    # The AI version itself carries the facet: no duplicate row.
    assert [v.source for v in kept(db_session, prospect.id)] == ["manual", "ai"]
    assert [v.id for v in versions.list_saved(db_session, prospect.id)] == [saved.id]

    # Saving again, with another note, is a second saved mail of the same text.
    again = versions.save_snapshot(db_session, OPERATOR, generated, rating=2, comment=None)
    assert again.id != saved.id
    assert [v.rating for v in versions.list_saved(db_session, prospect.id)] == [2, 9]


def test_save_snapshot_refuses_an_empty_text_and_a_bad_rating(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = service.save_message(db_session, OPERATOR, prospect.id, STEP, MessageEdit()).message
    with pytest.raises(ContactMessageError) as empty:
        versions.save_snapshot(db_session, OPERATOR, message, rating=5, comment=None)
    assert empty.value.code == "message_empty"
    message = create_text(db_session, prospect, message.revision)
    with pytest.raises(ContactMessageError) as bad:
        versions.save_snapshot(db_session, OPERATOR, message, rating=11, comment=None)
    assert bad.value.code == "invalid_rating"
    with pytest.raises(Exception, match="rating_range"):
        db_session.add(
            ContactMessageVersion(
                prospect_id=message.prospect_id,
                sequence_id=message.sequence_id,
                rank=0,
                revision=1,
                source="manual",
                actor_type="human",
                actor_display="x",
                saved_at=datetime.now(UTC),
                saved_by_display="x",
                rating=11,
            )
        )
        db_session.flush()


def create_text(session: Session, prospect: object, revision: int) -> object:
    return service.save_message(
        session,
        OPERATOR,
        prospect.id,  # type: ignore[attr-defined]
        STEP,
        MessageEdit(expected_revision=revision, subject="Objet", body_text="Corps"),
    ).message


def test_a_manual_version_is_not_merged_after_the_window(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    message = create(db_session, prospect)
    (first,) = kept(db_session, prospect.id)
    first.updated_at = datetime.now(UTC) - timedelta(hours=1)
    db_session.flush()
    # The trigger resets `updated_at`: put the old moment back past it.
    db_session.execute(text("ALTER TABLE contact_message_versions DISABLE TRIGGER set_updated_at"))
    db_session.execute(
        text("UPDATE contact_message_versions SET updated_at = now() - interval '1 hour'")
    )
    db_session.execute(text("ALTER TABLE contact_message_versions ENABLE TRIGGER set_updated_at"))
    db_session.expire_all()

    service.save_message(
        db_session,
        OPERATOR,
        prospect.id,
        STEP,
        MessageEdit(expected_revision=message.revision, body_text="Plus tard"),
    )

    assert [v.body_text for v in kept(db_session, prospect.id)] == ["Corps de test", "Plus tard"]


# --- the sender ---------------------------------------------------------------------------------


def test_the_default_sender_is_the_toolbox_account_mailbox(db_session: Session) -> None:
    assert Settings().default_outbound_email == DEFAULT_SENDER_EMAIL == "l.jerier@circoe.com"


def test_a_message_without_sender_validates_and_the_sender_is_not_required(
    db_session: Session,
) -> None:
    prospect = prospect_with(db_session)
    created = service.save_message(
        db_session,
        OPERATOR,
        prospect.id,
        STEP,
        MessageEdit(subject="Objet", body_text="Corps"),
        default_from=None,
    ).message
    assert created.from_email is None

    validated = service.validate(db_session, OPERATOR, prospect.id, STEP, created.revision)

    assert validated.message.status is M.VALIDATED


def test_a_new_message_gets_the_default_sender(db_session: Session) -> None:
    prospect = prospect_with(db_session)
    created = service.save_message(
        db_session,
        OPERATOR,
        prospect.id,
        STEP,
        MessageEdit(subject="Objet", body_text="Corps"),
        default_from=DEFAULT_SENDER_EMAIL,
    ).message
    assert created.from_email == "l.jerier@circoe.com"


# --- the API -------------------------------------------------------------------------------------


def test_the_versions_api_lists_restores_and_saves(
    app_with_sender: FastAPI, client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session, ContactTrackingStatus.NEUTRAL)
    path = f"{messages(prospect)}/contact"
    created = ok(client.put(path, json={"subject": "Objet 1", "body_text": "Corps 1"}), 201)
    ok(client.put(path, json={"expected_revision": 1, "body_text": "Corps 2"}))
    assert created["message"]["from_email"] == SENDER

    listed = ok(client.get(f"{path}/versions"))["versions"]
    assert [(v["source"], v["body_text"]) for v in listed] == [("manual", "Corps 2")]

    saved = ok(client.post(f"{path}/saved", json={"rating": 7, "comment": "Bien"}))
    assert (saved["rating"], saved["comment"], saved["step"], saved["step_label"]) == (
        7,
        "Bien",
        "contact",
        "Contact",
    )
    assert [m["rating"] for m in ok(client.get(f"{messages(prospect)}/saved"))["saved"]] == [7]

    assert client.post(f"{path}/saved", json={"rating": 12}).status_code == 422
    refused(
        client.post(f"{path}/versions/{saved['id']}/restore", json={"expected_revision": 99}),
        409,
        "revision_conflict",
    )
    restored = ok(
        client.post(f"{path}/versions/{saved['id']}/restore", json={"expected_revision": 2})
    )
    assert restored["changed"] is False
    refused(
        client.post(
            f"{path}/versions/00000000-0000-0000-0000-000000000000/restore",
            json={"expected_revision": 2},
        ),
        404,
        "version_not_found",
    )


def test_the_versions_api_needs_a_session(
    app_with_sender: FastAPI, anonymous_client: TestClient, db_session: Session
) -> None:
    prospect = prospect_id(db_session, ContactTrackingStatus.NEUTRAL)
    assert anonymous_client.get(f"{messages(prospect)}/saved").status_code == 401
    assert anonymous_client.get(f"{messages(prospect)}/contact/versions").status_code == 401
