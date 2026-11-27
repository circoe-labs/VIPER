"""A person removes someone, or a company, from prospecting — and brings them back.

The only write path of `prospecting_holds` and of « Changer de statut » (`doc/features/
prospecting-lifecycle.md`). Four reversible operations, each a person's (403
`human_actor_required` otherwise), in the caller's transaction:

- `place_hold` / `lift_hold`: archive or temporary exclusion of a prospect or a company. Nothing
  is deleted; the durable opposition is never touched;
- `record_departure` / `record_return`: the person left the role (retired, left the company,
  other) — `activity_status`, the reason beside it; coming back leaves the activity « Inconnu »
  and the employment to verify.

Removing locks the people concerned first (the dispatcher's claim share-locks them: a send either
happens before, or sees the block), then cancels their messages that could still leave and stops
the warehouse mails (`contact_message_cancellation`). Bringing back restores eligibility only:
nothing cancelled is rescheduled by itself.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import Company, Establishment, Prospect, ProspectingHold, Warehouse, WarehouseDraft
from app.models.enums import ActivityStatus, DepartureReason, HoldKind
from app.services import audit, eligibility
from app.services.audit import AuditAction
from app.services.contact_message_cancellation import (
    NOTHING,
    Cancellation,
    cancel_if_ineligible,
    stop_warehouse_drafts,
)
from app.services.errors import ActorNotAllowedError, InvalidFieldError, NotFoundError

logger = logging.getLogger(__name__)

REASON_MAX_LENGTH = 1000


@dataclass(frozen=True, slots=True)
class Outcome:
    # False when there was nothing to do (already so).
    changed: bool
    messages: Cancellation = NOTHING


def _require_person(actor: ActorContext) -> None:
    if actor.type is not ActorType.HUMAN:
        raise ActorNotAllowedError("A person removes from prospecting and brings back.")


def _reason(value: str | None, *, required: bool) -> str | None:
    text = (value or "").strip() or None
    if required and text is None:
        raise InvalidFieldError("reason", "A reason is required.", "blank")
    if text is not None and len(text) > REASON_MAX_LENGTH:
        raise InvalidFieldError("reason", "The reason is too long.", "length")
    return text


def _locked_people(
    session: Session, *, prospect_id: uuid.UUID | None, company_id: uuid.UUID | None
) -> list[Prospect]:
    """The subject's people, row-locked in id order. 404 for an unknown subject."""
    if (prospect_id is None) == (company_id is None):
        raise ValueError("exactly one subject")
    if company_id is not None:
        company = session.scalar(
            select(Company).where(Company.id == company_id).with_for_update(of=Company)
        )
        if company is None:
            raise NotFoundError(f"Company {company_id} not found.")
    query = select(Prospect).where(
        Prospect.id == prospect_id if prospect_id is not None else Prospect.company_id == company_id
    )
    people = list(
        session.scalars(
            query.order_by(Prospect.id)
            .with_for_update(of=Prospect)
            .execution_options(populate_existing=True)
        )
    )
    if prospect_id is not None and not people:
        raise NotFoundError(f"Prospect {prospect_id} not found.")
    return people


def _cancel(session: Session, actor: ActorContext, people: list[Prospect]) -> Cancellation:
    cancelled = in_flight = 0
    for person in people:
        done = cancel_if_ineligible(session, actor, person.id)
        cancelled += done.cancelled
        in_flight += done.in_flight
    return Cancellation(cancelled, in_flight)


def _open_hold(
    session: Session,
    kind: HoldKind,
    prospect_id: uuid.UUID | None,
    company_id: uuid.UUID | None,
) -> ProspectingHold | None:
    holds = eligibility.open_holds(session, prospect_id=prospect_id, company_id=company_id)
    return next((hold for hold in holds if hold.kind is kind), None)


