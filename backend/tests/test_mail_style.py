"""Tone, sender and proximity of the AI mail (prompt `contact-mail-fr-2026-11-v7`): the pure
prompt rules (`resolve_style`, greeting, closing block, the client card) and the real
`/generate` route with a link between a member and the prospect. No call to OpenAI."""

import uuid
from collections.abc import Iterator
from datetime import date
from typing import Any

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.routes.contact_messages import get_mail_generator
from app.core.config import Settings
from app.models import ContactTracking
from app.models.enums import Civility, CompanyKind, ContactTrackingStatus
from app.services.mail_generation.openai_client import GeneratedMail
from app.services.mail_generation.prompt import (
    BOOKING_LEAD_FAMILIAR,
    CLOSING,
    CLOSING_FAMILIAR,
    CompanyFacts,
    GenerationOptions,
    MailContext,
    ProspectFacts,
    ProximityFacts,
    build_input,
    build_instructions,
    build_prompt,
    expected_greeting,
    mail_block,
    render_client_card,
    resolve_style,
)
from tests.builders import (
    add_company,
    add_email,
    add_phone,
    add_prospect,
    referent_user,
    start_sequence,
)
from tests.test_contact_mail_generation import FakeGenerator
from tests.test_contact_messages_api import SENDER, messages, ok
from tests.test_person_links import make, member
from tests.test_person_links import prospect as person

CLOSE = ProximityFacts(
    score=82,
    state="reachable",
    best_member="Robin Dupont",
    best_strength=90,
    hops=2,
    relations=("collègue", "ami"),
    path_count=2,
)
FAR = ProximityFacts(score=40, state="reachable", best_member="Robin Dupont", hops=1)


def context(**over: Any) -> MailContext:
    values: dict[str, Any] = {
        "rank": 0,
        "prospect": ProspectFacts("M.", "Pierre", "Martin", "DG"),
        "company": CompanyFacts(name="Synthetic Co"),
    }
    return MailContext(**{**values, **over})


# --- resolve_style -----------------------------------------------------------------------------


def test_below_sixty_or_without_link_nobody_is_named_and_the_tone_is_formal() -> None:
    for proximity in (None, FAR, ProximityFacts(0, "empty"), ProximityFacts(0, "unreachable")):
        style = resolve_style(proximity, GenerationOptions())
        assert (style.tone, style.familiar, style.member, style.sender) == (0, False, None, None)


def test_from_sixty_the_closest_member_is_named_and_the_tone_adapts() -> None:
    at_sixty = ProximityFacts(60, "reachable", best_member="Robin Dupont")
    style = resolve_style(at_sixty, GenerationOptions())
    assert (style.tone, style.familiar, style.member, style.sender) == (
        2,
        False,
        "Robin Dupont",
        "ai",
    )
    very_close = resolve_style(CLOSE, GenerationOptions())
    assert (very_close.tone, very_close.familiar) == (4, True)


def test_explicit_options_win_but_a_far_prospect_still_names_nobody() -> None:
    style = resolve_style(FAR, GenerationOptions(tone=5, sender="person"))
    assert (style.tone, style.familiar, style.member, style.sender) == (5, True, None, "person")
    formal = resolve_style(CLOSE, GenerationOptions(tone=0, sender="person"))
    assert (formal.tone, formal.familiar, formal.member, formal.sender) == (
        0,
        False,
        "Robin Dupont",
        "person",
    )
    assert resolve_style(None, GenerationOptions(tone=3)).familiar is True
    assert resolve_style(None, GenerationOptions(tone=2)).familiar is False


# --- the prompt --------------------------------------------------------------------------------


def test_the_greeting_follows_the_tone() -> None:
    facts = ProspectFacts("M.", "Pierre", "Martin")
    assert expected_greeting(facts) == "Bonjour Monsieur Martin,"
    assert expected_greeting(facts, familiar=True) == "Bonjour Pierre,"
    assert expected_greeting(ProspectFacts(last_name="Martin"), familiar=True) == "Bonjour,"
    assert build_prompt(context(proximity=CLOSE)).greeting == "Bonjour Pierre,"
    assert build_prompt(context(proximity=FAR)).greeting == "Bonjour Monsieur Martin,"
    explicit = build_prompt(context(options=GenerationOptions(tone=4)))
    assert (explicit.greeting, explicit.familiar) == ("Bonjour Pierre,", True)


def test_the_instructions_carry_the_tone_the_sender_and_the_proximity_rule() -> None:
    formal = build_instructions(0, 4, None, style=resolve_style(None, GenerationOptions(tone=0)))
    assert "strictement professionnel" in formal and "Vouvoie le destinataire" in formal
    assert "« Bonjour Monsieur Nom, »" in formal
    assert "Circoe s’exprime (« nous »)" in formal
    assert "À partir de 60" in formal and "Ne cite jamais le score" in formal

    friendly = build_instructions(
        0, 4, None, style=resolve_style(CLOSE, GenerationOptions(tone=5, sender="person"))
    )
    assert "Tutoie le destinataire" in friendly and "« Bonjour Prénom, »" in friendly
    assert "écrit directement par Robin Dupont" in friendly
    assert "comment vas-tu" in friendly

    assistant = build_instructions(0, 4, None, style=resolve_style(CLOSE, GenerationOptions()))
    assert "assistant IA de Robin Dupont" in assistant
    assert "« je suis l’assistant de Robin Dupont" in assistant

    anonymous = build_instructions(
        0, 4, None, style=resolve_style(FAR, GenerationOptions(sender="ai"))
    )
    assert "assistant IA de Circoe" in anonymous and "Robin" not in anonymous


