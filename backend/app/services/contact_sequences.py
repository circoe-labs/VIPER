"""Contact sequences (sequences rework, decisions D1, D2, D5-D9): the prospect's cohort, its
sequences and their real sends, the derived level and the next due date.

Reads:

- `prospect_sequence` — one prospect's current cohort/sequence and its `Progress` (level, next due
  date, why nothing is due), computed by `contact_workflow.progress`;
- `sequence_history` — every sequence of the prospect, newest first, with its messages (rank,
  status, send moment and source): changing the cohort never erases anything;
- the SQL twins for lists (`join_sequence_sources`, `next_due_at_sql`, …) used by Prospection,
  the Contact page and Home, so a list and a prospect sheet always agree.

Writes:

- `open_imported_sequence` — an import puts a prospect that never had a cohort in the file's
  cohort (D3, D11); nothing else of the sequence is ever changed by an import;
- `change_cohort` — a person (403 `human_actor_required` otherwise; never an import, a job or the
  AI) puts the prospect in a cohort: the current sequence is closed (`cohort_changed`, or
  `cohort_removed` when the cohort is cleared) and its unsent messages cancelled (reason
  `sequence_closed`), then a new sequence opens with its counter at zero. Choosing the cohort of
  the open sequence changes nothing. Putting the prospect in a cohort (S0 included) **resumes**
  it (decision R-11): a state `disqualified`, `response_received` or `appointment_obtained` goes
  back to `neutral` (« En séquence ») with an appended history row; removing the cohort keeps
  the state. An `ignored` prospect (409 `ignored_is_terminal`) or one under the do-not-contact
  opposition (409 `prospect_do_not_contact`: clear it first through its own path) is never
  resumed by a cohort change: the change is refused. Audited `contact_sequence.closed` /
  `contact_sequence.created` (subject: the prospect) and `contact_tracking.status_changed` for a
  resumed state.

The prospect row is locked first, so two changes of the same prospect serialize. Operations
flush; the caller owns the transaction.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from http import HTTPStatus
from typing import Any

from sqlalchemy import (
    ColumnElement,
    DateTime,
    Integer,
    Select,
    Text,
    and_,
    case,
    cast,
    exists,
    func,
    or_,
    select,
)
from sqlalchemy.orm import Session
from sqlalchemy.sql.expression import null

from app.core.actor import ActorContext, ActorType
from app.core.business_time import BUSINESS_TIMEZONE
from app.core.cohort_codes import OUT_OF_CAMPAIGN_CODE
from app.models import (
    AppSetting,
    Cohort,
    ContactMessage,
    ContactSequence,
    ContactTracking,
    Prospect,
    QualityAlert,
)
from app.models.app_settings import MAX_FOLLOW_UPS_KEY
from app.models.contact_tracking import ContactTrackingStatusHistory
from app.models.enums import (
    ContactabilityStatus,
    ContactMessageStatus,
    ContactTrackingStatus,
    QualityAlertSource,
    QualityAlertType,
    SendSource,
    SequenceEndReason,
    TrackingHistoryStatus,
)
from app.services import app_settings, audit, cohorts
from app.services.audit import AuditAction
from app.services.contact_message_cancellation import NOTHING, Cancellation, cancel_unsent_messages
from app.services.contact_workflow import (
    DEFAULT_MAX_FOLLOW_UPS,
    Progress,
    SequenceFacts,
    progress,
    step_code,
    step_label,
)
from app.services.errors import (
    ActorNotAllowedError,
    BusinessRuleError,
    NotFoundError,
    TrackingRuleError,
)

S = ContactTrackingStatus
SEQUENCE_CLOSED_REASON = "sequence_closed"
# States a person's new cohort resumes to `neutral` (R-11): the handoff's « to resume, a person
# changes the Sxx and a new sequence starts ». `ignored` is terminal and refuses the change.
RESUMED_STATES = (S.DISQUALIFIED, S.RESPONSE_RECEIVED, S.APPOINTMENT_OBTAINED)
# `context.reason` of the `contact_tracking.status_changed` event of a resumed state.
RESUMED_REASON = "Changement de cohorte : reprise en séquence"
# Alerts that take a prospect out of the automatic actions (D9): raised by a person or an import;
# the AI's alerts are proposals until a person confirms them.
EFFECTIVE_ALERT_SOURCES = (QualityAlertSource.HUMAN, QualityAlertSource.IMPORT)


# --- one prospect --------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CohortRef:
    id: uuid.UUID
    code: str
    starts_on: date | None
    out_of_campaign: bool
    needs_review: bool


@dataclass(frozen=True, slots=True)
class ProspectSequence:
    """The prospect's current place in Contact."""

    prospect_id: uuid.UUID
    cohort: CohortRef | None
    sequence_id: uuid.UUID | None
    sequence_open: bool
    progress: Progress
    max_follow_ups: int
    # An open « Erreur sur le mail » raised by a person or an import (D9).
    email_error: bool


