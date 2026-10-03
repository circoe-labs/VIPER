"""`POST /api/prospects/{id}/messages/{step}/generate` (Contact port Slice S5): the AI draft of a
Contact / R1 / R2 message through the real route, with a fake generator (no call to OpenAI, P6):
always a draft, the minimal data sent, refusals before any AI call, nothing written on failure,
the explicit replace confirmation, concurrency with a person's edit, audit and history."""

import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.api.routes.contact_messages import get_mail_generator
from app.core.config import Settings
from app.db.session import unit_of_work
from app.models import (
    ActivityCategory,
    AuditLogEntry,
    CommercialSegment,
    ContactMessage,
    ContactTracking,
    ContactTrackingStatusHistory,
    Prospect,
    ProspectNote,
)
from app.models.enums import (
    Civility,
    ContactabilityStatus,
    ContactMessageStatus,
    ContactMessageStep,
    ContactTrackingStatus,
    NoteSourceType,
)
from app.services import audit, contact_messages
from app.services.contact_mail_generation import ContextLimits, load_context
from app.services.contact_messages import MessageEdit
from app.services.errors import MailGenerationError
from app.services.mail_generation.openai_client import GeneratedMail, generation_error
from app.services.mail_generation.prompt import PROMPT_VERSION, MailPrompt
from tests.builders import OPERATOR, add_company, add_email, add_phone, add_prospect, add_role
from tests.test_contact_messages_api import SENDER, messages, ok, refused

SECRET_EMAIL = "claire.secret@exemple.example"
SECRET_PHONE = "0100000099"
BOOKING = "https://rdv.exemple.example/circoe"


@dataclass
class FakeGenerator:
    """Answers `Objet IA <n>` / `Corps IA <n>`, or runs `behaviour` (which may raise)."""

    behaviour: Callable[[MailPrompt, int], GeneratedMail] | None = None
    prompts: list[MailPrompt] = field(default_factory=list)

    def generate(self, prompt: MailPrompt) -> GeneratedMail:
        self.prompts.append(prompt)
        n = len(self.prompts)
        if self.behaviour is not None:
            return self.behaviour(prompt, n)
        return GeneratedMail(subject=f"Objet IA {n}", body=f"Corps IA {n}", model="fake-model")


@pytest.fixture
def fake() -> FakeGenerator:
    return FakeGenerator()


@pytest.fixture
def ai_app(app: FastAPI, fake: FakeGenerator) -> Iterator[FastAPI]:
    app.state.settings = Settings(
        database_url=app.state.settings.database_url,
        default_outbound_email=SENDER,
        openai_api_key=None,
        contact_booking_url=BOOKING,
    )
    app.dependency_overrides[get_mail_generator] = lambda: fake
    yield app
    app.dependency_overrides.clear()


@pytest.fixture
def prospect(db_session: Session) -> uuid.UUID:
    segment = CommercialSegment(slug="pme-test", label="PME test")
    category = ActivityCategory(slug="transport-test", label="Transport test")
    db_session.add_all([segment, category])
    db_session.flush()
    company = add_company(
        db_session,
        "Synthetic Co",
        website_url="https://synthetic.example",
        siren="123456782",
        size_label="50-99",
        commercial_segment_id=segment.id,
        project_type="Automatisation",
        circoe_references="Projet X (validé)",
    )
    company.activity_categories.append(category)
    person = add_prospect(
        db_session,
        company,
        civility=Civility.MS,
        first_name="Claire",
        last_name="Martin",
        exact_job_title="DAF",
        role_id=add_role(db_session, "direction-test", "Direction test").id,
    )
    add_email(db_session, person, SECRET_EMAIL, is_primary=True)
    add_phone(db_session, person, SECRET_PHONE)
    db_session.add(ContactTracking(prospect_id=person.id, status=ContactTrackingStatus.NEUTRAL))
    db_session.flush()
    return person.id


def generate(client: TestClient, prospect: uuid.UUID, step: str = "contact", **body: Any) -> Any:
    return client.post(f"{messages(prospect)}/{step}/generate", json=body)


def snapshot(session: Session) -> tuple[Any, ...]:
    session.expire_all()
    return (
        [
            (m.step, m.status, m.revision, m.subject, m.body_text, m.generation_model)
            for m in session.scalars(select(ContactMessage).order_by(ContactMessage.step))
        ],
        session.scalar(select(func.count()).select_from(AuditLogEntry)),
        [(t.status, t.planned_contact_at) for t in session.scalars(select(ContactTracking))],
        session.scalar(select(func.count()).select_from(ContactTrackingStatusHistory)),
    )


