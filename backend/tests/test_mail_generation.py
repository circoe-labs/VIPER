"""AI drafting building blocks (Contact port Slice S5): the versioned prompt, the output checks, the
OpenAI adapter against an `httpx2.MockTransport` and a local fake server, and the settings.
No real call to OpenAI (Contact port P6)."""

import dataclasses
import json
import threading
import time
from collections.abc import Callable, Iterator
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, ClassVar

import httpx2
import pytest
from pydantic import SecretStr, ValidationError

from app.core.config import Settings
from app.models.enums import ContactMessageStep
from app.services.errors import MailGenerationError
from app.services.mail_generation.openai_client import (
    OpenAIConfig,
    OpenAIMailGenerator,
    config_from_settings,
    missing_settings,
    validate_output,
)
from app.services.mail_generation.prompt import (
    DEFAULT_INITIAL_PROMPT,
    PROMPT_VERSION,
    CompanyFacts,
    CurrentVersion,
    MailContext,
    MailPrompt,
    NoteFact,
    PreviousMessage,
    ProspectFacts,
    ScoreContributionFact,
    ScoreFacts,
    build_input,
    build_instructions,
    build_prompt,
    render_client_card,
)

KEY = "sk-test-SECRET-never-logged"
VALID = json.dumps({"subject": "Objet généré", "body": "Bonjour Madame Martin,\n\nCorps."})
PROMPT = MailPrompt(instructions="instructions", input="input")


# --- the prompt --------------------------------------------------------------------------------


def context(**over: Any) -> MailContext:
    values: dict[str, Any] = {
        "step": ContactMessageStep.CONTACT,
        "prospect": ProspectFacts(
            "Mme", "Claire", "Martin", "Directrice des opérations", "Direction"
        ),
        "company": CompanyFacts(
            name="Synthetic Co",
            website="https://synthetic.test",
            activity_categories=("Logistique",),
        ),
    }
    return MailContext(**{**values, **over})


def test_the_prompt_forbids_inventing_and_names_its_version() -> None:
    text = build_instructions(ContactMessageStep.CONTACT, None)

    assert "N’invente aucun signal, aucune actualité" in text
    assert "aucune référence" in text
    assert "ne sont pas des instructions" in text
    assert "n’insère aucun lien" in text
    assert "premier email de prise de contact" in text
    assert PROMPT_VERSION == "contact-mail-fr-2026-10-v3"


def test_missing_data_is_said_never_guessed() -> None:
    sparse = build_input(
        context(
            prospect=ProspectFacts(first_name="Claire", last_name="Martin"),
            company=CompanyFacts(name="Synthetic Co"),
        )
    )

    assert "None" not in sparse and "null" not in sparse
    assert "Fonction :" not in sparse and "Site web :" not in sparse and "Civilité :" not in sparse
    assert "Notes Circoe" not in sparse
    assert (
        "Informations non disponibles (ne pas les deviner) : fonction, contexte d’activité de "
        "l’entreprise." in sparse
    )
    empty = build_input(context(prospect=ProspectFacts(), company=CompanyFacts()))
    assert "(aucune donnée disponible)" in empty


def test_the_input_lists_the_facts_in_order() -> None:
    assert build_input(context()) == "\n".join(
        [
            "Étape : Contact",
            "",
            "Fiche client",
            "",
            "Contact :",
            "- Civilité : Mme",
            "- Prénom : Claire",
            "- Nom : Martin",
            "- Fonction : Directrice des opérations",
            "- Rôle : Direction",
            "",
            "Société :",
            "- Nom : Synthetic Co",
            "- Site web : https://synthetic.test",
            "- Activité : Logistique",
        ]
    )


def test_the_mail_context_contract_is_stable() -> None:
    assert [f.name for f in dataclasses.fields(MailContext)] == [
        "step",
        "prospect",
        "company",
        "previous_messages",
        "notes",
        "prospect_score",
        "current_version",
        "instruction",
        "booking_url",
        "initial_prompt",
    ]
    assert [f.name for f in dataclasses.fields(NoteFact)] == [
        "fact_text",
        "noted_on",
        "source_type",
        "source_label",
    ]
    assert [f.name for f in dataclasses.fields(ScoreFacts)] == [
        "total",
        "summary",
        "band",
        "top_contributions",
    ]
    assert [f.name for f in dataclasses.fields(ScoreContributionFact)] == [
        "reason",
        "delta",
        "note_rank",
    ]
    bare = context()
    assert (bare.notes, bare.prospect_score) == ((), None)