def cohort_ref(cohort: Cohort) -> CohortRef:
    return CohortRef(
        id=cohort.id,
        code=cohort.code,
        starts_on=cohort.starts_on,
        out_of_campaign=cohort.out_of_campaign,
        needs_review=cohort.needs_review,
    )


def current_sequence(
    session: Session, prospect_id: uuid.UUID, *, lock: bool = False
) -> ContactSequence | None:
    statement = select(ContactSequence).where(
        ContactSequence.prospect_id == prospect_id, ContactSequence.is_current
    )
    if lock:
        statement = statement.with_for_update(of=ContactSequence).execution_options(
            populate_existing=True
        )
    return session.scalar(statement)


def sends_of(session: Session, sequence_id: uuid.UUID) -> tuple[int, datetime | None]:
    """Number of sent messages of the sequence, and the latest send moment."""
    count, last = session.execute(
        select(func.count(), func.max(ContactMessage.sent_at)).where(
            ContactMessage.sequence_id == sequence_id,
            ContactMessage.status == ContactMessageStatus.SENT,
        )
    ).one()
    return count, last


def has_email_error(session: Session, prospect_id: uuid.UUID) -> bool:
    return bool(
        session.scalar(
            select(
                exists().where(
                    QualityAlert.prospect_id == prospect_id,
                    QualityAlert.type == QualityAlertType.EMAIL_ERROR,
                    QualityAlert.resolved_at.is_(None),
                    QualityAlert.source.in_(EFFECTIVE_ALERT_SOURCES),
                )
            )
        )
    )


def prospect_sequence(
    session: Session, prospect_id: uuid.UUID, *, max_follow_ups: int | None = None
) -> ProspectSequence:
    """The prospect's cohort, sequence and progress (no lock)."""
    sequence = current_sequence(session, prospect_id)
    state = session.scalar(
        select(ContactTracking.status).where(ContactTracking.prospect_id == prospect_id)
    )
    opposed = (
        session.scalar(select(Prospect.contactability_status).where(Prospect.id == prospect_id))
        is ContactabilityStatus.DO_NOT_CONTACT
    )
    email_error = has_email_error(session, prospect_id)
    limit = max_follow_ups if max_follow_ups is not None else app_settings.max_follow_ups(session)
    if sequence is None:
        facts = SequenceFacts(
            has_sequence=False, state=state, do_not_contact=opposed, email_error=email_error
        )
        return ProspectSequence(
            prospect_id, None, None, False, progress(facts, limit), limit, email_error
        )
    count, last = sends_of(session, sequence.id)
    facts = SequenceFacts(
        has_sequence=True,
        sequence_open=sequence.is_open,
        out_of_campaign=sequence.cohort.out_of_campaign,
        cohort_starts_on=sequence.cohort.starts_on,
        sent_count=count,
        last_sent_at=last,
        state=state,
        do_not_contact=opposed,
        email_error=email_error,
    )
    return ProspectSequence(
        prospect_id=prospect_id,
        cohort=cohort_ref(sequence.cohort),
        sequence_id=sequence.id,
        sequence_open=sequence.is_open,
        progress=progress(facts, limit),
        max_follow_ups=limit,
        email_error=email_error,
    )