def save(
    session: Session, prospect: uuid.UUID, step: str = "contact", **edit: Any
) -> ContactMessage:
    contact_messages.save_message(
        session,
        OPERATOR,
        prospect,
        ContactMessageStep(step),
        MessageEdit(**edit),
        default_from=SENDER,
    )
    session.flush()
    message = contact_messages.get_message(session, prospect, ContactMessageStep(step))
    assert message is not None
    return message


# --- the happy path ----------------------------------------------------------------------------


def test_a_generation_creates_a_draft_and_changes_no_state(
    ai_app: FastAPI,
    client: TestClient,
    db_session: Session,
    prospect: uuid.UUID,
    fake: FakeGenerator,
) -> None:
    before = snapshot(db_session)

    body = ok(generate(client, prospect), 201)

    message = body["message"]
    assert (body["created"], body["changed"], body["unvalidated"]) == (True, True, False)
    assert body["generation"] == {"model": "fake-model", "prompt_version": PROMPT_VERSION}
    assert (message["status"], message["revision"]) == ("draft", 1)
    assert (message["subject"], message["body_text"]) == ("Objet IA 1", "Corps IA 1")
    assert (message["generation_model"], message["generation_prompt_version"]) == (
        "fake-model",
        PROMPT_VERSION,
    )
    assert message["generated_at"] is not None and message["validated_at"] is None
    assert (message["from_email"], message["to"]) == (SENDER, [SECRET_EMAIL])
    after = snapshot(db_session)
    assert after[2:] == before[2:]  # no state, week or history change

    # Minimal data: the facts VIPER holds, never an address, a phone or the SIREN.
    [prompt] = fake.prompts
    sent = f"{prompt.instructions}\n{prompt.input}"
    for secret in (SECRET_EMAIL, SECRET_PHONE, "123456782"):
        assert secret not in sent
    for fact in (
        "- Civilité : Mme",
        "- Prénom : Claire",
        "- Nom : Martin",
        "- Fonction : DAF",
        "- Rôle : Direction test",
        "- Nom : Synthetic Co",
        "- Site web : https://synthetic.example",
        "- Taille : 50-99",
        "- Segment : PME test",
        "- Activité : Transport test",
        "- Type de projet : Automatisation",
        "- Références Circoe pertinentes : Projet X (validé)",
    ):
        assert fact in prompt.input
    assert f"recopié exactement : {BOOKING}." in prompt.instructions


def test_audit_and_history_say_the_ai_wrote_a_draft_never_what(
    ai_app: FastAPI, client: TestClient, db_session: Session, prospect: uuid.UUID
) -> None:
    ok(generate(client, prospect), 201)

    [event] = db_session.scalars(
        select(AuditLogEntry).where(AuditLogEntry.action == "contact_message.generated")
    ).all()
    assert (event.subject_type, event.subject_id) == ("prospect", prospect)
    assert event.actor_type == "human"
    payload = str(event.changes)
    assert "Objet IA 1" not in payload and "Corps IA 1" not in payload
    assert SECRET_EMAIL not in payload
    assert "[masked]" in payload
    history = ok(client.get(f"/api/prospects/{prospect}/history"))
    assert history["items"][0]["title"] == "Brouillon rédigé par l’IA"


def test_a_regeneration_needs_the_confirmation_and_unvalidates(
    ai_app: FastAPI,
    client: TestClient,
    db_session: Session,
    prospect: uuid.UUID,
    fake: FakeGenerator,
) -> None:
    ok(generate(client, prospect), 201)
    path = f"{messages(prospect)}/contact"
    ok(client.post(f"{path}/validate", json={"expected_revision": 1}))

    refused(generate(client, prospect, expected_revision=1), 409, "replace_confirmation_required")
    assert len(fake.prompts) == 1

    body = ok(
        generate(client, prospect, expected_revision=1, instruction=" Plus court ", replace=True)
    )

    assert (body["created"], body["unvalidated"]) == (False, True)
    message = body["message"]
    assert (message["status"], message["revision"], message["subject"]) == (
        "draft",
        2,
        "Objet IA 2",
    )
    assert message["validated_at"] is None and message["validated_revision"] is None
    assert "Consigne de l’utilisateur pour cette version :\nPlus court" in fake.prompts[1].input
    assert "Version actuelle de ce message" in fake.prompts[1].input
    assert "Objet : Objet IA 1" in fake.prompts[1].input
    tracking = db_session.scalar(
        select(ContactTracking).where(ContactTracking.prospect_id == prospect)
    )
    assert tracking is not None and tracking.status is ContactTrackingStatus.NEUTRAL