def test_notes_and_score_are_structured_sections() -> None:
    text = build_input(
        context(
            notes=(
                NoteFact("A liké un post sur l’IA", date(2026, 9, 12), "LinkedIn", "post Acme"),
                NoteFact("Très bon interlocuteur"),
            ),
            prospect_score=ScoreFacts(
                total=65,
                summary="2 signaux (2 favorables), bilan +15.",
                band="yellow",
                top_contributions=(
                    ScoreContributionFact("Très bon interlocuteur", 10, note_rank=2),
                    ScoreContributionFact("A liké un post sur l’IA", 5, note_rank=1),
                    ScoreContributionFact("Contribution hors liste", -3),
                ),
            ),
        )
    )

    assert (
        "\n\nFaits connus sur la personne (du plus récent au plus ancien) :\n"
        "1. A liké un post sur l’IA (12/09/2026, LinkedIn post Acme)\n"
        "2. Très bon interlocuteur\n\n"
    ) in text
    assert (
        "Score prospect (contexte interne, non prescriptif ; à ne jamais mentionner au "
        "destinataire) :\n"
        "- Total : 65/100\n"
        "- Niveau : jaune\n"
        "- Résumé : 2 signaux (2 favorables), bilan +15.\n"
        "- Principales raisons (les plus fortes d’abord) :\n"
        "  - +10 : voir fait n°2\n"
        "  - +5 : voir fait n°1\n"
        "  - -3 : Contribution hors liste"
    ) in text
    assert text.count("bon interlocuteur") == 1


def test_no_notes_no_section_and_a_score_without_contribution_is_omitted() -> None:
    text = build_input(
        context(
            prospect_score=ScoreFacts(50, "Aucun signal enregistré : score de départ.", "yellow")
        )
    )

    assert "Faits connus" not in text
    assert "Score prospect" not in text and "Total" not in text
    plain = build_input(context())
    assert "Faits connus" not in plain and "Score prospect" not in plain
    assert "None" not in text and "null" not in text
    blank = build_input(context(notes=(NoteFact("  "),)))
    assert "Faits connus" not in blank


def test_instructions_keep_the_score_internal_and_the_facts_prudent() -> None:
    text = build_instructions(ContactMessageStep.CONTACT, None)

    assert "ne cite un fait que s’il est fourni" in text
    assert "n’évoque jamais de fait privé" in text
    assert "mentionne jamais le score" in text


def test_the_initial_prompt_comes_first_and_defaults_to_the_built_in_brief() -> None:
    default = build_instructions(ContactMessageStep.CONTACT, None)
    custom = build_instructions(ContactMessageStep.CONTACT, None, "  Tu écris pour Circoe.  ")

    assert default.startswith(DEFAULT_INITIAL_PROMPT)
    assert custom.startswith("Tu écris pour Circoe.\n\nMessage à rédiger")
    assert DEFAULT_INITIAL_PROMPT not in custom
    # The mandatory rules follow whatever the brief says.
    assert "N’invente aucun signal" in custom and "Réponds uniquement avec l’objet JSON" in custom
    assert build_instructions(ContactMessageStep.CONTACT, None, "   ").startswith(
        DEFAULT_INITIAL_PROMPT
    )
    prompt = build_prompt(context(initial_prompt="Brief du test."))
    assert prompt.instructions.startswith("Brief du test.")


def test_the_client_card_groups_the_person_the_company_and_the_circoe_notes() -> None:
    card = render_client_card(
        ProspectFacts("Mme", "Claire", "Martin", "Directrice des opérations", "Direction"),
        CompanyFacts(
            name="Synthetic Co",
            legal_name="SYNTHETIC COMPANY SAS",
            size_label="50-249",
            segment="Commissionnaire",
            activity_categories=("Logistique", " Transport "),
            project_done_with_circoe="Agent de suivi des litiges",
            client_approach="Rendez-vous en visio",
        ),
    )

    assert card == [
        "Fiche client",
        "",
        "Contact :",
        "- Civilité : Mme",
        "- Prénom : Claire",
        "- Nom : Martin",
        "- Fonction : Directrice des opérations",
        "- Rôle : Direction",
        "",
        "Société :",
        "- Nom : Synthetic Co",
        "- Raison sociale : SYNTHETIC COMPANY SAS",
        "- Taille : 50-249",
        "- Segment : Commissionnaire",
        "- Activité : Logistique, Transport",
        "",
        "Notes Circoe (saisies dans VIPER) :",
        "- Projet déjà réalisé avec Circoe : Agent de suivi des litiges",
        "- Approche client : Rendez-vous en visio",
    ]
    # The legal name is dropped when it only repeats the name.
    same = render_client_card(ProspectFacts(), CompanyFacts(name="Acme", legal_name=" ACME "))
    assert "Raison sociale" not in "\n".join(same)