def place_hold(
    session: Session,
    actor: ActorContext,
    kind: HoldKind,
    reason: str | None,
    *,
    prospect_id: uuid.UUID | None = None,
    company_id: uuid.UUID | None = None,
    now: datetime | None = None,
) -> Outcome:
    """Archive or exclude (a reason is required to exclude). Idempotent: an open hold of the same
    kind is kept as it is."""
    _require_person(actor)
    text = _reason(reason, required=kind is HoldKind.EXCLUSION)
    people = _locked_people(session, prospect_id=prospect_id, company_id=company_id)
    if _open_hold(session, kind, prospect_id, company_id) is not None:
        return Outcome(False)
    moment = now or datetime.now(UTC)
    hold = ProspectingHold(
        prospect_id=prospect_id,
        company_id=company_id,
        kind=kind,
        reason=text,
        placed_at=moment,
        placed_by_display=actor.display,
    )
    audit.annotate(session, actor, hold, AuditAction.PROSPECTING_HOLD_PLACED)
    session.add(hold)
    session.flush()
    messages = _cancel(session, actor, people)
    if company_id is not None:
        code = eligibility.company_block(kind)
        # Its warehouses' mails too, whoever they are addressed to.
        warehouses = (
            select(Warehouse.id)
            .join(Establishment, Establishment.id == Warehouse.establishment_id)
            .where(Establishment.company_id == company_id)
        )
        stop_warehouse_drafts(
            session, actor, WarehouseDraft.warehouse_id.in_(warehouses), code.value, moment
        )
    logger.info(
        "lifecycle.hold_placed kind=%s prospect=%s company=%s cancelled=%s in_flight=%s",
        kind.value,
        prospect_id,
        company_id,
        messages.cancelled,
        messages.in_flight,
    )
    return Outcome(True, messages)


def lift_hold(
    session: Session,
    actor: ActorContext,
    kind: HoldKind,
    reason: str | None,
    *,
    prospect_id: uuid.UUID | None = None,
    company_id: uuid.UUID | None = None,
    now: datetime | None = None,
) -> Outcome:
    """Unarchive, or bring an exclusion back (say what changed: new information, a new angle).
    The row stays as history. Idempotent."""
    _require_person(actor)
    text = _reason(reason, required=kind is HoldKind.EXCLUSION)
    _locked_people(session, prospect_id=prospect_id, company_id=company_id)
    hold = _open_hold(session, kind, prospect_id, company_id)
    if hold is None:
        return Outcome(False)
    audit.annotate(session, actor, hold, AuditAction.PROSPECTING_HOLD_LIFTED)
    hold.lifted_at = now or datetime.now(UTC)
    hold.lifted_by_display = actor.display
    hold.lift_reason = text
    session.flush()
    logger.info(
        "lifecycle.hold_lifted kind=%s prospect=%s company=%s",
        kind.value,
        prospect_id,
        company_id,
    )
    return Outcome(True)


def record_departure(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    departure: DepartureReason,
    note: str | None = None,
) -> Outcome:
    """The person left the role: the former job is no longer prospected."""
    _require_person(actor)
    text = _reason(note, required=False)
    [person] = _locked_people(session, prospect_id=prospect_id, company_id=None)
    if person.activity_status is ActivityStatus.INACTIVE and person.departure_reason is departure:
        return Outcome(False, _cancel(session, actor, [person]))
    audit.annotate(session, actor, person, AuditAction.PROSPECT_DEPARTED, reason=text)
    person.activity_status = ActivityStatus.INACTIVE
    person.departure_reason = departure
    session.flush()
    messages = _cancel(session, actor, [person])
    logger.info(
        "lifecycle.departed prospect=%s reason=%s cancelled=%s",
        prospect_id,
        departure.value,
        messages.cancelled,
    )
    return Outcome(True, messages)


def record_return(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, note: str | None = None
) -> Outcome:
    """A departure recorded by mistake, or the person is back: activity « Inconnu » and the
    employment to verify again. An opposition stays."""
    _require_person(actor)
    text = _reason(note, required=False)
    [person] = _locked_people(session, prospect_id=prospect_id, company_id=None)
    if person.activity_status is not ActivityStatus.INACTIVE:
        return Outcome(False)
    audit.annotate(session, actor, person, AuditAction.PROSPECT_RETURNED, reason=text)
    person.activity_status = ActivityStatus.UNKNOWN
    person.departure_reason = None
    person.employment_verified_at = None
    session.flush()
    logger.info("lifecycle.returned prospect=%s", prospect_id)
    return Outcome(True)
