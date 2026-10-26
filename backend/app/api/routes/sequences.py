"""Contact sequences and quality alerts API (sequences rework, decisions D1-D9).

- `GET  /api/prospects/{id}/sequences` — where the prospect stands (cohort, level, next due date,
  why nothing is due) and every sequence it ran, newest first, with its messages: a change of
  cohort never erases anything;
- `PUT  /api/prospects/{id}/cohort` — a person puts the prospect in a cohort (`cohort_id`) or out
  of any (`null`): the current sequence closes, a new one opens with its counter at zero; a new
  cohort resumes a `disqualified` / `response_received` / `appointment_obtained` state to
  `neutral` (R-11), an `ignored` or opposed prospect is refused (409 `ignored_is_terminal` /
  `prospect_do_not_contact`). Answers the new place, the resumed state and the unsent messages
  cancelled;
- `GET  /api/alerts` — alerts by `prospect`, `company`, `type` and `state` (`open` by default,
  `resolved`, `all`), newest first;
- `POST /api/alerts` — raise an alert on a prospect or a company; its source comes from the signed
  in actor (a person: `human`), never from the body;
- `POST /api/alerts/{id}/resolve` — a person resolves it.

« Marquer comme envoyé » is `POST /api/prospects/{id}/messages/mark-sent` and « Défaillant » is
the state `disqualified` of `PATCH /api/prospects/{id}/tracking`; cohorts and « max relances »
are under `/api/settings`. Refusals: `app.api.errors` (403 `human_actor_required`, 404
`not_found`, 409 `alert_exists` / `alert_resolved` / `ignored_is_terminal` /
`prospect_do_not_contact`, 422 `invalid`).
"""

import uuid
from datetime import UTC, date, datetime
from enum import StrEnum
from typing import Annotated, Any

from fastapi import APIRouter, Query, status
from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors
from app.core.actor import ActorType
from app.core.business_time import business_day
from app.models import QualityAlert
from app.models.enums import (
    ContactMessageStatus,
    ContactTrackingStatus,
    QualityAlertSource,
    QualityAlertType,
    SendSource,
    SequenceEndReason,
)
from app.models.quality_alerts import NOTE_MAX_LENGTH
from app.services import contact_sequences, quality_alerts
from app.services.contact_sequences import ProspectSequence
from app.services.contact_workflow import PauseReason, step_code
from app.services.prospection.query import iso_week
from app.services.prospects import get_prospect

router = APIRouter(tags=["contact"])

Note = Annotated[str, StringConstraints(max_length=NOTE_MAX_LENGTH)]
MAX_DETAIL_KEYS = 20


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class CohortRefOut(BaseModel):
    id: uuid.UUID
    code: str
    starts_on: date | None
    out_of_campaign: bool
    needs_review: bool


class PlaceOut(BaseModel):
    """Where the prospect stands (derived, D1/D2/D9)."""

    cohort: CohortRefOut | None
    sequence_id: uuid.UUID | None
    sequence_open: bool
    sent_count: int
    # « Contact », « R2 », « Relance terminée »; null without cohort.
    level_label: str | None
    # The level key of the Contact planning (`contact_pending`, `contact_sent`, `r2_sent`,
    # `finished`); null without cohort.
    level: str | None
    # The step to send next (`contact`, `r1`…); null when finished or without cohort.
    next_step: str | None
    finished: bool
    next_due_at: datetime | None
    next_due_on: date | None
    next_due_week: str | None
    pause_reason: PauseReason | None
    email_error: bool
    max_follow_ups: int


class SendOut(BaseModel):
    message_id: uuid.UUID
    rank: int
    step: str
    step_label: str
    status: ContactMessageStatus
    sent_at: datetime | None
    sent_source: SendSource | None
    has_content: bool


class SequenceOut(BaseModel):
    id: uuid.UUID
    cohort: CohortRefOut
    is_current: bool
    opened_at: datetime
    closed_at: datetime | None
    end_reason: SequenceEndReason | None
    sent_count: int
    messages: list[SendOut]


class SequencesOut(BaseModel):
    prospect_id: uuid.UUID
    place: PlaceOut
    sequences: list[SequenceOut]


class CohortChangeIn(StrictModel):
    # The cohort to put the prospect in; null: out of any cohort (no longer validated).
    cohort_id: uuid.UUID | None


class CohortChangeOut(BaseModel):
    place: PlaceOut
    # False when the cohort asked for already was the open sequence's.
    changed: bool
    # The state the new cohort resumed to `neutral` (R-11); null when the state was kept.
    resumed_from: ContactTrackingStatus | None
    cancelled_messages: int
    in_flight_messages: int


class AlertState(StrEnum):
    OPEN = "open"
    RESOLVED = "resolved"
    ALL = "all"


class AlertIn(StrictModel):
    type: QualityAlertType
    prospect_id: uuid.UUID | None = None
    company_id: uuid.UUID | None = None
    note: Note | None = None
    # Structured, non-personal context (e.g. `{"field": "exact_job_title"}`).
    detail: dict[str, Any] = Field(default_factory=dict, max_length=MAX_DETAIL_KEYS)


