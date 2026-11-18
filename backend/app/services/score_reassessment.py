"""LEGACY (retired 2026-11-18): the agent contract of the former « Réévaluer le score » (S4).

« Évaluer / Réévaluer le score » now calls the LLM directly (`prospect_scoring.py`): nothing creates
a `reassess_score` task any more (the request service, the route and the UI state were removed;
`reassess_score` stays a valid task type in the database and the enums, migrations 0056/0057
untouched). This contract stays only so a task created earlier can still be claimed and reviewed
(`tests/test_score_reassessment_legacy.py`). Removal condition: no `reassess_score` task left open
in production — then drop this module, its hooks in `agent_payloads` / `agent_review` and the test.

Score reassessment contract: what an agent returns when asked « Réévaluer le score » (S4).

The Prospect Score is **commercial fit only** (`prospect_score.py`, ALLOWED / FORBIDDEN inputs).
A reassessment is a `reassess_score` mission task bound to one prospect (`AgentTask.prospect_id`).
The agent returns a **proposal**: contributions (signed delta, reason, public source, quote), a
rationale and its own suggested total. Nothing is applied here: `apply` runs only from
`agent_review.accept`, as the validating person, and writes each accepted contribution as a
`prospect_notes` row (`origin=agent`, `task_result_id` = the reviewed result, `score_delta`), the
very rows the score already reads. The score stays computed on read; the notes are the trace.

This module is the contract (result model, payload extras, proposal, apply). The command that
creates the one-off mission and reads its state is `score_reassessment_requests.py` (it imports
`missions`, which imports this layer through `agent_payloads`: keep the two apart).

Missing product input (reported, not invented): there is no weighted criteria matrix in the
repository, so the agent proposes deltas from the commercial-fit definition below and the existing
formula (`base + sum(deltas)`, clamp 0-100) is untouched. Once weights exist, they belong in
`COMMERCIAL_FIT_DEFINITION`'s criteria and in `ScoreConfig`.
"""

import uuid
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from typing import Any
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.core.config import get_settings
from app.models.agent_missions import AgentTask
from app.models.enums import SignalKind, SignalOrigin
from app.models.prospects import (
    NOTE_SCORE_DELTA_MAX,
    NOTE_SCORE_DELTA_MIN,
    NOTE_TEXT_MAX_LENGTH,
    Prospect,
    ProspectNote,
)
from app.services import prospect_score
from app.services.errors import ConflictError, InvalidFieldError, NotFoundError
from app.services.mission_output import OutcomeFields

PROPOSAL_KIND = "score_reassessment"
# A reassessed contribution is a dated judgment: it counts for this long, then the person asks
# again (same idea as the validity of a signal).
CONTRIBUTION_VALID_DAYS = 180
MAX_CONTRIBUTIONS = 10

INSTRUCTION = (
    "Réévalue le score prospect de cette personne : à quel point on aimerait l'avoir comme client, "
    "c'est-à-dire à quel point elle (et son entreprise) entre dans nos critères cibles. N'utilise "
    "que des faits publics sourcés sur la personne et son entreprise. N'utilise JAMAIS le réseau "
    "de relations ni la proximité avec l'équipe Circoe (c'est un autre score). Propose des "
    "contributions signées (delta de -50 à +50), chacune avec sa raison, sa source publique et une "
    "citation. `current_score` liste ce qui compte déjà : ne répète pas une contribution "
    "existante, corrige-la par une contribution de sens contraire si elle est démentie."
)

COMMERCIAL_FIT_DEFINITION: dict[str, Any] = {
    "meaning": "Intérêt commercial / adéquation du prospect aux critères cibles de Circoe.",
    "allowed_inputs": [
        "fonction et rôle de la personne, ancienneté de l'emploi, statut d'activité",
        "profil de l'entreprise : taille, segment commercial, secteur, implantations",
        "signaux datés et sourcés sur la personne ou son entreprise (recrutement, site ouvert…)",
    ],
    "forbidden_inputs": [
        "graphe de relations, liens avec des membres Circoe, score de proximité",
        "qualité / complétude de la fiche",
        "état du contact (séquence, relances, réponses)",
    ],
    "weights": None,  # no product weights yet: deltas are the agent's, reviewed by a person
}


class ReassessedContribution(BaseModel):
    """One explainable line of the proposed score: `+8 — dirige un site logistique`."""

    model_config = ConfigDict(extra="forbid")

    delta: int = Field(ge=NOTE_SCORE_DELTA_MIN, le=NOTE_SCORE_DELTA_MAX)
    reason: str = Field(min_length=1, max_length=700)
    criterion: str | None = Field(None, max_length=100, description="Critère cible concerné.")
    source: str = Field(min_length=1, max_length=2000, description="Public http(s) URL.")
    quote: str | None = Field(None, max_length=500)
    observed_on: date
    confidence: int | None = Field(None, ge=0, le=100)


class ScoreReassessmentResult(OutcomeFields):
    """`reassess_score`: the proposed commercial-fit contributions and why."""

    model_config = ConfigDict(extra="forbid")

    contributions: list[ReassessedContribution] = Field(
        default_factory=list, max_length=MAX_CONTRIBUTIONS
    )
    rationale: str | None = Field(None, max_length=2000)
    # The agent's own figure: informational, VIPER recomputes the projection from the deltas.
    suggested_total: int | None = Field(None, ge=0, le=100)
    confidence: int = Field(ge=0, le=100)
    notes: str | None = Field(None, max_length=2000)


def _config() -> prospect_score.ScoreConfig:
    return prospect_score.ScoreConfig.from_settings(get_settings())


