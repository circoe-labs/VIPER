"""« Évaluer le score »: the LLM judges how good a prospect is for Circoe, directly (2026-11-18).

User decision: scoring does **not** go through the external-agent mission queue (no agent consumed
it: a request hung for 15 minutes in production). The backend calls the same OpenAI client as the
Contact drafting (`mail_generation.openai_client`: `VIPER_OPENAI_*` / Config AI > Connexions key,
model, timeouts, bounded retries, typed `ai_*` errors, « Tester la clé ») with a strict JSON schema.

`score_prospect`:

1. reads the prospect's sheet (`prospect_editor.get_view`: identity, role, employment, e-mails and
   phones with their verification, company, tracking state, sources) plus its notes and its
   company's data and signals. NEVER the relationship graph / proximity, and NEVER the Contact
   state (sequence, sends, replies): the score is commercial fit only (`prospect_score.py`);
2. briefs the model with the editable prompt and the Circoe target
   (`prospect_scoring_prompt.instructions`) and asks `{score, rationale, criteria[]}`;
3. validates the answer strictly (`ScoringAnswer`: types, lengths, no extra key; the score and the
   deltas are clamped to their range) and refuses anything else (`ai_invalid_output`);
4. stores one immutable `prospect_score_assessments` row (model, prompt hash, actor, duration,
   rationale, criteria). The displayed score becomes that row's score.

Any failure (not configured, timeout, refusal, malformed answer, provider error) raises a typed
`MailGenerationError` and writes nothing: the current score is untouched. The failures are logged
without personal data (ids, code, upstream status, duration: never the prompt, sheet or key).
"""

import json
import logging
import time
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StringConstraints, ValidationError
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.core.config import Settings
from app.models.companies import Company
from app.models.score_assessments import ProspectScoreAssessment
from app.repositories import notes as notes_repository
from app.repositories import score_assessments as assessment_repository
from app.services import prospect_scoring_prompt as prompts
from app.services.errors import MailGenerationError
from app.services.mail_generation.openai_client import (
    OpenAIMailGenerator,
    config_from_settings,
    generation_error,
)
from app.services.prospect_editor import EditorClock, ProspectView, get_view
from app.services.prospect_score import SCORE_MAX, SCORE_MIN, ScoreConfig, clamp

logger = logging.getLogger(__name__)

SCHEMA_NAME = "prospect_score"
# Sent to OpenAI (strict mode: every field required, no additional property).
OUTPUT_JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "score": {
            "type": "integer",
            "description": "Score d’adéquation du prospect à la cible de Circoe, de 0 à 100.",
        },
        "rationale": {
            "type": "string",
            "description": "Une ou deux phrases en français qui expliquent le score.",
        },
        "criteria": {
            "type": "array",
            "description": "De 1 à 10 critères qui justifient le score.",
            "items": {
                "type": "object",
                "properties": {
                    "label": {"type": "string", "description": "Critère, court."},
                    "delta": {
                        "type": "integer",
                        "description": "Impact approximatif en points, signé.",
                    },
                    "evidence": {
                        "type": "string",
                        "description": "Preuve tirée de la fiche, ou « non renseigné ».",
                    },
                },
                "required": ["label", "delta", "evidence"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["score", "rationale", "criteria"],
    "additionalProperties": False,
}

MAX_CRITERIA = 10
DELTA_LIMIT = 100
NOTE_CAP = 30
NOTE_TEXT_CAP = 500
SIGNAL_CAP = 20
# A sheet this long is truncated by the caps above; this is the last guard on the request size.
INPUT_MAX_CHARS = 40_000
NOT_CONFIGURED_MESSAGE = (
    "AI scoring is not configured: set the OpenAI key and model in Config AI > Connexions."
)


class _Criterion(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=150)]
    delta: StrictInt
    evidence: Annotated[str, StringConstraints(strip_whitespace=True, max_length=600)]


class ScoringAnswer(BaseModel):
    """The strict shape of the model's answer. A float, a string or a missing key is refused; an
    out-of-range integer is not (it is clamped), the model's intent being unambiguous."""

    model_config = ConfigDict(extra="forbid")

    score: StrictInt
    rationale: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1000)
    ]
    criteria: list[_Criterion] = Field(max_length=MAX_CRITERIA)


@dataclass(frozen=True, slots=True)
class ScoreEvaluation:
    """What a call produced. `assessment` is None for a preview (nothing stored)."""

    score: int
    rationale: str
    criteria: list[dict[str, Any]]
    model: str
    prompt_version: str
    duration_ms: int
    assessment: ProspectScoreAssessment | None


