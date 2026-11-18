"""« Réévaluer le score » (S4): `/api/prospects/{id}/score/reassessment`.

`GET` the latest reassessment state (what the score card shows), `POST` asks an agent (a one-off
mission bound to the prospect, `201` when created, `200` when one was already open), `DELETE`
cancels the open one. The proposal is decided through the ordinary result review
(`POST /api/agents/results/{result_id}/accept|reject`): only an accepted proposal changes the
score. Contract: `app.services.score_reassessment`.
"""

import uuid
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Response, status
from pydantic import BaseModel, ConfigDict

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.services import score_reassessment_requests as requests
from app.services.score_reassessment_requests import ReassessmentState, ReassessmentStatus

router = APIRouter(prefix="/prospects", tags=["prospects"])


class ReassessmentIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # An optional precision from the person; the Mission menu (S5) may send its free text.
    instruction: str | None = None
    agent_id: uuid.UUID | None = None


class ReassessmentOut(BaseModel):
    status: ReassessmentStatus
    task_id: uuid.UUID | None
    mission_id: uuid.UUID | None
    run_id: uuid.UUID | None
    result_id: uuid.UUID | None
    requested_at: datetime | None
    agent_label: str | None
    failure_code: str | None
    failure_message: str | None
    proposal: dict[str, Any] | None
    decided_by: str | None
    decided_at: datetime | None
    agents_available: int


def reassessment_out(state: ReassessmentState) -> ReassessmentOut:
    return ReassessmentOut(
        status=state.status,
        task_id=state.task_id,
        mission_id=state.mission_id,
        run_id=state.run_id,
        result_id=state.result_id,
        requested_at=state.requested_at,
        agent_label=state.agent_label,
        failure_code=state.failure_code,
        failure_message=state.failure_message,
        proposal=state.proposal,
        decided_by=state.decided_by,
        decided_at=state.decided_at,
        agents_available=state.agents_available,
    )


@router.get("/{prospect_id}/score/reassessment")
def get_reassessment(prospect_id: uuid.UUID, session: SessionDep) -> ReassessmentOut:
    with business_errors():
        return reassessment_out(requests.state(session, prospect_id))


@router.post("/{prospect_id}/score/reassessment", status_code=status.HTTP_201_CREATED)
def request_reassessment(
    prospect_id: uuid.UUID,
    body: ReassessmentIn,
    response: Response,
    session: SessionDep,
    actor: CurrentActor,
) -> ReassessmentOut:
    with business_errors():
        state, created = requests.request_reassessment(
            session,
            actor,
            prospect_id,
            agent_id=body.agent_id,
            extra_instruction=body.instruction,
        )
        if not created:
            response.status_code = status.HTTP_200_OK
        return reassessment_out(state)


@router.delete("/{prospect_id}/score/reassessment")
def cancel_reassessment(
    prospect_id: uuid.UUID, session: SessionDep, actor: CurrentActor
) -> ReassessmentOut:
    with business_errors():
        return reassessment_out(requests.cancel_reassessment(session, actor, prospect_id))