def test_an_empty_saved_message_needs_no_confirmation(
    ai_app: FastAPI, client: TestClient, db_session: Session, prospect: uuid.UUID
) -> None:
    save(db_session, prospect, subject="", body_text="")

    body = ok(generate(client, prospect, expected_revision=1))

    assert body["message"]["subject"] == "Objet IA 1"


def test_follow_ups_get_the_recorded_earlier_steps(
    ai_app: FastAPI,
    client: TestClient,
    db_session: Session,
    prospect: uuid.UUID,
    fake: FakeGenerator,
) -> None:
    save(db_session, prospect, subject="Premier objet", body_text="Premier corps")
    ok(generate(client, prospect, "r1"), 201)
    assert "Message Contact déjà rédigé (Brouillon) :\nObjet : Premier objet" in (
        fake.prompts[0].input
    )

    contact_messages.cancel(db_session, OPERATOR, prospect, ContactMessageStep.CONTACT, 1)
    db_session.flush()
    ok(generate(client, prospect, "r2"), 201)
    assert "Premier objet" not in fake.prompts[1].input
    assert "Message R1 déjà rédigé (Brouillon) :\nObjet : Objet IA 1" in fake.prompts[1].input


def add_note(
    session: Session, prospect: uuid.UUID, fact: str, delta: int | None = None, **fields: Any
) -> ProspectNote:
    note = ProspectNote(prospect_id=prospect, fact_text=fact, score_delta=delta, **fields)
    session.add(note)
    session.flush()
    return note


def test_without_notes_the_prompt_has_no_facts_and_no_score_section(
    ai_app: FastAPI,
    client: TestClient,
    prospect: uuid.UUID,
    fake: FakeGenerator,
) -> None:
    ok(generate(client, prospect), 201)

    sent = fake.prompts[0].input
    assert "Faits connus" not in sent
    assert "Score prospect" not in sent and "Total" not in sent


def test_notes_and_score_reach_the_prompt_never_the_excluded_data(
    ai_app: FastAPI,
    client: TestClient,
    db_session: Session,
    prospect: uuid.UUID,
    fake: FakeGenerator,
) -> None:
    add_note(
        db_session,
        prospect,
        "A liké un post",
        5,
        noted_on=date(2026, 9, 12),
        source_type=NoteSourceType.LINKEDIN,
        source_label="post Acme",
    )
    add_note(db_session, prospect, "Pas intéressé par le sujet", -20, noted_on=date(2026, 9, 20))
    add_note(db_session, prospect, "Vient de changer de poste")

    ok(generate(client, prospect), 201)

    [prompt] = fake.prompts
    sent = f"{prompt.instructions}\n{prompt.input}"
    assert (
        "Faits connus sur la personne (du plus récent au plus ancien) :\n"
        "1. Pas intéressé par le sujet (20/09/2026)\n"
        "2. A liké un post (12/09/2026, LinkedIn post Acme)\n"
        "3. Vient de changer de poste"
    ) in prompt.input
    assert "- Total : 35/100" in prompt.input and "- Niveau : rouge" in prompt.input
    assert "  - -20 : voir fait n°1\n  - +5 : voir fait n°2" in prompt.input
    assert prompt.input.count("Pas int") == 1
    for excluded in (SECRET_EMAIL, SECRET_PHONE, "123456782", "NEUTRAL", "neutral"):
        assert excluded not in sent


