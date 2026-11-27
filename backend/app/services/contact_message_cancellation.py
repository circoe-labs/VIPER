"""Mechanical cancellation of a prospect's unsent Contact messages (decision 29 and the durable
opposition).

Three triggers, all inside the caller's transaction:

- a sequence-closing state chosen for the prospect (`response_received`, `appointment_obtained`,
  `ignored`) — `cancel_reason = prospect_state:<state>` (`contact_tracking`);
- the durable opposition `do_not_contact` being recorded — `cancel_reason = do_not_contact`
  (`prospects.mark_do_not_contact`). On the `ignored` path the state cancels first, so its
  reason wins and the opposition finds nothing left.

- the person stopped being eligible for another reason (`app.services.eligibility`: left the
  role, archived, temporarily excluded) — `cancel_reason` = the block's code. These are
  reversible, so only what could leave is cancelled (`validated`, `scheduled`): drafts are kept.

The opposition and the blocks also stop the warehouse mails addressed to the person (planned or
scheduled -> `failed` with the code): never sent, visible, to be prepared again by a person.

Otherwise `draft`/`validated`/`scheduled` messages are cancelled; `sent` and `cancelled` are
untouched; a
message claimed by the dispatcher (`dispatch_claim_id`) is left to it and counted as in flight
(S7 re-reads the state and the opposition inside its claim before sending).

Kept apart from `contact_messages` so `prospects` can call it without an import cycle: this
module depends on the models and the audit only.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import ColumnElement, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.contact_messages import ContactMessage
from app.models.enums import ContactMessageStatus, ContactTrackingStatus
from app.models.warehouse_drafts import WarehouseDraft
from app.services import audit, eligibility
from app.services.audit import AuditAction
from app.services.contact_remote_drafts import detach_remote_draft
from app.services.contact_schedule_trace import CANCELLED, leave_schedule

logger = logging.getLogger(__name__)

M = ContactMessageStatus
# Not yet sent and still alive: what a person or a mechanical cancellation may cancel.
CANCELLABLE = (M.DRAFT, M.VALIDATED, M.SCHEDULED)
DO_NOT_CONTACT_REASON = "do_not_contact"
# What a reversible block cancels: the messages that could leave.
SENDABLE = (M.VALIDATED, M.SCHEDULED)


def state_cancel_reason(state: ContactTrackingStatus) -> str:
    """`cancel_reason` of the cancellation after a sequence-closing state."""
    return f"prospect_state:{state.value}"


@dataclass(frozen=True, slots=True)
class Cancellation:
    """What a mechanical cancellation did: messages cancelled, and claimed ones left to the
    dispatcher."""

    cancelled: int = 0
    in_flight: int = 0

    def then(self, later: Cancellation) -> Cancellation:
        """Two passes in a row: cancellations add up; the in-flight messages are the later
        pass's (it saw the same claimed rows again)."""
        return Cancellation(self.cancelled + later.cancelled, later.in_flight)


NOTHING = Cancellation()


def cancel_message(
    session: Session, message: ContactMessage, reason: str, moment: datetime
) -> None:
    """Move one unsent message to `cancelled` (the caller annotates the audit and checks the
    status). Its remote draft (S6) is queued for deletion and detached; a send moment it had
    is kept in the trace."""
    if message.status is M.SCHEDULED:
        leave_schedule(message, CANCELLED, moment)
    message.status = M.CANCELLED
    message.cancelled_at = moment
    message.cancel_reason = reason
    detach_remote_draft(session, message, "cancelled")


def cancel_unsent_messages(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    reason: str,
    *,
    now: datetime | None = None,
    sequence_id: uuid.UUID | None = None,
) -> Cancellation:
    """Cancel the prospect's unsent, unclaimed messages with `reason`; any actor that may make
    the triggering change (imports included). Rows are locked while changed. `sequence_id` narrows
    it to one sequence (the dispatcher cancelling a closed sequence's message after the person
    prepared the next one)."""
    moment = now or datetime.now(UTC)
    statuses = SENDABLE if reason in eligibility.REVERSIBLE_CODES else CANCELLABLE
    query = (
        select(ContactMessage)
        .where(ContactMessage.prospect_id == prospect_id, ContactMessage.status.in_(statuses))
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if sequence_id is not None:
        query = query.where(ContactMessage.sequence_id == sequence_id)
    rows = session.scalars(query).all()
    cancelled = in_flight = 0
    for message in rows:
        if message.dispatch_claim_id is not None:
            in_flight += 1
            continue
        audit.annotate(
            session, actor, message, AuditAction.CONTACT_MESSAGE_CANCELLED, reason=reason
        )
        cancel_message(session, message, reason, moment)
        cancelled += 1
    session.flush()
    if reason == DO_NOT_CONTACT_REASON or reason in eligibility.REVERSIBLE_CODES:
        code = eligibility.Block.DO_NOT_CONTACT if reason == DO_NOT_CONTACT_REASON else reason
        stop_warehouse_drafts(
            session, actor, eligibility.warehouse_recipients_of(prospect_id), str(code), moment
        )
    if rows:
        # Identifiers and counts only.
        logger.info(
            "contact_message.mechanical_cancel prospect=%s reason=%s cancelled=%s in_flight=%s",
            prospect_id,
            reason,
            cancelled,
            in_flight,
        )
    return Cancellation(cancelled, in_flight)


def cancel_if_ineligible(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID
) -> Cancellation:
    """After a change that may have removed the person from prospecting (departure, archive,
    exclusion, company change): cancel what could still leave. The opposition has its own call."""
    block = eligibility.block_of(session, prospect_id)
    if block is None or block is eligibility.Block.DO_NOT_CONTACT:
        return NOTHING
    return cancel_unsent_messages(session, actor, prospect_id, block.value)


def stop_warehouse_drafts(
    session: Session,
    actor: ActorContext,
    which: ColumnElement[bool],
    code: str,
    moment: datetime,
) -> int:
    """The planned or scheduled warehouse mails matching `which` become `failed` with `code`
    (a mail being sent or already sent is left to the dispatcher)."""
    drafts = session.scalars(
        select(WarehouseDraft)
        .where(which, WarehouseDraft.send_state.in_(("planned", "scheduled")))
        .order_by(WarehouseDraft.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    for draft in drafts:
        draft.send_state = "failed"
        draft.failure_code = code
        draft.failed_at = moment
        draft.validated_at = None
        draft.validated_by = None
        draft.revision += 1
        audit.record_event(
            session,
            actor,
            "warehouse_draft.failed",
            entity_type="warehouse_draft",
            entity_id=draft.id,
            reason=code,
        )
    if drafts:
        session.flush()
        logger.info("warehouse_draft.stopped code=%s count=%s", code, len(drafts))
    return len(drafts)