class ResolveIn(StrictModel):
    note: Note | None = None


class AlertOut(BaseModel):
    id: uuid.UUID
    prospect_id: uuid.UUID | None
    company_id: uuid.UUID | None
    type: QualityAlertType
    source: QualityAlertSource
    note: str | None
    detail: dict[str, Any]
    raised_by_type: ActorType
    raised_by: str
    raised_at: datetime
    open: bool
    resolved_at: datetime | None
    resolved_by: str | None
    resolution_note: str | None


class AlertPageOut(BaseModel):
    items: list[AlertOut]
    total: int
    limit: int
    offset: int


def place_out(place: ProspectSequence) -> PlaceOut:
    progress = place.progress
    due = progress.next_due_at
    cohort = place.cohort
    return PlaceOut(
        cohort=CohortRefOut.model_validate(cohort, from_attributes=True) if cohort else None,
        sequence_id=place.sequence_id,
        sequence_open=place.sequence_open,
        sent_count=progress.sent_count,
        level_label=progress.level_label,
        level=progress.level,
        next_step=step_code(progress.next_rank) if progress.next_rank is not None else None,
        finished=progress.finished,
        next_due_at=due,
        next_due_on=business_day(due) if due else None,
        next_due_week=iso_week(due),
        pause_reason=progress.pause,
        email_error=place.email_error,
        max_follow_ups=place.max_follow_ups,
    )


def alert_out(alert: QualityAlert) -> AlertOut:
    return AlertOut(
        id=alert.id,
        prospect_id=alert.prospect_id,
        company_id=alert.company_id,
        type=alert.type,
        source=alert.source,
        note=alert.note,
        detail=alert.detail,
        raised_by_type=alert.raised_by_type,
        raised_by=alert.raised_by_display,
        raised_at=alert.created_at,
        open=alert.is_open,
        resolved_at=alert.resolved_at,
        resolved_by=alert.resolved_by_display,
        resolution_note=alert.resolution_note,
    )


@router.get("/prospects/{prospect_id}/sequences")
def prospect_sequences(prospect_id: uuid.UUID, session: SessionDep) -> SequencesOut:
    with business_errors():
        get_prospect(session, prospect_id)
    place = contact_sequences.prospect_sequence(session, prospect_id)
    history = contact_sequences.sequence_history(session, prospect_id)
    return SequencesOut(
        prospect_id=prospect_id,
        place=place_out(place),
        sequences=[SequenceOut.model_validate(view, from_attributes=True) for view in history],
    )


@router.put("/prospects/{prospect_id}/cohort")
def change_cohort(
    prospect_id: uuid.UUID, body: CohortChangeIn, session: SessionDep, actor: CurrentActor
) -> CohortChangeOut:
    """A new sequence in the cohort (counter at zero), the former one closed with its history."""
    with business_errors():
        change = contact_sequences.change_cohort(
            session, actor, prospect_id, body.cohort_id, now=datetime.now(UTC)
        )
    return CohortChangeOut(
        place=place_out(contact_sequences.prospect_sequence(session, prospect_id)),
        changed=change.changed,
        resumed_from=change.resumed_from,
        cancelled_messages=change.messages.cancelled,
        in_flight_messages=change.messages.in_flight,
    )


@router.get("/alerts")
def list_alerts(
    session: SessionDep,
    prospect: uuid.UUID | None = None,
    company: uuid.UUID | None = None,
    type: QualityAlertType | None = None,
    state: AlertState = AlertState.OPEN,
    limit: Annotated[int, Query(ge=1, le=quality_alerts.LIST_MAX_LIMIT)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> AlertPageOut:
    filters = quality_alerts.AlertFilters(
        prospect_id=prospect,
        company_id=company,
        type=type,
        open=None if state is AlertState.ALL else state is AlertState.OPEN,
    )
    page = quality_alerts.list_alerts(session, filters, limit=limit, offset=offset)
    return AlertPageOut(
        items=[alert_out(alert) for alert in page.items],
        total=page.total,
        limit=limit,
        offset=offset,
    )


@router.post("/alerts", status_code=status.HTTP_201_CREATED)
def raise_alert(body: AlertIn, session: SessionDep, actor: CurrentActor) -> AlertOut:
    data = quality_alerts.AlertInput(
        type=body.type,
        prospect_id=body.prospect_id,
        company_id=body.company_id,
        note=body.note,
        detail=body.detail,
    )
    with business_errors():
        alert = quality_alerts.raise_alert(session, actor, data)
    return alert_out(alert)


@router.post("/alerts/{alert_id}/resolve")
def resolve_alert(
    alert_id: uuid.UUID, body: ResolveIn, session: SessionDep, actor: CurrentActor
) -> AlertOut:
    with business_errors():
        alert = quality_alerts.resolve_alert(
            session, actor, alert_id, note=body.note, now=datetime.now(UTC)
        )
    return alert_out(alert)
