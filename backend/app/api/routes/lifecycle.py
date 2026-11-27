"""« Changer de statut », Archiver and the temporary exclusion (`doc/features/
prospecting-lifecycle.md`): one explicit action per request, for a prospect or a company.

Refusals: 403 `human_actor_required`, 404 `not_found`, 422 `invalid` (`reason` required to
exclude and to bring back; `departure_reason` required to record a departure)."""

import uuid
from datetime import datetime
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.models.enums import DepartureReason, HoldKind
from app.services import lifecycle, lifecycle_view, prospects
from app.services.errors import InvalidFieldError

router = APIRouter(tags=["lifecycle"])

HoldAction = Literal["archive", "unarchive", "exclude", "reinstate"]
HOLDS: dict[str, tuple[HoldKind, bool]] = {
    # action: (kind, placing)
    "archive": (HoldKind.ARCHIVE, True),
    "unarchive": (HoldKind.ARCHIVE, False),
    "exclude": (HoldKind.EXCLUSION, True),
    "reinstate": (HoldKind.EXCLUSION, False),
}


class HoldOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    kind: HoldKind
    scope: Literal["prospect", "company"]
    reason: str | None
    placed_at: datetime
    placed_by: str


class LifecycleOut(BaseModel):
    """The first block (`prospect_departed`, `company_excluded`…; null: may be prospected), the
    departure reason and the open archives / exclusions."""

    model_config = ConfigDict(from_attributes=True)

    block: str | None
    departure_reason: DepartureReason | None
    holds: list[HoldOut]


class LifecycleChangedOut(BaseModel):
    changed: bool
    # Unsent messages cancelled by the change / being sent right now (left to the dispatcher).
    cancelled_messages: int
    in_flight_messages: int
    lifecycle: LifecycleOut


class CompanyActionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: HoldAction
    reason: str | None = None


class ProspectActionIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: HoldAction | Literal["depart", "return"]
    reason: str | None = None
    departure_reason: DepartureReason | None = None


def _changed(
    outcome: lifecycle.Outcome, state: lifecycle_view.LifecycleState
) -> LifecycleChangedOut:
    return LifecycleChangedOut(
        changed=outcome.changed,
        cancelled_messages=outcome.messages.cancelled,
        in_flight_messages=outcome.messages.in_flight,
        lifecycle=LifecycleOut.model_validate(state),
    )


@router.post("/prospects/{prospect_id}/lifecycle")
def change_prospect(
    prospect_id: uuid.UUID, body: ProspectActionIn, session: SessionDep, actor: CurrentActor
) -> LifecycleChangedOut:
    with business_errors():
        if body.action == "depart":
            if body.departure_reason is None:
                raise InvalidFieldError("departure_reason", "Say why the person left.", "blank")
            outcome = lifecycle.record_departure(
                session, actor, prospect_id, body.departure_reason, body.reason
            )
        elif body.action == "return":
            outcome = lifecycle.record_return(session, actor, prospect_id, body.reason)
        else:
            kind, placing = HOLDS[body.action]
            change = lifecycle.place_hold if placing else lifecycle.lift_hold
            outcome = change(session, actor, kind, body.reason, prospect_id=prospect_id)
        person = prospects.get_prospect(session, prospect_id)
        return _changed(outcome, lifecycle_view.prospect_state(session, person))


@router.post("/companies/{company_id}/lifecycle")
def change_company(
    company_id: uuid.UUID, body: CompanyActionIn, session: SessionDep, actor: CurrentActor
) -> LifecycleChangedOut:
    kind, placing = HOLDS[body.action]
    change = lifecycle.place_hold if placing else lifecycle.lift_hold
    with business_errors():
        outcome = change(session, actor, kind, body.reason, company_id=company_id)
        return _changed(outcome, lifecycle_view.company_state(session, company_id))