def test_the_input_has_a_proximity_section_without_intermediaries_names() -> None:
    text = build_input(context(proximity=CLOSE))

    assert "Proximité avec le prospect (contexte interne" in text
    assert "- Score de proximité : 82/100" in text
    assert "- État : joignable par au moins un membre" in text
    assert "- Membre le plus proche : Robin Dupont (force du meilleur chemin : 90/100)" in text
    assert (
        "- Chemin : 2 lien(s) entre ce membre et le prospect (collègue, ami) ; 2 chemin(s)" in text
    )
    assert "écrit au nom de Robin Dupont" in text and "Ton retenu : 4/5 (tutoiement)" in text
    far = build_input(context(proximity=FAR))
    assert "pas de membre à nommer" in far and "Ton retenu : 0/5 (vouvoiement)" in far
    assert "Proximité" not in build_input(context())


def test_the_closing_block_follows_the_informal_tone() -> None:
    formal = mail_block("https://rdv.example/x")
    friendly = mail_block("https://rdv.example/x", familiar=True)

    assert CLOSING in formal and "Vous pouvez choisir directement votre créneau" in formal
    assert CLOSING_FAMILIAR in friendly and BOOKING_LEAD_FAMILIAR in friendly
    assert "vous" not in friendly.split("DIHNAMO", 1)[1].split("L’équipe")[0].lower()
    assert build_prompt(context(proximity=CLOSE)).familiar is True


# --- the client card ---------------------------------------------------------------------------


def test_the_card_gives_the_whole_sheet_but_no_contact_detail() -> None:
    lines = render_client_card(
        ProspectFacts(
            "Mme",
            "Claire",
            "Martin",
            "DAF",
            "Direction",
            activity_status="Actif",
            employment_verified_on=date(2026, 9, 3),
            commercial_state="Réponse reçue",
        ),
        CompanyFacts(
            name="Synthetic Co",
            size_label="50-99",
            kind_label="PME",
            proposed_services=("iguard", "emailing"),
            city="Le Havre",
            country="France",
        ),
    )

    assert "- Statut d’activité : Actif" in lines
    assert "- Emploi vérifié le : 03/09/2026" in lines
    assert "- État commercial : Réponse reçue" in lines
    assert "- Type d’entreprise : PME" in lines
    assert "- Services proposés : iguard, emailing" in lines
    assert "- Localisation : Le Havre, France" in lines


# --- the route ---------------------------------------------------------------------------------


@pytest.fixture
def fake() -> FakeGenerator:
    return FakeGenerator(
        behaviour=lambda prompt, n: GeneratedMail(
            subject="Objet", body=f"{prompt.greeting}\n\nCorps IA", model="fake-model"
        )
    )


@pytest.fixture
def ai_app(app: FastAPI, fake: FakeGenerator) -> Iterator[FastAPI]:
    app.state.settings = Settings(
        database_url=app.state.settings.database_url,
        default_outbound_email=SENDER,
        openai_api_key=None,
    )
    app.dependency_overrides[get_mail_generator] = lambda: fake
    yield app
    app.dependency_overrides.clear()


def test_generation_uses_the_proximity_and_the_options(
    ai_app: FastAPI, client: TestClient, db_session: Session, fake: FakeGenerator
) -> None:
    robin = referent_user("Robin", "Dupont")
    db_session.add(robin)
    company = add_company(db_session, "Synthetic Co", company_kind=CompanyKind.SME)
    target = add_prospect(
        db_session, company, civility=Civility.MR, first_name="Pierre", last_name="Martin"
    )
    add_email(db_session, target, "pierre.secret@exemple.example", is_primary=True)
    add_phone(db_session, target, "0100000077")
    db_session.add(ContactTracking(prospect_id=target.id, status=ContactTrackingStatus.NEUTRAL))
    db_session.flush()
    start_sequence(db_session, target)
    path = messages(target.id)
    assert (
        make(client, person(target.id), member(robin.id), relation="ami", score=90).status_code
        == 201
    )

    ok(client.post(f"{path}/contact/generate", json={}), 201)

    [auto] = fake.prompts
    assert auto.greeting == "Bonjour Pierre," and auto.familiar is True
    assert "Membre le plus proche : Robin Dupont" in auto.input
    assert "- Score de proximité : 90/100" in auto.input
    assert "pierre.secret" not in auto.input and "0100000077" not in auto.input

    ok(
        client.post(
            f"{path}/contact/generate",
            json={
                "expected_revision": 1,
                "replace": True,
                "options": {"tone": 0, "sender": "person"},
            },
        )
    )
    formal = fake.prompts[1]
    assert formal.greeting == "Bonjour Monsieur Martin," and formal.familiar is False
    assert "écrit directement par Robin Dupont" in formal.instructions


@pytest.mark.parametrize(
    "options",
    [{"tone": 6}, {"tone": -1}, {"sender": "robot"}, {"tone": 3, "extra": 1}, {"tone": "x"}],
)
def test_invalid_options_are_refused(
    ai_app: FastAPI, client: TestClient, db_session: Session, options: dict[str, Any]
) -> None:
    target = add_prospect(db_session, add_company(db_session))
    start_sequence(db_session, target)

    response = client.post(f"{messages(target.id)}/contact/generate", json={"options": options})

    assert response.status_code == 422, response.text


def test_the_unknown_prospect_still_gets_a_clean_refusal(
    ai_app: FastAPI, client: TestClient
) -> None:
    response = client.post(
        f"{messages(uuid.uuid4())}/contact/generate",
        json={"options": {"tone": None, "sender": None}},
    )
    assert response.status_code == 404
