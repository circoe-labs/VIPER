"""ProspectScoreService: the explainable 0-100 score of a prospect, computed on the backend.

The frontend never computes it (handoff Task 01): it displays `ProspectScore`. The contract
(`ProspectScore`, `ScoreContribution`) is independent of the commercial rules, which live here and
in `ScoreConfig` (from `Settings`, so the base and the band thresholds are configurable):

- today the only contributions are **manual**: a note (`prospect_notes`) carrying a `score_delta`
  gives one contribution (`origin="manual"`, `source_type="note"`, `source_ref` = the note id,
  `reason` = the note's fact);
- `total = clamp(base + sum(deltas), 0, 100)`; a contribution's `delta` is kept as entered, even
  when the clamp absorbs part of it;
- `band` is `red` below `red_below`, `yellow` below `green_from`, else `green`;
- `summary` is a short factual French sentence generated from the contributions.

A future automated signal adds another `origin` without changing the contract. The score is
computed on read and never persisted (decision D-UX2). Rules and wording:
doc/features/prospect-editor.md.

**Meaning (S4, product decision): commercial fit only** — « à quel point on aimerait l'avoir comme
client / à quel point il rentre dans les critères ». Inputs, audited on 2026-11:

- ALLOWED (`ALLOWED_INPUTS`): the prospect's scored notes (manual, or `origin=agent` written by an
  accepted reassessment, `score_reassessment.py`) and its company's valid scored signals (capped
  subtotal).
- FORBIDDEN (`FORBIDDEN_INPUTS`): the relationship graph and anything derived from it (the
  `Proximité` score, `person_links`), the fiche completeness state (`prospect_data_quality`), and
  the Contact state (sequence, sends, replies). None of them is read here today; the guard test
  `tests/test_prospect_score_inputs.py` fails if this module imports one or if a link changes the
  score. Proximity is its own read model.

Reassessment: « Réévaluer le score » asks an agent through a one-off mission (`reassess_score`
task); only an accepted proposal writes new scored notes (`score_reassessment.apply`), so the
formula above is unchanged and every change is audited. Product weights per criterion do not exist
yet: the agent's deltas are reviewed by a person (reported as missing input, not invented).
"""

import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.core.config import Settings
from app.models.enums import SignalOrigin
from app.models.prospects import ProspectNote
from app.repositories import notes as repository
from app.repositories import prospects as prospect_repository

SCORE_MIN = 0
SCORE_MAX = 100
NOTE_SOURCE_TYPE = "note"


class ScoreBand(StrEnum):
    RED = "red"
    YELLOW = "yellow"
    GREEN = "green"


ContributionOrigin = Literal["manual", "agent"]

# The score's whole input set, by the module that reads it. A new input must be added here, in the
# docstring above and in the guard test; the forbidden ones may never be.
ALLOWED_INPUTS = ("app.repositories.notes", "app.repositories.prospects")
FORBIDDEN_INPUTS = (
    "app.services.person_links",
    "app.services.prospect_data_quality",
    "app.services.contact_workflow",
    "app.models.person_links",
    "app.repositories.person_links",
)

# Company-level signals are capped as a subtotal so an account fact cannot drown the person.
COMPANY_SIGNAL_CAP = 30


class ScoreContribution(BaseModel):
    """One explainable line of the breakdown: `+5 — a liké un post`."""

    model_config = ConfigDict(frozen=True)

    id: str
    delta: int
    reason: str
    # What `source_ref` points to (`note`); both null when the line has no traceable source.
    source_type: str | None = None
    source_ref: str | None = None
    created_at: datetime | None = None
    origin: ContributionOrigin = "manual"


class ProspectScore(BaseModel):
    """What a consumer displays: total, colour band, one-line summary and the breakdown. An empty
    `contributions` is a valid breakdown (the total is then the base)."""

    model_config = ConfigDict(frozen=True)

    total: int = Field(ge=SCORE_MIN, le=SCORE_MAX)
    summary: str
    band: ScoreBand
    contributions: list[ScoreContribution] = Field(default_factory=list)