def parse_answer(answer: dict[str, Any]) -> ScoringAnswer:
    """Validate the model's JSON strictly; the message never carries the answer or the sheet."""
    try:
        return ScoringAnswer.model_validate(answer)
    except ValidationError as error:
        fields = sorted({".".join(str(part) for part in item["loc"]) for item in error.errors()})
        raise generation_error(
            "ai_invalid_output",
            "The AI scoring answer does not match the expected format "
            f"(fields: {', '.join(fields) or 'unknown'}): the score was not changed.",
        ) from None


# --- the sheet -----------------------------------------------------------------------------------


def _value(value: Any) -> Any:
    return getattr(value, "value", value)


def _iso(value: Any) -> str | None:
    return value.isoformat() if value is not None else None


def _clip(text: str | None, limit: int) -> str | None:
    if not text:
        return None
    text = " ".join(text.split())
    return text if len(text) <= limit else f"{text[: limit - 1]}…"


def _company_block(session: Session, view: ProspectView) -> dict[str, Any] | None:
    summary = view.company
    if summary is None:
        return None
    company = session.get(Company, summary.id)
    block: dict[str, Any] = {
        "nom": summary.display_name,
        "raison_sociale": summary.legal_name,
        "siren": summary.siren,
        "ville": summary.city,
        "site_web": summary.website_url,
        "domaine_email": summary.email_domain,
        "segment_commercial": summary.commercial_segment_label,
        "nombre_de_prospects_connus": summary.prospect_count,
    }
    if company is not None:
        block |= {
            "taille": company.size_label,
            "type": _value(company.company_kind),
            "categories_activite": sorted(item.label for item in company.activity_categories),
            "services_deja_proposes": list(company.proposed_services),
            "projet_realise_avec_circoe": _clip(company.project_done_with_circoe, 500),
            "type_de_projet": _clip(company.project_type, 300),
            "references_circoe": _clip(company.circoe_references, 500),
            "approche_client": _clip(company.client_approach, 500),
        }
        signals = [
            note for note in notes_repository.company_notes(session, company.id)[:SIGNAL_CAP]
        ]
        block["signaux_societe"] = [
            {
                "fait": _clip(note.fact_text, NOTE_TEXT_CAP),
                "date": _iso(note.observed_on or note.noted_on),
                "type": _value(note.kind),
                "source": note.source_url,
            }
            for note in signals
        ]
    return {key: value for key, value in block.items() if value not in (None, [], "")}


def sheet(session: Session, settings: Settings, view: ProspectView) -> dict[str, Any]:
    """The prospect sheet as the model reads it: all the person's information, none of the
    relationship graph and none of the Contact state."""
    notes = notes_repository.list_notes(session, view.id)[:NOTE_CAP]
    tracking = view.tracking
    data: dict[str, Any] = {
        "identite": {
            "civilite": _value(view.civility),
            "prenom": view.first_name,
            "nom": view.last_name,
        },
        "poste": {
            "role": view.role.label if view.role else None,
            "intitule_exact": view.exact_job_title,
            "statut_d_activite": _value(view.activity_status),
            "emploi_verifie_le": _iso(view.employment_verified_at),
            "etat_de_verification": _value(view.verification_state),
        },
        "emails": [
            {
                "adresse": email.address,
                "principal": email.is_primary,
                "actif": email.is_active,
                "verification": _value(email.verification_status),
                "verifie_le": _iso(email.last_verified_at),
            }
            for email in view.emails
        ],
        "telephones": [
            {
                "numero": phone.number,
                "type": _value(phone.type),
                "principal": phone.is_primary,
                "actif": phone.is_active,
                "verification": _value(phone.verification_status),
                "verifie_le": _iso(phone.last_verified_at),
            }
            for phone in view.phones
        ],
        "societe": _company_block(session, view),
        "suivi": (
            {
                "statut": _value(tracking.status),
                "reponse_recue_le": _iso(tracking.response_received_on),
                "rendez_vous_le": _iso(tracking.appointment_on),
            }
            if tracking is not None
            else None
        ),
        "notes": [
            {
                "fait": _clip(note.fact_text, NOTE_TEXT_CAP),
                "date": _iso(note.observed_on or note.noted_on),
                "type": _value(note.kind),
                "origine": _value(note.origin),
                "source": note.source_url,
            }
            for note in notes
        ],
        "origine_des_donnees": [
            {
                "type": _value(source.source_type),
                "reference": _clip(source.source_reference, 200),
                "collecte_le": _iso(source.collected_at),
                "contexte": _clip(source.legal_basis_or_collection_context, 200),
            }
            for source in view.sources
        ],
        "date_du_jour": view.today.isoformat(),
    }
    return data


