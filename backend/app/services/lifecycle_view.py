"""What a sheet says of a person's or a company's place in prospecting (read only)."""

import uuid
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from app.models import Prospect, ProspectingHold
from app.models.enums import ActivityStatus, DepartureReason, HoldKind
from app.services import eligibility


@dataclass(frozen=True, slots=True)
class HoldView:
    kind: HoldKind
    # `prospect` or `company`: whose archive / exclusion it is.
    scope: str
    reason: str | None
    placed_at: datetime
    placed_by: str


@dataclass(frozen=True, slots=True)
class LifecycleState:
    # The first block (`eligibility.Block`), None when the person may be prospected (a company:
    # the block its people get from it).
    block: str | None
    # Set only while the person is `inactive`.
    departure_reason: DepartureReason | None
    holds: list[HoldView]


def _hold_view(hold: ProspectingHold) -> HoldView:
    return HoldView(
        kind=hold.kind,
        scope="prospect" if hold.prospect_id is not None else "company",
        reason=hold.reason,
        placed_at=hold.placed_at,
        placed_by=hold.placed_by_display,
    )


def prospect_state(session: Session, prospect: Prospect) -> LifecycleState:
    holds = eligibility.open_holds(session, prospect_id=prospect.id, company_id=prospect.company_id)
    block = eligibility.block_of(session, prospect.id)
    inactive = prospect.activity_status is ActivityStatus.INACTIVE
    return LifecycleState(
        block=block.value if block else None,
        departure_reason=prospect.departure_reason if inactive else None,
        holds=[_hold_view(hold) for hold in holds],
    )


def company_state(session: Session, company_id: uuid.UUID) -> LifecycleState:
    holds = eligibility.open_holds(session, company_id=company_id)
    block = eligibility.company_blocks(session, [company_id]).get(company_id)
    return LifecycleState(block, None, [_hold_view(hold) for hold in holds])