def test_instruction_and_current_version_for_a_regeneration() -> None:
    text = build_input(
        context(
            instruction="  Plus court, mentionner la logistique ",
            current_version=CurrentVersion("Ancien objet", "Ancien corps"),
        )
    )

    assert (
        "Consigne de l’utilisateur pour cette version :\nPlus court, mentionner la logistique"
        in (text)
    )
    assert (
        "Version actuelle de ce message (à remplacer par une nouvelle version) :\n"
        "Objet : Ancien objet\nAncien corps"
    ) in text
    long = build_input(context(instruction="x" * 1500))
    assert "x" * 1000 in long and "x" * 1001 not in long


def test_follow_ups_get_the_recorded_previous_messages() -> None:
    r1 = build_prompt(
        context(
            step=ContactMessageStep.R1,
            previous_messages=(
                PreviousMessage(
                    ContactMessageStep.CONTACT, "Envoyé", "Premier objet", "Premier corps"
                ),
            ),
        )
    )

    assert (
        "Message Contact déjà rédigé (Envoyé) :\nObjet : Premier objet\nPremier corps" in r1.input
    )
    assert "première relance" in r1.instructions
    assert "Aucun message précédent enregistré" in build_input(context(step=ContactMessageStep.R2))
    assert "déjà rédigé" not in build_input(context())


def test_the_booking_link_only_when_configured() -> None:
    with_link = build_instructions(ContactMessageStep.CONTACT, "https://rdv.example.test/circoe")

    assert "recopié exactement : https://rdv.example.test/circoe. N’ajoute aucun autre lien." in (
        with_link
    )
    assert "https://" not in build_instructions(ContactMessageStep.CONTACT, None)


# --- output checks -----------------------------------------------------------------------------


def invalid(text: str, booking_url: str | None = None) -> MailGenerationError:
    with pytest.raises(MailGenerationError) as caught:
        validate_output(text, booking_url=booking_url)
    assert caught.value.code == "ai_invalid_output"
    return caught.value


@pytest.mark.parametrize(
    "answer",
    [
        "pas du json",
        json.dumps({"subject": "x"}),
        json.dumps(["subject", "body"]),
        json.dumps({"subject": "s", "body": "b", "status": "validated"}),
        json.dumps({"subject": "a\nb", "body": "c"}),
        json.dumps({"subject": " ", "body": "c"}),
        json.dumps({"subject": "s", "body": "  "}),
        json.dumps({"subject": 1, "body": "c"}),
        json.dumps({"subject": "s" * 201, "body": "c"}),
        json.dumps({"subject": "s", "body": "c" * 10_001}),
        json.dumps({"subject": "s", "body": "a\x00b"}),
        json.dumps({"subject": "Pour [Prénom]", "body": "Bonjour,"}),
        json.dumps({"subject": "s", "body": "Bonjour {prenom},"}),
        json.dumps({"subject": "s", "body": "Bonjour <nom>,"}),
        json.dumps({"subject": "s", "body": "Voir https://invente.example.test/offre"}),
        json.dumps({"subject": "s", "body": "Voir www.invente.example.test"}),
        json.dumps({"subject": "s", "body": "Écrivez-moi : jean.dupont@exemple.example."}),
        json.dumps({"subject": "Contact : contact@circoe.example", "body": "Bonjour,"}),
        json.dumps({"subject": "s", "body": "Voir «https://invente.example.test»"}),
    ],
)
def test_an_invalid_output_is_refused(answer: str) -> None:
    invalid(answer)


