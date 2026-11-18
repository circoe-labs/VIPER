"""« Évaluer le score »: `POST /api/prospects/{id}/score/evaluate`.

The backend asks the LLM directly (`app.services.prospect_scoring`, 2026-11-18) and answers with the
prospect's new displayed score (`ProspectScore`, its `assessment` set), synchronously: seconds, no
external agent. A failure answers a typed `ai_*` error (`business_errors`) and changes nothing.
`POST /api/settings/integrations/scoring/test` is the same call on a prospect without storing it
(Config AI > Scoring prospect, « Tester sur un prospect »).
"""

import uuid
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel
from sqlalchemy import select

from app.api.dependencies import CurrentActor, SessionDep, SettingsDep
from app.api.errors import business_errors
from app.models import Prospect
from app.services import prospect_scoring
from app.services.errors import NotFoundError
from app.services.prospect_score import ProspectScore, ScoreConfig, get_score

router = APIRouter(tags=["prospects"])


@router.post("/prospects/{prospect_id}/score/evaluate")
def evaluate_score(
    prospect_id: uuid.UUID,
    request: Request,
    session: SessionDep,
    settings: SettingsDep,
    actor: CurrentActor,
) -> ProspectScore:
    with business_errors():
        prospect_scoring.score_prospect(
            session,
            prospect_id,
            actor,
            settings=settings,
            transport=request.app.state.openai_transport,
        )
        return get_score(session, prospect_id, ScoreConfig.from_settings(settings))


class ScoringTestOut(BaseModel):
    prospect_id: uuid.UUID
    prospect_name: str
    score: int
    rationale: str
    criteria: list[dict[str, Any]]
    model: str
    prompt_version: str
    duration_ms: int


@router.post("/settings/integrations/scoring/test")
def test_scoring(
    request: Request, session: SessionDep, settings: SettingsDep, actor: CurrentActor
) -> ScoringTestOut:
    """Run the saved prompt and target on the most recently updated prospect; nothing is stored."""
    with business_errors():
        prospect = session.scalars(
            select(Prospect).order_by(Prospect.updated_at.desc(), Prospect.id.desc()).limit(1)
        ).first()
        if prospect is None:
            raise NotFoundError("There is no prospect to test on yet.")
        result = prospect_scoring.preview_prospect(
            session,
            prospect.id,
            actor,
            settings=settings,
            transport=request.app.state.openai_transport,
        )
        name = " ".join(part for part in (prospect.first_name, prospect.last_name) if part)
        return ScoringTestOut(
            prospect_id=prospect.id,
            prospect_name=name or "Prospect",
            score=result.score,
            rationale=result.rationale,
            criteria=result.criteria,
            model=result.model,
            prompt_version=result.prompt_version,
            duration_ms=result.duration_ms,
        )