def build_input(session: Session, settings: Settings, view: ProspectView) -> str:
    text = "Fiche du prospect (JSON) :\n" + json.dumps(
        sheet(session, settings, view), ensure_ascii=False, separators=(",", ":"), default=str
    )
    return text[:INPUT_MAX_CHARS]


def _clock(settings: Settings) -> EditorClock:
    return EditorClock(
        now=datetime.now(UTC),
        stale_days=settings.verification_stale_days,
        score=ScoreConfig.from_settings(settings),
    )


# --- the call ------------------------------------------------------------------------------------


def _evaluate(
    session: Session,
    settings: Settings,
    prospect_id: uuid.UUID,
    actor: ActorContext,
    *,
    persist: bool,
    transport: Any,
) -> ScoreEvaluation:
    view = get_view(session, prospect_id, _clock(settings))  # NotFoundError for an unknown id
    config = config_from_settings(settings)
    if config is None:
        logger.warning("prospect_scoring.not_configured prospect=%s", prospect_id)
        raise generation_error("ai_not_configured", NOT_CONFIGURED_MESSAGE)
    instructions = prompts.instructions(settings)
    version = prompts.prompt_hash(instructions)
    input_text = build_input(session, settings, view)
    logger.info(
        "prospect_scoring.started prospect=%s persist=%s model=%s prompt=%s input_chars=%s",
        prospect_id,
        persist,
        config.model,
        prompts.short_version(version),
        len(input_text),
    )
    started = time.monotonic()
    try:
        answer, model = OpenAIMailGenerator(config, transport=transport).structured(
            instructions, input_text, SCHEMA_NAME, OUTPUT_JSON_SCHEMA
        )
        parsed = parse_answer(answer)
    except MailGenerationError as error:
        logger.warning(
            "prospect_scoring.failed prospect=%s code=%s upstream_status=%s upstream_code=%s "
            "duration=%.1fs",
            prospect_id,
            error.code,
            error.upstream_status,
            error.upstream_code,
            time.monotonic() - started,
        )
        raise
    except Exception as error:
        # An adapter defect (not a typed failure): the traceback stays in the log, the person reads
        # that the score was not changed.
        logger.exception("prospect_scoring.defect prospect=%s", prospect_id)
        raise generation_error(
            "ai_upstream_error", "The AI scoring failed unexpectedly: the score was not changed."
        ) from error
    duration_ms = round((time.monotonic() - started) * 1000)
    score = max(SCORE_MIN, min(SCORE_MAX, parsed.score))
    criteria = [
        {
            "label": item.label,
            "delta": max(-DELTA_LIMIT, min(DELTA_LIMIT, item.delta)),
            "evidence": item.evidence,
        }
        for item in parsed.criteria
    ]
    stored: ProspectScoreAssessment | None = None
    if persist:
        stored = assessment_repository.add(
            session,
            ProspectScoreAssessment(
                prospect_id=prospect_id,
                score=clamp(score),
                rationale=parsed.rationale,
                criteria=criteria,
                model=model,
                prompt_hash=version,
                duration_ms=duration_ms,
                actor_type=actor.type.value,
                actor_id=actor.id,
                actor_display=actor.display,
            ),
        )
    logger.info(
        "prospect_scoring.done prospect=%s score=%s clamped=%s model=%s duration_ms=%s stored=%s",
        prospect_id,
        score,
        score != parsed.score,
        model,
        duration_ms,
        persist,
    )
    return ScoreEvaluation(
        score=score,
        rationale=parsed.rationale,
        criteria=criteria,
        model=model,
        prompt_version=prompts.short_version(version),
        duration_ms=duration_ms,
        assessment=stored,
    )


def score_prospect(
    session: Session,
    prospect_id: uuid.UUID,
    actor: ActorContext,
    *,
    settings: Settings,
    transport: Any = None,
) -> ScoreEvaluation:
    """Evaluate and STORE the assessment (the displayed score becomes it)."""
    return _evaluate(session, settings, prospect_id, actor, persist=True, transport=transport)


def preview_prospect(
    session: Session,
    prospect_id: uuid.UUID,
    actor: ActorContext,
    *,
    settings: Settings,
    transport: Any = None,
) -> ScoreEvaluation:
    """The same call, nothing stored: « Tester sur un prospect » (Config AI)."""
    return _evaluate(session, settings, prospect_id, actor, persist=False, transport=transport)