@dataclass(frozen=True, slots=True)
class SendView:
    message_id: uuid.UUID
    rank: int
    step: str
    step_label: str
    status: ContactMessageStatus
    sent_at: datetime | None
    sent_source: SendSource | None
    # The message has a text (a bare send record has none).
    has_content: bool


@dataclass(frozen=True, slots=True)
class SequenceView:
    id: uuid.UUID
    cohort: CohortRef
    is_current: bool
    opened_at: datetime
    closed_at: datetime | None
    end_reason: SequenceEndReason | None
    sent_count: int
    messages: list[SendView]


def sequence_history(session: Session, prospect_id: uuid.UUID) -> list[SequenceView]:
    """Every sequence of the prospect, current first then newest first, with its messages by
    rank (all statuses: a cancelled or draft message is part of what happened)."""
    sequences = session.scalars(
        select(ContactSequence)
        .where(ContactSequence.prospect_id == prospect_id)
        .order_by(ContactSequence.is_current.desc(), ContactSequence.created_at.desc())
    ).all()
    messages: dict[uuid.UUID, list[ContactMessage]] = {}
    for message in session.scalars(
        select(ContactMessage)
        .where(ContactMessage.prospect_id == prospect_id)
        .order_by(ContactMessage.rank)
    ):
        messages.setdefault(message.sequence_id, []).append(message)
    views = []
    for sequence in sequences:
        rows = messages.get(sequence.id, [])
        views.append(
            SequenceView(
                id=sequence.id,
                cohort=cohort_ref(sequence.cohort),
                is_current=sequence.is_current,
                opened_at=sequence.created_at,
                closed_at=sequence.closed_at,
                end_reason=sequence.end_reason,
                sent_count=sum(row.status is ContactMessageStatus.SENT for row in rows),
                messages=[
                    SendView(
                        message_id=row.id,
                        rank=row.rank,
                        step=step_code(row.rank),
                        step_label=step_label(row.rank),
                        status=row.status,
                        sent_at=row.sent_at,
                        sent_source=row.sent_source,
                        has_content=bool(row.subject.strip() or row.body_text.strip()),
                    )
                    for row in rows
                ],
            )
        )
    return views


# --- change of cohort ----------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CohortChange:
    sequence: ContactSequence | None
    # False when the cohort asked for is already the open sequence's (nothing written).
    changed: bool
    # Unsent messages of the closed sequence that were cancelled / left to the dispatcher.
    messages: Cancellation = NOTHING
    # The state the new cohort resumed to `neutral` (R-11); None when the state was kept.
    resumed_from: ContactTrackingStatus | None = None


def _locked_prospect(session: Session, prospect_id: uuid.UUID) -> Prospect:
    prospect = session.scalar(
        select(Prospect)
        .where(Prospect.id == prospect_id)
        .with_for_update(of=Prospect)
        .execution_options(populate_existing=True)
    )
    if prospect is None:
        raise NotFoundError("Unknown prospect.")
    return prospect


def _require_resumable(prospect: Prospect) -> None:
    """An `ignored` or opposed prospect is never put back in a sequence by a cohort change."""
    tracking = prospect.contact_tracking
    if tracking is not None and tracking.status is S.IGNORED:
        raise TrackingRuleError(
            "ignored_is_terminal", "An ignored prospect is not resumed by a change of cohort."
        )
    if prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT:
        raise BusinessRuleError(
            "prospect_do_not_contact",
            HTTPStatus.CONFLICT,
            "The prospect must not be contacted: clear the restriction before changing its cohort.",
        )


def _resume_state(
    session: Session, actor: ActorContext, prospect: Prospect
) -> ContactTrackingStatus | None:
    """Back to `neutral` from a state a new cohort resumes (R-11), with an appended history row;
    returns the former state, None when nothing changed. `neutral` closes nothing: no message to
    cancel."""
    tracking = prospect.contact_tracking
    if tracking is None or tracking.status not in RESUMED_STATES:
        return None
    previous = tracking.status
    audit.annotate(
        session,
        actor,
        tracking,
        AuditAction.CONTACT_TRACKING_STATUS_CHANGED,
        reason=RESUMED_REASON,
    )
    tracking.status = S.NEUTRAL
    tracking.status_history.append(
        ContactTrackingStatusHistory(
            from_status=TrackingHistoryStatus(previous),
            to_status=TrackingHistoryStatus(S.NEUTRAL),
            actor_type=actor.type,
            actor_id=actor.id,
            actor_display=actor.display,
        )
    )
    session.flush()
    return previous