def test_the_context_caps_notes_and_orders_contributions_by_strength(
    db_session: Session, prospect: uuid.UUID
) -> None:
    for index in range(4):
        add_note(
            db_session, prospect, f"Fait {index}", 1 + index, noted_on=date(2026, 9, 1 + index)
        )
    add_note(db_session, prospect, "Gros signal négatif", -9, noted_on=date(2026, 8, 1))
    add_note(db_session, prospect, "x" * 900, noted_on=date(2026, 7, 1))

    context = load_context(
        db_session,
        prospect,
        ContactMessageStep.CONTACT,
        instruction=None,
        booking_url=None,
        limits=ContextLimits(max_notes=3, max_contributions=2),
    )

    assert [note.fact_text for note in context.notes] == ["Fait 3", "Fait 2", "Fait 1"]
    assert context.prospect_score is not None
    # « Gros signal négatif » is beyond the 3 listed notes: its text stays; « Fait 3 » is fact 1.
    assert [(c.reason, c.delta, c.note_rank) for c in context.prospect_score.top_contributions] == [
        ("Gros signal négatif", -9, None),
        ("Fait 3", 4, 1),
    ]
    assert context.prospect_score.total == 50 + 1 + 2 + 3 + 4 - 9
    long = load_context(
        db_session,
        prospect,
        ContactMessageStep.CONTACT,
        instruction=None,
        booking_url=None,
        limits=ContextLimits(max_notes=20),
    )
    assert len(long.notes[-1].fact_text) == 300 and long.notes[-1].fact_text.endswith("…")


def test_a_score_without_signal_is_not_given_to_the_prompt(
    db_session: Session, prospect: uuid.UUID
) -> None:
    add_note(db_session, prospect, "Simple observation")

    context = load_context(
        db_session, prospect, ContactMessageStep.CONTACT, instruction=None, booking_url=None
    )

    assert [note.fact_text for note in context.notes] == ["Simple observation"]
    assert context.prospect_score is None


def test_the_availability_flag(
    app: FastAPI, client: TestClient, db_session: Session, prospect: uuid.UUID
) -> None:
    assert ok(client.get(messages(prospect)))["defaults"]["generation_available"] is False
    app.state.settings = Settings(
        database_url=app.state.settings.database_url, openai_api_key="sk-fake", openai_model="m"
    )
    body = client.get(messages(prospect))
    assert ok(body)["defaults"]["generation_available"] is True
    assert "sk-fake" not in body.text


# --- nothing written on failure ----------------------------------------------------------------


@pytest.mark.parametrize(
    "code",
    ["ai_timeout", "ai_invalid_output", "ai_upstream_error", "ai_rate_limited", "ai_refused"],
)
def test_an_ai_failure_writes_nothing(
    ai_app: FastAPI, client: TestClient, db_session: Session, prospect: uuid.UUID, code: str
) -> None:
    def fail(_: MailPrompt, __: int) -> GeneratedMail:
        raise generation_error(code, "échec")

    ai_app.dependency_overrides[get_mail_generator] = lambda: FakeGenerator(fail)
    save(db_session, prospect, subject="Manuel", body_text="Corps manuel")
    before = snapshot(db_session)

    detail = refused(
        generate(client, prospect, expected_revision=1, replace=True), detail_status(code), code
    )

    assert detail["message"] == "échec"
    assert snapshot(db_session) == before
    refused(generate(client, prospect, "r1"), detail_status(code), code)
    assert contact_messages.get_message(db_session, prospect, ContactMessageStep.R1) is None


def detail_status(code: str) -> int:
    return {"ai_timeout": 504, "ai_rate_limited": 429, "ai_refused": 422}.get(code, 502)


def test_an_adapter_crash_is_an_upstream_error(
    ai_app: FastAPI, client: TestClient, db_session: Session, prospect: uuid.UUID
) -> None:
    def crash(_: MailPrompt, __: int) -> GeneratedMail:
        raise RuntimeError("bug")

    ai_app.dependency_overrides[get_mail_generator] = lambda: FakeGenerator(crash)

    refused(generate(client, prospect), 502, "ai_upstream_error")
    assert contact_messages.get_message(db_session, prospect, ContactMessageStep.CONTACT) is None


def test_not_configured_names_the_settings_and_writes_nothing(
    app: FastAPI, client: TestClient, db_session: Session, prospect: uuid.UUID
) -> None:
    before = snapshot(db_session)

    detail = refused(generate(client, prospect), 503, "ai_not_configured")

    assert "VIPER_OPENAI_API_KEY" in detail["message"]
    assert snapshot(db_session) == before


# --- refusals before any AI call ---------------------------------------------------------------


