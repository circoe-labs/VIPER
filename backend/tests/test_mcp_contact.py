"""MCP contact drafts (ChatGPT handoff, Slice 07): an assistant writes the mail of a step, and it
stays a draft.

`viper_generate_contact_draft` and `viper_update_contact_draft` go through the editor's services
(`save_generated`, `save_message`, revision checked) with the agent as the actor. They never
validate, schedule or send; a validated, scheduled, cancelled or sent message is refused untouched;
a worker (default capabilities) may not use them. The AI is a fake generator: no model is called.
"""

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import mcp_contact
from app.core.config import Settings
from app.models import ContactMessage
from app.models.audit import AuditLogEntry
from app.models.enums import AgentMode, ContactMessageStatus
from app.models.mcp import McpCall
from app.services import mcp_tokens
from app.services.mail_generation.openai_client import GeneratedMail, generation_error
from app.services.mail_generation.prompt import MailPrompt
from tests.builders import PILOT_EMAIL
from tests.test_contact_mail_generation import FakeGenerator
from tests.test_contact_messages import message_in, prospect_with
from tests.test_mcp_tools import body, call

M = ContactMessageStatus
SENDER = "prospection@exemple.example"
GENERATE = "viper_generate_contact_draft"
UPDATE = "viper_update_contact_draft"


@pytest.fixture
def fake(app: FastAPI, monkeypatch: pytest.MonkeyPatch) -> Iterator[FakeGenerator]:
    app.state.settings = Settings(
        database_url=app.state.settings.database_url,
        default_outbound_email=SENDER,
        openai_api_key=None,
        contact_booking_url="https://rdv.exemple.example/circoe",
    )
    generator = FakeGenerator()
    monkeypatch.setattr(mcp_contact, "mail_generator", lambda state: generator)
    yield generator


def assistant(session: Session) -> str:
    """A ChatGPT-like connector acting for the pilot (a manager or above: every capability)."""
    token, _ = mcp_tokens.mint(
        session,
        label="ChatGPT (test)",
        scopes=["*"],
        mode=AgentMode.INTERACTIVE,
        owner_email=PILOT_EMAIL,
    )
    return token


def refusal(answer: dict[str, Any], code: str) -> dict[str, Any]:
    assert answer["isError"] is True, answer
    content: dict[str, Any] = answer["structuredContent"]
    assert content["code"] == code, content
    return content


def snapshot(session: Session, message_id: uuid.UUID) -> tuple[Any, ...]:
    session.expire_all()
    message = session.get(ContactMessage, message_id)
    assert message is not None
    return (
        message.status,
        message.revision,
        message.subject,
        message.body_text,
        message.validated_revision,
        message.scheduled_at,
        message.sent_at,
    )


# --- catalogue and capability -------------------------------------------------------------------


def test_both_tools_are_listed_as_non_destructive_draft_writes(
    client: TestClient, db_session: Session
) -> None:
    response = client.post(
        "/mcp",
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={"Authorization": f"Bearer {assistant(db_session)}"},
    )
    listed = {tool["name"]: tool for tool in response.json()["result"]["tools"]}

    assert {tool.name: tool.capability for tool in mcp_contact.TOOLS} == {
        GENERATE: "contact.draft",
        UPDATE: "contact.draft",
    }
    for name, open_world in ((GENERATE, True), (UPDATE, False)):
        annotations = listed[name]["annotations"]
        assert annotations["readOnlyHint"] is False
        assert annotations["destructiveHint"] is False
        assert annotations["openWorldHint"] is open_world
        assert listed[name]["inputSchema"]["required"] == ["prospect_id", "step"]
    # No message transition is exposed: the person validates, schedules and sends in VIPER.
    for name in listed:
        assert not any(word in name for word in ("validate", "schedule", "send", "reopen"))


@pytest.mark.parametrize("mode", [AgentMode.WORKER, AgentMode.SCHEDULED])
def test_a_worker_or_scheduled_agent_may_not_draft(
    client: TestClient, db_session: Session, fake: FakeGenerator, mode: AgentMode
) -> None:
    prospect = prospect_with(db_session)
    token, record = mcp_tokens.mint(db_session, label="Worker", scopes=["*"], mode=mode)
    target = {"prospect_id": str(prospect.id), "step": "contact"}

    for name, extra in ((UPDATE, {"subject": "Bonjour"}), (GENERATE, {})):
        denied = refusal(call(client, token, name, {**target, **extra}), "capability_denied")
        assert denied["capability"] == "contact.draft"

    assert fake.prompts == []
    assert (
        db_session.scalars(
            select(ContactMessage).where(ContactMessage.prospect_id == prospect.id)
        ).all()
        == []
    )
    calls = db_session.scalars(select(McpCall).where(McpCall.token_id == record.id)).all()
    assert {(row.outcome, row.error_code) for row in calls} == {("refused", "capability_denied")}


