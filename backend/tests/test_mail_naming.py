"""How a mail names a function and a company, and what the AI adapter enforces about it
(user feedback 2026-11-27, item 1). Synthetic names only; no real call to OpenAI."""

import json

import pytest

from app.services.errors import MailGenerationError
from app.services.mail_generation.naming import organisations, short_title
from app.services.mail_generation.openai_client import personalisation_problems
from app.services.mail_generation.prompt import (
    CompanyFacts,
    MailContext,
    MailPrompt,
    ProspectFacts,
    build_prompt,
)
from tests.test_mail_generation import TEXT, FakeOpenAI, ok, responses_payload

LONG = "Directeur des opérations logistiques et transport Europe"


@pytest.mark.parametrize(
    ("title", "company", "expected"),
    [
        (LONG, None, "Directeur"),
        ("Directrice Générale Adjointe en charge des achats", None, "Directrice générale"),
        ("Global Supply Chain Director", None, "Directeur"),
        ("Chef de projet transformation digitale senior", None, "Chef de projet"),
        ("Responsable logistique", None, "Responsable logistique"),
        ("Directeur Logistique Alpha Transport", "Alpha Transport", "Directeur Logistique"),
        ("Gérant / Président de Beta", None, "Gérant"),
        ("En charge de toute la partie administrative", None, None),
        (None, None, None),
    ],
)
def test_a_long_title_is_reduced_to_its_level(
    title: str | None, company: str | None, expected: str | None
) -> None:
    assert short_title(title, company) == expected


@pytest.mark.parametrize(
    ("label", "expected"),
    [
        ("Alpha SAS / Beta Logistique", ["Alpha", "Beta Logistique"]),
        ("Alpha + Beta", ["Alpha", "Beta"]),
        ("Alpha – Quai des Essais", ["Alpha"]),  # noqa: RUF001
        ("Alpha & Fils", ["Alpha & Fils"]),
        ("Alpha / ALPHA", ["Alpha"]),
        (None, []),
    ],
)
def test_the_organisations_of_a_label(label: str | None, expected: list[str]) -> None:
    assert organisations(label) == expected


def prompt_for(company: str, title: str = LONG) -> MailPrompt:
    return build_prompt(
        MailContext(
            rank=0,
            prospect=ProspectFacts("Mme", "Claire", "Martin", title),
            company=CompanyFacts(name=company, website="https://alpha.example"),
        )
    )


def test_the_card_gives_the_short_function_and_the_rules() -> None:
    prompt = prompt_for("Alpha")

    assert "- Fonction : Directeur\n" in prompt.input
    assert f"Intitulé complet (contexte seulement, ne pas recopier) : {LONG}" in prompt.input
    assert (prompt.company, prompt.unattached_companies, prompt.long_title) == ("Alpha", (), LONG)
    assert "au plus une fois" in prompt.instructions
    # A prompt saved in Paramètres cannot lift the rules.
    custom = build_prompt(
        MailContext(
            rank=0,
            prospect=ProspectFacts(),
            company=CompanyFacts(),
            initial_prompt="Consigne maison.",
        )
    )
    assert custom.instructions.startswith("Consigne maison.")
    assert "propre à ce destinataire" in custom.instructions


def test_a_card_with_several_companies_names_none_of_them() -> None:
    prompt = prompt_for("Alpha / Beta Logistique")

    assert "Alpha" not in prompt.input and "Beta" not in prompt.input
    assert "rattachement non déterminé" in prompt.input
    assert prompt.company is None
    assert prompt.unattached_companies == ("Alpha", "Beta Logistique")


def answer(subject: str, middle: str = "Votre activité m’intéresse.") -> str:
    body = f"Bonjour Madame Martin,\n\n{middle}\n\nUn échange de 30 minutes ?"
    return json.dumps({"subject": subject, "body": body})


def checked(**over: object) -> MailPrompt:
    values: dict[str, object] = {
        "instructions": "instructions",
        "input": "input",
        "greeting": "Bonjour Madame Martin,",
    }
    return MailPrompt(**{**values, **over})  # type: ignore[arg-type]


def test_the_checks_name_each_problem() -> None:
    body = "Bonjour Monsieur Alpha,\n\nAlpha avance. Chez ALPHA, tout compte."
    repeated = personalisation_problems("Objet", body, checked(company="Alpha"))
    assert len(repeated) == 1 and "répété" in repeated[0]
    # The greeting may carry a family name equal to the company's.
    once = "Bonjour Monsieur Alpha,\n\nAlpha avance."
    assert personalisation_problems("Alpha : un point", once, checked(company="Alpha")) == []
    assert personalisation_problems(
        "Pour Beta", once, checked(unattached_companies=("Alpha", "Beta"))
    )
    assert personalisation_problems(
        "L’IA  chez vous",
        once,
        checked(taken_subjects=frozenset({"l'ia chez vous"})),
    )
    assert personalisation_problems("Objet", f"x\n{LONG}", checked(long_title=LONG))


def test_a_subject_already_used_is_rewritten_once() -> None:
    fake = FakeOpenAI(
        [ok(responses_payload(answer("Objet pris"))), ok(responses_payload(answer("Objet neuf")))]
    )

    mail = fake.generator().generate(checked(taken_subjects=frozenset({"Objet pris"})))

    assert mail.subject == "Objet neuf"
    assert len(fake.requests) == 2
    second = json.loads(fake.requests[1].content)["input"]
    assert second.startswith("input\n\n") and "déjà utilisé" in second


def test_a_rewrite_that_still_breaks_the_rules_saves_nothing() -> None:
    fake = FakeOpenAI([ok(responses_payload(answer("Objet pris")))])

    with pytest.raises(MailGenerationError) as caught:
        fake.generator().generate(checked(taken_subjects=frozenset({"Objet pris"})))

    assert caught.value.code == "ai_invalid_output"
    assert len(fake.requests) == 2


def test_a_compliant_answer_is_asked_once() -> None:
    fake = FakeOpenAI(
        [ok(responses_payload(json.dumps({"subject": "Objet généré", "body": TEXT})))]
    )

    fake.generator().generate(checked(company="Alpha"))

    assert len(fake.requests) == 1