def test_a_valid_output_is_trimmed_and_the_booking_link_allowed() -> None:
    link = "https://rdv.example.test/circoe"

    assert validate_output(
        json.dumps({"subject": " Objet ", "body": f"Bonjour,\r\n\r\nRéservez : {link}.\n"}),
        booking_url=link,
    ) == ("Objet", f"Bonjour,\n\nRéservez : {link}.")
    invalid(json.dumps({"subject": "s", "body": f"{link}/autre"}), booking_url=link)
    # A link right inside French guillemets is the link itself, not « link» .
    for quoted in (f"«{link}»", f"« {link} »"):
        assert validate_output(
            json.dumps({"subject": "s", "body": f"Réservez ici : {quoted}."}), booking_url=link
        )
    # An « @ » inside the booking link is no e-mail address.
    at_link = "https://rdv.example.test/@circoe/30min"
    assert validate_output(
        json.dumps({"subject": "s", "body": f"Réservez : {at_link}"}), booking_url=at_link
    )
    # Parentheses are prose, not a placeholder.
    assert validate_output(
        json.dumps({"subject": "s", "body": "Nous (Circoe) intégrons l’IA."}), booking_url=None
    )


# --- the adapter against a mock transport ------------------------------------------------------


def responses_payload(text: str, **over: Any) -> dict[str, Any]:
    return {
        "id": "resp_1",
        "object": "response",
        "status": "completed",
        "model": "model-snapshot-1",
        "output": [
            {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": text}],
            }
        ],
        **over,
    }


def error_payload(code: str | None) -> dict[str, Any]:
    return {"error": {"message": "upstream detail", "type": "error_type", "code": code}}


Answer = httpx2.Response | Exception


class FakeOpenAI:
    """A mock transport answering in turn (the last answer repeats), recording requests."""

    def __init__(self, answers: list[Answer]) -> None:
        self.answers = answers
        self.requests: list[httpx2.Request] = []
        self.sleeps: list[float] = []

    def handle(self, request: httpx2.Request) -> httpx2.Response:
        self.requests.append(request)
        answer = self.answers[min(len(self.requests), len(self.answers)) - 1]
        if isinstance(answer, Exception):
            raise answer
        return answer

    def generator(self, **over: Any) -> OpenAIMailGenerator:
        config = OpenAIConfig(
            **{
                "api_key": KEY,
                "model": "configured-model",
                "base_url": "https://openai.test/v1",
                "timeout_seconds": 1.0,
                "max_retries": 2,
                **over,
            }
        )
        return OpenAIMailGenerator(
            config, transport=httpx2.MockTransport(self.handle), sleep=self.sleeps.append
        )


def ok(payload: object) -> httpx2.Response:
    return httpx2.Response(200, json=payload)


def failing(status: int, code: str | None = None, **headers: str) -> httpx2.Response:
    return httpx2.Response(status, json=error_payload(code), headers=headers)


def failure(call: Callable[[], object], code: str) -> MailGenerationError:
    with pytest.raises(MailGenerationError) as caught:
        call()
    error = caught.value
    assert error.code == code
    assert KEY not in str(error) and KEY not in repr(error.__dict__)
    assert "upstream detail" not in str(error)
    return error


def test_a_valid_answer_uses_the_responses_api_with_a_strict_schema() -> None:
    fake = FakeOpenAI([ok(responses_payload(VALID))])

    mail = fake.generator().generate(PROMPT)

    assert (mail.subject, mail.body, mail.model) == (
        "Objet généré",
        "Bonjour Madame Martin,\n\nCorps.",
        "model-snapshot-1",
    )
    [request] = fake.requests
    assert str(request.url) == "https://openai.test/v1/responses"
    assert request.headers["authorization"] == f"Bearer {KEY}"
    body = json.loads(request.content)
    assert {key: body[key] for key in ("model", "instructions", "input", "store")} == {
        "model": "configured-model",
        "instructions": "instructions",
        "input": "input",
        "store": False,
    }
    assert body["text"]["format"]["type"] == "json_schema"
    assert body["text"]["format"]["name"] == "contact_mail"
    assert body["text"]["format"]["strict"] is True
    assert body["text"]["format"]["schema"]["required"] == ["subject", "body"]
    assert body["text"]["format"]["schema"]["additionalProperties"] is False
    assert KEY not in request.content.decode()


def test_the_configured_model_when_the_answer_names_none() -> None:
    fake = FakeOpenAI([ok(responses_payload(VALID, model=None))])

    assert fake.generator().generate(PROMPT).model == "configured-model"