def test_refusals_before_any_ai_call(
    ai_app: FastAPI,
    client: TestClient,
    db_session: Session,
    prospect: uuid.UUID,
    fake: FakeGenerator,
) -> None:
    save(db_session, prospect, subject="S", body_text="B")
    refused(generate(client, prospect), 409, "message_exists")
    refused(generate(client, prospect, expected_revision=9, replace=True), 409, "revision_conflict")
    refused(generate(client, prospect, "r1", expected_revision=1), 404, "message_not_found")
    refused(generate(client, uuid.uuid4()), 404, "not_found")

    contact_messages.validate(db_session, OPERATOR, prospect, ContactMessageStep.CONTACT, 1)
    contact_messages.schedule(
        db_session,
        OPERATOR,
        prospect,
        ContactMessageStep.CONTACT,
        1,
        datetime.now(UTC) + timedelta(days=2),
    )
    db_session.flush()
    detail = refused(
        generate(client, prospect, expected_revision=1, replace=True), 409, "invalid_transition"
    )
    assert detail["status"] == "scheduled"

    contact_messages.cancel(db_session, OPERATOR, prospect, ContactMessageStep.CONTACT, 1)
    db_session.flush()
    refused(generate(client, prospect, expected_revision=1, replace=True), 409, "message_cancelled")

    assert fake.prompts == []


def test_a_sent_message_is_immutable(
    ai_app: FastAPI,
    client: TestClient,
    db_session: Session,
    prospect: uuid.UUID,
    fake: FakeGenerator,
) -> None:
    message = save(db_session, prospect, subject="S", body_text="B")
    now = datetime.now(UTC)
    message.status = ContactMessageStatus.SENT
    message.sent_at = message.validated_at = now
    message.validated_revision = message.revision
    message.validated_by_actor_id = "x"
    db_session.flush()

    refused(
        generate(client, prospect, expected_revision=1, replace=True), 409, "message_sent_immutable"
    )
    assert fake.prompts == []


@pytest.mark.parametrize(
    ("state", "code"),
    [
        (ContactTrackingStatus.RESPONSE_RECEIVED, "prospect_sequence_closed"),
        (ContactTrackingStatus.APPOINTMENT_OBTAINED, "prospect_sequence_closed"),
        (None, "prospect_do_not_contact"),
    ],
)
def test_a_closed_sequence_refuses(
    ai_app: FastAPI,
    client: TestClient,
    db_session: Session,
    prospect: uuid.UUID,
    fake: FakeGenerator,
    state: ContactTrackingStatus | None,
    code: str,
) -> None:
    tracking = db_session.scalar(
        select(ContactTracking).where(ContactTracking.prospect_id == prospect)
    )
    assert tracking is not None
    if state is None:
        person = db_session.get(Prospect, prospect)
        assert person is not None
        person.contactability_status = ContactabilityStatus.DO_NOT_CONTACT
        person.do_not_contact_at = datetime.now(UTC)
    else:
        tracking.status = state
    db_session.flush()

    refused(generate(client, prospect), 409, code)
    assert fake.prompts == []


def test_the_payload_is_strict(
    ai_app: FastAPI, client: TestClient, prospect: uuid.UUID, fake: FakeGenerator
) -> None:
    for body in (
        {"status": "validated"},
        {"model": "x"},
        {"instruction": "x" * 1001},
        {"expected_revision": 0},
        {"replace": "peut-être"},
    ):
        assert generate(client, prospect, **body).status_code == 422, body
    ok(generate(client, prospect, instruction="x" * 1000), 201)
    assert fake.prompts[0].input.endswith("x" * 1000)


def test_a_person_is_required(
    ai_app: FastAPI, anonymous_client: TestClient, prospect: uuid.UUID
) -> None:
    assert generate(anonymous_client, prospect).status_code == 401


# --- concurrency: the AI call runs outside any transaction -------------------------------------


def test_no_transaction_is_open_during_the_ai_call(
    ai_app: FastAPI, client: TestClient, prospect: uuid.UUID
) -> None:
    """The call can last a minute: the request's transaction (and the session row lock the auth's
    last-seen update may hold) is over before it starts."""
    opened: list[Session] = []

    class Recording(Session):
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            super().__init__(*args, **kwargs)
            opened.append(self)

    factory: sessionmaker[Session] = ai_app.state.session_factory
    ai_app.state.session_factory = sessionmaker(class_=Recording, **factory.kw)
    seen: list[bool] = []

    def check(_: MailPrompt, __: int) -> GeneratedMail:
        seen.append(any(session.in_transaction() for session in opened))
        return GeneratedMail("Objet", "Corps", "fake-model")

    ai_app.dependency_overrides[get_mail_generator] = lambda: FakeGenerator(check)
    try:
        ok(generate(client, prospect), 201)
    finally:
        ai_app.state.session_factory = factory
    assert opened and seen == [False]