def change_cohort(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    cohort_id: uuid.UUID | None,
    *,
    now: datetime | None = None,
) -> CohortChange:
    """Put the prospect in `cohort_id` (a new sequence, counter at zero, the state resumed to
    `neutral` — R-11) or out of any cohort (`None`, the state kept). Refusals: 403
    `human_actor_required`, 404 `not_found` (prospect or cohort), 409 `ignored_is_terminal` /
    `prospect_do_not_contact` (never resumed by a cohort change)."""
    if actor.type is not ActorType.HUMAN:
        raise ActorNotAllowedError("A prospect's cohort is changed by a person.")
    prospect = _locked_prospect(session, prospect_id)
    cohort = cohorts.get_cohort(session, cohort_id) if cohort_id is not None else None
    current = current_sequence(session, prospect_id, lock=True)
    same = current is not None and cohort is not None and current.cohort_id == cohort.id
    if current is not None and current.is_open and same:
        return CohortChange(current, changed=False)
    if current is None and cohort is None:
        return CohortChange(None, changed=False)
    _require_resumable(prospect)
    moment = now or datetime.now(UTC)
    cancelled = NOTHING
    if current is not None:
        reason = (
            SequenceEndReason.COHORT_CHANGED
            if cohort is not None
            else SequenceEndReason.COHORT_REMOVED
        )
        audit.annotate(session, actor, current, AuditAction.CONTACT_SEQUENCE_CLOSED)
        if current.is_open:
            current.closed_at = moment
            current.end_reason = reason
        current.is_current = False
        session.flush()
        cancelled = cancel_unsent_messages(
            session, actor, prospect_id, SEQUENCE_CLOSED_REASON, now=moment
        )
    sequence = None
    resumed = None
    if cohort is not None:
        sequence = ContactSequence(prospect_id=prospect_id, cohort_id=cohort.id, is_current=True)
        audit.annotate(session, actor, sequence, labels={"cohort_id": (None, cohort.code)})
        session.add(sequence)
        session.flush()
        resumed = _resume_state(session, actor, prospect)
    return CohortChange(sequence, changed=True, messages=cancelled, resumed_from=resumed)


def open_imported_sequence(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, cohort_id: uuid.UUID
) -> ContactSequence:
    """An import puts a prospect **without any cohort** in the file's cohort (D3, D11: an empty
    value is filled, never a cohort or a sequence set before). Only for the import actor (403
    `human_actor_required` wording aside: a person uses `change_cohort`); refused for a prospect
    that already has or had a sequence (409 `sequence_exists`), under the do-not-contact
    opposition (409 `prospect_do_not_contact`) or in a state other than `neutral` (409
    `prospect_sequence_closed`). Audited `contact_sequence.created`."""
    if actor.type is not ActorType.IMPORT:
        raise ActorNotAllowedError("Only an import opens a sequence this way.")
    prospect = _locked_prospect(session, prospect_id)
    cohort = cohorts.get_cohort(session, cohort_id)
    if prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT:
        raise BusinessRuleError(
            "prospect_do_not_contact", HTTPStatus.CONFLICT, "The prospect must not be contacted."
        )
    had_one = session.scalar(select(exists().where(ContactSequence.prospect_id == prospect_id)))
    if had_one:
        raise BusinessRuleError(
            "sequence_exists", HTTPStatus.CONFLICT, "The prospect already has a cohort history."
        )
    tracking = prospect.contact_tracking
    if tracking is not None and tracking.status is not S.NEUTRAL:
        raise BusinessRuleError(
            "prospect_sequence_closed",
            HTTPStatus.CONFLICT,
            "The prospect's state keeps it out of any sequence.",
        )
    sequence = ContactSequence(prospect_id=prospect_id, cohort_id=cohort.id, is_current=True)
    audit.annotate(session, actor, sequence, labels={"cohort_id": (None, cohort.code)})
    session.add(sequence)
    session.flush()
    return sequence