def test_refusal_incomplete_and_unreadable_answers() -> None:
    refusal = {
        "status": "completed",
        "output": [{"type": "message", "content": [{"type": "refusal", "refusal": "non"}]}],
    }
    failure(lambda: FakeOpenAI([ok(refusal)]).generator().generate(PROMPT), "ai_refused")
    incomplete = responses_payload(
        VALID, status="incomplete", incomplete_details={"reason": "max_output_tokens"}
    )
    error = failure(
        lambda: FakeOpenAI([ok(incomplete)]).generator().generate(PROMPT), "ai_invalid_output"
    )
    assert error.upstream_code == "max_output_tokens"
    html = httpx2.Response(200, text="<html>")
    failure(lambda: FakeOpenAI([html]).generator().generate(PROMPT), "ai_invalid_output")
    empty = responses_payload("")
    failure(lambda: FakeOpenAI([ok(empty)]).generator().generate(PROMPT), "ai_invalid_output")
    bad = responses_payload(json.dumps({"subject": "x"}))
    failure(lambda: FakeOpenAI([ok(bad)]).generator().generate(PROMPT), "ai_invalid_output")


def test_a_timeout_is_not_replayed() -> None:
    fake = FakeOpenAI([httpx2.ReadTimeout("slow")])

    error = failure(lambda: fake.generator().generate(PROMPT), "ai_timeout")

    assert len(fake.requests) == 1 and fake.sleeps == []
    assert "1 s" in str(error)


def test_transient_failures_are_retried_with_backoff() -> None:
    recovering = FakeOpenAI(
        [
            failing(429, "rate_limit_exceeded", **{"retry-after": "3"}),
            failing(503),
            ok(responses_payload(VALID)),
        ]
    )
    assert recovering.generator().generate(PROMPT).subject == "Objet généré"
    assert len(recovering.requests) == 3
    assert recovering.sleeps == [3.0, 1.0]

    down = FakeOpenAI([failing(500)])
    error = failure(lambda: down.generator().generate(PROMPT), "ai_upstream_error")
    assert len(down.requests) == 3  # 1 + VIPER_OPENAI_MAX_RETRIES (2)
    assert down.sleeps == [0.5, 1.0]
    assert error.upstream_status == 500

    limited = FakeOpenAI([failing(429, "rate_limit_exceeded")])
    failure(lambda: limited.generator(max_retries=1).generate(PROMPT), "ai_rate_limited")
    assert len(limited.requests) == 2

    network = FakeOpenAI([httpx2.ConnectError("refused"), ok(responses_payload(VALID))])
    assert network.generator().generate(PROMPT).subject == "Objet généré"
    assert len(network.requests) == 2

    unreachable = FakeOpenAI([httpx2.ConnectError("refused")])
    error = failure(lambda: unreachable.generator().generate(PROMPT), "ai_upstream_error")
    assert error.upstream_code == "ConnectError"

    capped = FakeOpenAI([failing(503, **{"retry-after": "120"}), ok(responses_payload(VALID))])
    capped.generator().generate(PROMPT)
    assert capped.sleeps == [10.0]


@pytest.mark.parametrize(
    ("status", "upstream", "code"),
    [
        (400, "invalid_request_error", "ai_upstream_error"),
        (401, "invalid_api_key", "ai_auth_failed"),
        (403, None, "ai_auth_failed"),
        (404, "model_not_found", "ai_upstream_error"),
        (429, "insufficient_quota", "ai_rate_limited"),
    ],
)
def test_lasting_failures_are_not_retried(status: int, upstream: str | None, code: str) -> None:
    fake = FakeOpenAI([failing(status, upstream)])

    error = failure(lambda: fake.generator().generate(PROMPT), code)

    assert len(fake.requests) == 1 and fake.sleeps == []
    assert (error.upstream_status, error.upstream_code) == (status, upstream or "error_type")


def test_the_config_never_shows_the_key() -> None:
    config = OpenAIConfig(KEY, "m", "https://openai.test/v1", 1.0, 0)

    assert KEY not in repr(config) and KEY not in str(config)


# --- the adapter against a local fake server (real HTTP, no OpenAI) ----------------------------


class FakeServer(BaseHTTPRequestHandler):
    delay = 0.0
    received: ClassVar[list[dict[str, Any]]] = []

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        FakeServer.received.append({"path": self.path, "body": body})
        time.sleep(FakeServer.delay)
        payload = json.dumps(responses_payload(VALID)).encode()
        try:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except OSError:
            # intentional: the client gave up (timeout test) and closed the connection.
            pass

    def log_message(self, *_: Any) -> None:
        # intentional: keep the pytest output clean.
        pass