def test_a_human_edit_during_the_ai_call_wins(
    ai_app: FastAPI, client: TestClient, db_session: Session, prospect: uuid.UUID
) -> None:
    save(db_session, prospect, subject="S", body_text="B")
    factory: sessionmaker[Session] = ai_app.state.session_factory

    def human_edit(_: MailPrompt, __: int) -> GeneratedMail:
        with unit_of_work(factory) as other:
            audit.bind(other, OPERATOR)
            contact_messages.save_message(
                other,
                OPERATOR,
                prospect,
                ContactMessageStep.CONTACT,
                MessageEdit(expected_revision=1, subject="Humain", body_text="Saisie humaine"),
            )
        return GeneratedMail("IA", "IA", "fake-model")

    ai_app.dependency_overrides[get_mail_generator] = lambda: FakeGenerator(human_edit)

    refused(generate(client, prospect, expected_revision=1, replace=True), 409, "revision_conflict")

    db_session.expire_all()
    message = contact_messages.get_message(db_session, prospect, ContactMessageStep.CONTACT)
    assert message is not None
    assert (message.subject, message.revision, message.generation_model) == ("Humain", 2, None)


def test_a_schedule_during_the_ai_call_is_not_undone(
    ai_app: FastAPI, client: TestClient, db_session: Session, prospect: uuid.UUID
) -> None:
    save(db_session, prospect, subject="S", body_text="B")
    contact_messages.validate(db_session, OPERATOR, prospect, ContactMessageStep.CONTACT, 1)
    db_session.flush()
    factory: sessionmaker[Session] = ai_app.state.session_factory

    def schedule(_: MailPrompt, __: int) -> GeneratedMail:
        with unit_of_work(factory) as other:
            audit.bind(other, OPERATOR)
            contact_messages.schedule(
                other,
                OPERATOR,
                prospect,
                ContactMessageStep.CONTACT,
                1,
                datetime.now(UTC) + timedelta(days=2),
            )
        return GeneratedMail("IA", "IA", "fake-model")

    ai_app.dependency_overrides[get_mail_generator] = lambda: FakeGenerator(schedule)

    refused(
        generate(client, prospect, expected_revision=1, replace=True), 409, "invalid_transition"
    )

    db_session.expire_all()
    message = contact_messages.get_message(db_session, prospect, ContactMessageStep.CONTACT)
    assert message is not None
    assert (message.status, message.subject) == (ContactMessageStatus.SCHEDULED, "S")


def test_typed_errors_carry_no_secret() -> None:
    error = generation_error("ai_auth_failed", "refused", upstream_status=401, upstream_code="x")

    assert isinstance(error, MailGenerationError)
    assert (error.http_status, error.upstream_status) == (502, 401)


# --- a person's rewrite ends the AI provenance -------------------------------------------------


def test_a_human_text_edit_clears_the_ai_provenance_and_the_history_keeps_it(
    ai_app: FastAPI, client: TestClient, db_session: Session, prospect: uuid.UUID
) -> None:
    ok(generate(client, prospect), 201)
    path = f"{messages(prospect)}/contact"

    # Recipients only: still the AI's text.
    kept = ok(client.put(path, json={"expected_revision": 1, "cc": ["copie@exemple.example"]}))
    assert kept["message"]["generation_model"] == "fake-model"
    assert kept["message"]["generation_prompt_version"] == PROMPT_VERSION
    assert kept["message"]["generated_at"] is not None

    edited = ok(
        client.put(path, json={"expected_revision": 2, "body_text": "Corps relu et réécrit"})
    )
    message = edited["message"]
    assert (message["generation_model"], message["generation_prompt_version"]) == (None, None)
    assert message["generated_at"] is None

    updates = [
        str(event.changes)
        for event in db_session.scalars(
            select(AuditLogEntry).where(AuditLogEntry.action == "contact_message.updated")
        )
    ]
    # Only the text edit changed the generation fields; its before values keep the provenance.
    assert [("fake-model" in changes) for changes in updates].count(True) == 1
    assert not any("Corps relu" in changes for changes in updates)