@dataclass(frozen=True, slots=True)
class ScoreConfig:
    base: int = 50
    red_below: int = 40
    green_from: int = 70

    @classmethod
    def from_settings(cls, settings: Settings) -> ScoreConfig:
        return cls(
            base=settings.prospect_score_base,
            red_below=settings.prospect_score_red_below,
            green_from=settings.prospect_score_green_from,
        )


def clamp(value: int) -> int:
    return max(SCORE_MIN, min(SCORE_MAX, value))


def band_of(total: int, config: ScoreConfig) -> ScoreBand:
    if total < config.red_below:
        return ScoreBand.RED
    if total < config.green_from:
        return ScoreBand.YELLOW
    return ScoreBand.GREEN


def _signed(delta: int) -> str:
    return f"{delta:+d}"


def summarize(total: int, contributions: Sequence[ScoreContribution]) -> str:
    """Short factual sentence; no contribution is said, not hidden."""
    if not contributions:
        return "Aucun signal enregistré : score de départ."
    positive = sum(1 for item in contributions if item.delta > 0)
    negative = sum(1 for item in contributions if item.delta < 0)
    count = len(contributions)
    noun = "signal" if count == 1 else "signaux"
    parts = []
    if positive:
        parts.append(f"{positive} favorable{'s' if positive > 1 else ''}")
    if negative:
        parts.append(f"{negative} défavorable{'s' if negative > 1 else ''}")
    detail = f" ({', '.join(parts)})" if parts else " (neutre)"
    net = sum(item.delta for item in contributions)
    return f"{count} {noun}{detail}, bilan {_signed(net)}."


def contribution_of(note: ProspectNote) -> ScoreContribution | None:
    """The manual contribution of a note, none when it carries no `score_delta`."""
    if note.score_delta is None:
        return None
    return ScoreContribution(
        id=f"note:{note.id}",
        delta=note.score_delta,
        reason=note.fact_text,
        source_type=NOTE_SOURCE_TYPE,
        source_ref=str(note.id),
        created_at=note.created_at,
        origin="agent" if note.origin is SignalOrigin.AGENT else "manual",
    )


def build_score(contributions: Sequence[ScoreContribution], config: ScoreConfig) -> ProspectScore:
    """Pure: the score of a list of contributions under a configuration."""
    total = clamp(config.base + sum(item.delta for item in contributions))
    return ProspectScore(
        total=total,
        summary=summarize(total, contributions),
        band=band_of(total, config),
        contributions=list(contributions),
    )


def score_from_notes(notes: Sequence[ProspectNote], config: ScoreConfig) -> ProspectScore:
    contributions = [item for note in notes if (item := contribution_of(note)) is not None]
    return build_score(contributions, config)


def company_contribution_of(note: ProspectNote) -> ScoreContribution | None:
    """The contribution of a company signal, none when it carries no `score_delta`."""
    if note.score_delta is None:
        return None
    return ScoreContribution(
        id=f"signal:{note.id}",
        delta=note.score_delta,
        reason=f"Signal société — {note.fact_text}",
        created_at=note.created_at,
        origin="agent",
    )


def get_score(session: Session, prospect_id: uuid.UUID, config: ScoreConfig) -> ProspectScore:
    """The prospect's score: person notes, then its company's valid signals (capped subtotal)."""
    today: date = datetime.now(UTC).date()
    contributions = [
        item
        for note in repository.scored_notes(session, prospect_id, on=today)
        if (item := contribution_of(note)) is not None
    ]
    prospect = prospect_repository.get_prospect(session, prospect_id)
    if prospect is not None and prospect.company_id is not None:
        company = [
            item
            for note in repository.scored_company_signals(session, prospect.company_id, on=today)
            if (item := company_contribution_of(note)) is not None
        ]
        subtotal = sum(item.delta for item in company)
        if abs(subtotal) > COMPANY_SIGNAL_CAP:
            cap = COMPANY_SIGNAL_CAP if subtotal > 0 else -COMPANY_SIGNAL_CAP
            company.append(
                ScoreContribution(
                    id="company-signal-cap",
                    delta=cap - subtotal,
                    reason=f"Plafond des signaux société ({COMPANY_SIGNAL_CAP} points)",
                    origin="agent",
                )
            )
        contributions.extend(company)
    return build_score(contributions, config)
