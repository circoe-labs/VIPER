"""Controlled reset of rebuildable prospecting data before a fresh Excel import."""

from fastapi import APIRouter, status
from pydantic import BaseModel

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import refusal
from app.services.prospecting_reset import reset_prospecting_data

router = APIRouter(prefix="/database", tags=["database"])
CONFIRMATION = "RESET_PROSPECTING_DATA"


class ResetIn(BaseModel):
    confirmation: str


class ResetOut(BaseModel):
    prospects_deleted: int
    prospects_preserved_do_not_contact: int
    companies_deleted: int


@router.post("/reset-prospecting", response_model=ResetOut)
def reset_prospecting(session: SessionDep, actor: CurrentActor, body: ResetIn) -> ResetOut:
    if body.confirmation != CONFIRMATION:
        raise refusal(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "confirmation_required",
            "Confirmation explicite requise pour réinitialiser les données de prospection.",
        )
    result = reset_prospecting_data(session, actor)
    return ResetOut(
        prospects_deleted=result.prospects_deleted,
        prospects_preserved_do_not_contact=result.prospects_preserved,
        companies_deleted=result.companies_deleted,
    )