# --- SQL twins (lists) ---------------------------------------------------------------------------

# Sent messages per sequence: their number and the latest send.
SENDS = (
    select(
        ContactMessage.sequence_id.label("sequence_id"),
        func.count().label("sent_count"),
        func.max(ContactMessage.sent_at).label("last_sent_at"),
    )
    .where(ContactMessage.status == ContactMessageStatus.SENT)
    .group_by(ContactMessage.sequence_id)
    .subquery("sequence_sends")
)


def join_sequence_sources[T: tuple[Any, ...]](statement: Select[T]) -> Select[T]:
    """Outer-join the prospect's current sequence, its cohort and its sends (at most one of each
    per prospect: the join never multiplies prospects). `Prospect` must be in the FROM."""
    return (
        statement.outerjoin(
            ContactSequence,
            and_(ContactSequence.prospect_id == Prospect.id, ContactSequence.is_current),
        )
        .outerjoin(Cohort, Cohort.id == ContactSequence.cohort_id)
        .outerjoin(SENDS, SENDS.c.sequence_id == ContactSequence.id)
    )


def sent_count_sql() -> ColumnElement[int]:
    return func.coalesce(SENDS.c.sent_count, 0)


def max_follow_ups_sql() -> ColumnElement[int]:
    """« Max relances » read in the statement itself (one uncorrelated subquery)."""
    stored = (
        select(cast(cast(AppSetting.value, Text), Integer))
        .where(AppSetting.key == MAX_FOLLOW_UPS_KEY)
        .scalar_subquery()
    )
    return func.coalesce(stored, DEFAULT_MAX_FOLLOW_UPS)


def email_error_sql() -> ColumnElement[bool]:
    return exists().where(
        QualityAlert.prospect_id == Prospect.id,
        QualityAlert.type == QualityAlertType.EMAIL_ERROR,
        QualityAlert.resolved_at.is_(None),
        QualityAlert.source.in_(EFFECTIVE_ALERT_SOURCES),
    )


def has_cohort_sql() -> ColumnElement[bool]:
    return ContactSequence.id.is_not(None)


def finished_sql() -> ColumnElement[bool]:
    """« Relance terminée »: R<max> sent, or the current sequence closed `completed`."""
    return and_(
        has_cohort_sql(),
        or_(ContactSequence.closed_at.is_not(None), sent_count_sql() > max_follow_ups_sql()),
    )


def due_open_sql() -> ColumnElement[bool]:
    """Something is due at some date (see `contact_workflow.progress`); `next_due_at_sql` says
    when. ContactTracking must be joined (a missing tracking reads as `neutral`) and `Prospect` be
    in the FROM."""
    return and_(
        has_cohort_sql(),
        ContactSequence.closed_at.is_(None),
        Cohort.code != OUT_OF_CAMPAIGN_CODE,
        or_(
            ContactTracking.status.is_(None),
            ContactTracking.status == ContactTrackingStatus.NEUTRAL,
        ),
        Prospect.contactability_status == ContactabilityStatus.CONTACTABLE,
        sent_count_sql() <= max_follow_ups_sql(),
        ~email_error_sql(),
    )


def _business_midnight(local: ColumnElement[Any]) -> ColumnElement[datetime]:
    return func.timezone(str(BUSINESS_TIMEZONE), local)


def next_due_at_sql() -> ColumnElement[datetime | None]:
    """The next due date (business midnight), NULL when nothing is due; the twin of
    `contact_workflow.progress`."""
    tz = str(BUSINESS_TIMEZONE)
    after_last_send = func.date_trunc("week", func.timezone(tz, SENDS.c.last_sent_at)) + timedelta(
        weeks=1
    )
    return case(
        (~due_open_sql(), null()),
        (sent_count_sql() == 0, _business_midnight(cast(Cohort.starts_on, DateTime()))),
        else_=_business_midnight(after_last_send),
    )


def next_rank_sql() -> ColumnElement[int | None]:
    """The rank to send next; NULL without a cohort or when finished."""
    return case((~has_cohort_sql(), null()), (finished_sql(), null()), else_=sent_count_sql())