# --- viper_update_contact_draft -----------------------------------------------------------------


def test_update_creates_then_edits_a_draft_with_the_revision_checked(
    client: TestClient, db_session: Session, fake: FakeGenerator
) -> None:
    prospect = prospect_with(db_session)
    token = assistant(db_session)
    target = {"prospect_id": str(prospect.id), "step": "contact"}

    created = body(
        call(client, token, UPDATE, {**target, "subject": "Bonjour", "body_text": "Premier jet."})
    )
    message = created["message"]
    assert (created["created"], message["status"], message["revision"]) == (True, "draft", 1)
    assert (message["from_email"], message["to"]) == (SENDER, ["jean.test@exemple.example"])
    assert (message["validated_at"], message["scheduled_at"], message["sent_at"]) == (
        None,
        None,
        None,
    )

    edited = body(call(client, token, UPDATE, {**target, "expected_revision": 1, "subject": "Re"}))
    assert (edited["message"]["subject"], edited["message"]["revision"]) == ("Re", 2)
    assert (edited["message"]["body_text"], edited["unvalidated"]) == ("Premier jet.", False)

    stale = call(client, token, UPDATE, {**target, "expected_revision": 1, "subject": "Vieux"})
    refusal(stale, "revision_conflict")
    exists = call(client, token, UPDATE, {**target, "subject": "Sans révision"})
    refusal(exists, "message_exists")

    # The same shape as the editor's read.
    assert client.get(f"/api/prospects/{prospect.id}/messages/contact").json() == {
        "message": edited["message"]
    }


def test_the_agent_stays_the_actor_for_its_person(
    client: TestClient, db_session: Session, fake: FakeGenerator
) -> None:
    prospect = prospect_with(db_session)

    created = body(
        call(
            client,
            assistant(db_session),
            UPDATE,
            {"prospect_id": str(prospect.id), "step": "r1", "subject": "Relance"},
        )
    )

    event = db_session.scalars(
        select(AuditLogEntry).where(
            AuditLogEntry.entity_id == uuid.UUID(created["message"]["id"]),
            AuditLogEntry.action == "contact_message.created",
        )
    ).one()
    assert (event.actor_type, event.actor_display) == ("agent", "ChatGPT (test)")
    assert event.context["source"] == "agent"
    assert event.context["on_behalf_of"]["type"] == "human"


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (M.VALIDATED, "agent_draft_only"),
        (M.SCHEDULED, "agent_draft_only"),
        (M.CANCELLED, "agent_draft_only"),
        (M.SENT, "message_sent_immutable"),
    ],
)
def test_update_never_touches_a_validated_scheduled_cancelled_or_sent_message(
    client: TestClient, db_session: Session, fake: FakeGenerator, status: M, code: str
) -> None:
    prospect = prospect_with(db_session)
    message = message_in(db_session, prospect, status)
    before = snapshot(db_session, message.id)
    token = assistant(db_session)

    answer = call(
        client,
        token,
        UPDATE,
        {
            "prospect_id": str(prospect.id),
            "step": "contact",
            "expected_revision": message.revision,
            "subject": "Réécrit par l'assistant",
        },
    )

    refused = refusal(answer, code)
    if code == "agent_draft_only":
        assert refused["status"] == status.value
    assert snapshot(db_session, message.id) == before


@pytest.mark.parametrize(
    "smuggled",
    [
        {"status": "validated"},
        {"scheduled_at": "2030-01-01T09:00:00+01:00"},
        {"validated_revision": 1},
        {"sent_at": "2030-01-01T09:00:00+01:00"},
    ],
)
def test_update_accepts_no_status_validation_or_send_moment(
    client: TestClient, db_session: Session, fake: FakeGenerator, smuggled: dict[str, Any]
) -> None:
    prospect = prospect_with(db_session)
    message = message_in(db_session, prospect, M.DRAFT)
    before = snapshot(db_session, message.id)

    answer = call(
        client,
        assistant(db_session),
        UPDATE,
        {
            "prospect_id": str(prospect.id),
            "step": "contact",
            "expected_revision": message.revision,
            **smuggled,
        },
    )

    refused = refusal(answer, "invalid")
    assert refused["field"] == next(iter(smuggled))
    assert snapshot(db_session, message.id) == before


