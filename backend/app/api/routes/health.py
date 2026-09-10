from typing import Literal

from fastapi import APIRouter, Response, status
from pydantic import BaseModel

from app.api.dependencies import SessionDep
from app.services.health import database_is_reachable

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: Literal["ok", "degraded"]
    database: Literal["ok", "unavailable"]


@router.get(
    "/health",
    responses={status.HTTP_503_SERVICE_UNAVAILABLE: {"model": HealthResponse}},
)
def get_health(session: SessionDep, response: Response) -> HealthResponse:
    if database_is_reachable(session):
        return HealthResponse(status="ok", database="ok")
    response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    return HealthResponse(status="degraded", database="unavailable")