@pytest.fixture
def fake_server() -> Iterator[str]:
    FakeServer.delay, FakeServer.received = 0.0, []
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeServer)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}/v1"
    server.shutdown()
    server.server_close()


def test_a_real_round_trip_to_a_local_fake_server(fake_server: str) -> None:
    config = OpenAIConfig(KEY, "fake-model", fake_server, 5.0, 0)

    mail = OpenAIMailGenerator(config).generate(PROMPT)

    assert mail.subject == "Objet généré"
    assert FakeServer.received[0]["path"] == "/v1/responses"
    assert FakeServer.received[0]["body"]["model"] == "fake-model"


def test_a_slow_server_times_out(fake_server: str) -> None:
    FakeServer.delay = 2.0
    config = OpenAIConfig(KEY, "fake-model", fake_server, 1.0, 2)
    started = time.monotonic()

    failure(lambda: OpenAIMailGenerator(config).generate(PROMPT), "ai_timeout")

    assert time.monotonic() - started < 1.9
    assert len(FakeServer.received) == 1


# --- settings ----------------------------------------------------------------------------------


def settings(**values: Any) -> Settings:
    return Settings(_env_file=None, **values)


def test_generation_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    for name in ("KEY", "MODEL", "BASE_URL", "TIMEOUT_MS", "MAX_RETRIES"):
        monkeypatch.delenv(f"VIPER_OPENAI_{name}", raising=False)
    monkeypatch.delenv("VIPER_CONTACT_BOOKING_URL", raising=False)

    unset = settings()
    assert (unset.generation_available, config_from_settings(unset)) == (False, None)
    assert missing_settings(unset) == ["VIPER_OPENAI_API_KEY", "VIPER_OPENAI_MODEL"]
    assert missing_settings(settings(openai_model="m")) == ["VIPER_OPENAI_API_KEY"]
    assert settings(openai_api_key=" ", openai_model="").generation_available is False
    with pytest.raises(ValidationError, match="VIPER_OPENAI_MODEL is required"):
        settings(openai_api_key=KEY)

    monkeypatch.setenv("VIPER_OPENAI_API_KEY", KEY)
    monkeypatch.setenv("VIPER_OPENAI_MODEL", " m ")
    monkeypatch.setenv("VIPER_OPENAI_BASE_URL", "http://127.0.0.1:9/v1/")
    configured = settings()
    assert configured.generation_available
    assert configured.openai_api_key == SecretStr(KEY)
    assert KEY not in repr(configured)
    assert config_from_settings(configured) == OpenAIConfig(
        KEY, "m", "http://127.0.0.1:9/v1", 60.0, 2
    )


@pytest.mark.parametrize(
    "values",
    [
        {"openai_timeout_ms": 999},
        {"openai_timeout_ms": 300_001},
        {"openai_max_retries": 6},
        {"openai_base_url": "ftp://openai.test"},
        {"contact_booking_url": "javascript:alert(1)"},
        {"contact_booking_url": "pas une url"},
    ],
)
def test_bad_generation_settings_are_refused_at_startup(values: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        settings(**values)


def test_the_environment_is_trusted_only_when_asked() -> None:
    base = {"openai_api_key": KEY, "openai_model": "m"}

    assert config_from_settings(settings(**base)) == OpenAIConfig(
        KEY, "m", "https://api.openai.com/v1", 60.0, 2, trust_env=False
    )
    trusted = config_from_settings(settings(**base, openai_trust_env=True))
    assert trusted is not None and trusted.trust_env is True


def test_the_client_honours_the_trust_env_setting(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[bool] = []
    real = httpx2.Client

    def spy(*args: Any, **kwargs: Any) -> httpx2.Client:
        seen.append(kwargs["trust_env"])
        return real(*args, **kwargs)

    monkeypatch.setattr(httpx2, "Client", spy)
    for trust in (False, True):
        fake = FakeOpenAI([ok(responses_payload(VALID))])
        fake.generator(trust_env=trust).generate(PROMPT)
    assert seen == [False, True]


def test_the_booking_url_is_kept_as_typed() -> None:
    assert settings(contact_booking_url=" https://rdv.example.test/x ").contact_booking_url == (
        "https://rdv.example.test/x"
    )
    assert settings(contact_booking_url="").contact_booking_url is None