def test_update_refuses_a_bad_target(
    client: TestClient, db_session: Session, fake: FakeGenerator
) -> None:
    token = assistant(db_session)
    prospect = prospect_with(db_session)

    assert (
        refusal(call(client, token, UPDATE, {"prospect_id": "x", "step": "contact"}), "format")[
            "field"
        ]
        == "prospect_id"
    )
    assert (
        refusal(
            call(client, token, UPDATE, {"prospect_id": str(prospect.id), "step": "r0"}), "format"
        )["field"]
        == "step"
    )
    closed = prospect_with(db_session, in_cohort=False)
    refusal(
        call(client, token, UPDATE, {"prospect_id": str(closed.id), "step": "contact"}),
        "no_open_sequence",
    )


# --- viper_generate_contact_draft ---------------------------------------------------------------


def test_generate_writes_an_ai_draft_and_nothing_else(
    client: TestClient, db_session: Session, fake: FakeGenerator
) -> None:
    prospect = prospect_with(db_session)
    token = assistant(db_session)
    target = {"prospect_id": str(prospect.id), "step": "contact"}

    created = body(call(client, token, GENERATE, {**target, "instruction": "Ton direct."}))

    message = created["message"]
    assert created["created"] is True
    assert (message["status"], message["subject"], message["body_text"]) == (
        "draft",
        "Objet IA 1",
        "Corps IA 1",
    )
    assert (message["generation_model"], created["generation"]["model"]) == (
        "fake-model",
        "fake-model",
    )
    assert (message["validated_at"], message["scheduled_at"], message["sent_at"]) == (
        None,
        None,
        None,
    )
    assert "Ton direct." in fake.prompts[0].input + fake.prompts[0].instructions

    # A text is there: replacing it needs the confirmation, then the revision moves.
    refusal(
        call(client, token, GENERATE, {**target, "expected_revision": 1}),
        "replace_confirmation_required",
    )
    again = body(call(client, token, GENERATE, {**target, "expected_revision": 1, "replace": True}))
    assert (again["message"]["subject"], again["message"]["revision"]) == ("Objet IA 2", 2)
    assert len(fake.prompts) == 2


@pytest.mark.parametrize(
    ("status", "code"),
    [
        (M.VALIDATED, "agent_draft_only"),
        (M.SCHEDULED, "invalid_transition"),
        (M.CANCELLED, "message_cancelled"),
        (M.SENT, "message_sent_immutable"),
    ],
)
def test_generate_never_touches_a_validated_scheduled_cancelled_or_sent_message(
    client: TestClient, db_session: Session, fake: FakeGenerator, status: M, code: str
) -> None:
    prospect = prospect_with(db_session)
    message = message_in(db_session, prospect, status)
    before = snapshot(db_session, message.id)

    answer = call(
        client,
        assistant(db_session),
        GENERATE,
        {
            "prospect_id": str(prospect.id),
            "step": "contact",
            "expected_revision": message.revision,
            "replace": True,
        },
    )

    refusal(answer, code)
    assert fake.prompts == []  # refused before any AI call
    assert snapshot(db_session, message.id) == before


def test_a_failed_or_unconfigured_ai_writes_nothing(
    client: TestClient,
    db_session: Session,
    fake: FakeGenerator,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    prospect = prospect_with(db_session)
    token = assistant(db_session)
    target = {"prospect_id": str(prospect.id), "step": "contact"}

    def timeout(prompt: MailPrompt, n: int) -> GeneratedMail:
        raise generation_error("ai_timeout", "The AI did not answer in time.")

    fake.behaviour = timeout
    refused = refusal(call(client, token, GENERATE, target), "ai_timeout")
    assert "upstream_status" not in refused

    monkeypatch.setattr(mcp_contact, "mail_generator", lambda state: None)
    refusal(call(client, token, GENERATE, target), "ai_not_configured")

    assert (
        db_session.scalars(
            select(ContactMessage).where(ContactMessage.prospect_id == prospect.id)
        ).all()
        == []
    )