def payload_extras(session: Session, task: AgentTask) -> dict[str, Any]:
    """What the claim payload adds for this task: the criteria and the score as it stands."""
    if task.prospect_id is None:
        raise InvalidFieldError("task", "This task has no prospect.", "missing_subject")
    score = prospect_score.get_score(session, task.prospect_id, _config())
    return {
        "criteria": COMMERCIAL_FIT_DEFINITION,
        "current_score": {
            "total": score.total,
            "band": score.band.value,
            "summary": score.summary,
            "contributions": [
                {"delta": line.delta, "reason": line.reason, "origin": line.origin}
                for line in score.contributions
            ],
        },
    }


def _public_url(value: str) -> str:
    url = value.strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or " " in url:
        raise InvalidFieldError("source", "A public http(s) URL is required.", "format")
    return url


def _refusal(field: str, label: str, reason: str, message: str) -> dict[str, Any]:
    return {"field": field, "label": label[:80], "reason": reason, "message": message}


def build_proposal(session: Session, task: AgentTask, raw: dict[str, Any]) -> dict[str, Any]:
    """The reviewable reading of a submitted result: one item per contribution, the projected
    total and the rationale. Raises `InvalidFieldError` (the agent may fix it)."""
    if task.prospect_id is None:
        raise InvalidFieldError("task", "This task has no prospect.", "missing_subject")
    result = ScoreReassessmentResult.model_validate(raw)
    if not (result.rationale or "").strip():
        raise InvalidFieldError("rationale", "Explain the reassessment.", "missing")
    if not result.contributions:
        raise InvalidFieldError(
            "contributions", "Propose at least one contribution, or answer not_found.", "empty"
        )
    known = set(
        session.scalars(
            select(ProspectNote.source_url).where(
                ProspectNote.prospect_id == task.prospect_id,
                ProspectNote.source_url.is_not(None),
            )
        )
    )
    today = datetime.now(UTC).date()
    items: list[dict[str, Any]] = []
    refused: list[dict[str, Any]] = []
    for index, line in enumerate(result.contributions):
        field = f"contributions.{index}"
        if line.delta == 0:
            refused.append(_refusal(field, line.reason, "zero", "Une contribution nulle."))
            continue
        if line.observed_on > today:
            refused.append(_refusal(field, line.reason, "future", "Date dans le futur."))
            continue
        try:
            source = _public_url(line.source)
        except InvalidFieldError as error:
            refused.append(_refusal(field, line.reason, error.reason or "invalid", str(error)))
            continue
        if source in known:
            refused.append(
                _refusal(field, line.reason, "already_known", "Source déjà enregistrée.")
            )
            continue
        known.add(source)
        label = f"{line.criterion} — {line.reason}" if line.criterion else line.reason
        items.append(
            {
                "key": f"contribution:{index}:{source}",
                "field": field,
                "label": label[:200],
                "before": None,
                "after": f"{line.delta:+d}",
                "status": "add",
                "store": {
                    "delta": line.delta,
                    "reason": line.reason,
                    "criterion": line.criterion,
                    "source_url": source,
                    "observed_on": line.observed_on.isoformat(),
                    "quote": line.quote,
                },
                "source": source,
                "quote": line.quote,
                "confidence": line.confidence,
                "source_published_at": None,
                "source_checked_at": None,
            }
        )
    current = prospect_score.get_score(session, task.prospect_id, _config())
    projected = prospect_score.clamp(current.total + sum(item["store"]["delta"] for item in items))
    return {
        "kind": PROPOSAL_KIND,
        "items": items,
        "refused": refused,
        "stale": False,
        "confidence": result.confidence,
        "notes": result.notes,
        "rationale": result.rationale,
        "current_total": current.total,
        "projected_total": projected,
        "agent_suggested_total": result.suggested_total,
    }


def apply(
    session: Session,
    actor: ActorContext,
    task: AgentTask,
    items: Sequence[dict[str, Any]],
    result_id: uuid.UUID,
) -> dict[str, Any]:
    """Write the accepted contributions as scored notes (`origin=agent`, tied to the result).
    Called only by `agent_review.accept`: the audit says who decided, `task_result_id` says which
    proposal. Either every accepted note is written or none (the caller's transaction)."""
    if task.prospect_id is None:
        raise InvalidFieldError("task", "This task has no prospect.", "missing_subject")
    if session.get(Prospect, task.prospect_id) is None:
        raise NotFoundError("Unknown prospect.")
    today = datetime.now(UTC).date()
    created: list[str] = []
    for item in items:
        store = item["store"]
        source = str(store["source_url"])
        taken = session.scalar(
            select(ProspectNote.id).where(
                ProspectNote.prospect_id == task.prospect_id, ProspectNote.source_url == source
            )
        )
        if taken is not None:
            raise ConflictError("A note already carries this source: rebuild or reject.")
        criterion = store.get("criterion")
        text = f"{criterion} — {store['reason']}" if criterion else str(store["reason"])
        note = ProspectNote(
            prospect_id=task.prospect_id,
            fact_text=text[:NOTE_TEXT_MAX_LENGTH],
            noted_on=date.fromisoformat(str(store["observed_on"])),
            source_url=source,
            kind=SignalKind.OTHER,
            origin=SignalOrigin.AGENT,
            observed_on=date.fromisoformat(str(store["observed_on"])),
            valid_until=today + timedelta(days=CONTRIBUTION_VALID_DAYS),
            score_delta=int(store["delta"]),
            task_result_id=result_id,
        )
        session.add(note)
        session.flush()
        created.append(str(note.id))
    return {
        "prospect_id": str(task.prospect_id),
        "score_notes": created,
        "decided_by": actor.display,
    }
