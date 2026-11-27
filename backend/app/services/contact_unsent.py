"""The sends a person has to look at, and how they are recovered (never by themselves).

`overview` lists, among the open current sequences of prospects still in the automatic actions:

- `unconfirmed`    scheduled and claimed, the outcome unknown (settled in the editor);
- `missed`         scheduled, did not leave (`missed_reason`), not scheduled again yet;
- `draft_missing`  still scheduled, but the last check did not find its Infomaniak draft.

Recovery is a person's act: `reschedule` (the rules of `contact_messages.schedule`, message by
message) and `recreate_drafts`. A message whose earlier send may have left (`needs_sent_check`)
goes through only with the person's confirmation **on that item**: no bulk path carries one along.
"""

import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import Cohort, ContactMessage, ContactSequence, ContactTracking, Prospect
from app.models.companies import Company
from app.models.enums import ContactabilityStatus, ContactMessageStatus
from app.services import audit, contact_messages
from app.services.audit import AuditAction
from app.services.contact_remote_drafts import detach_remote_draft
from app.services.contact_schedule_trace import BY_PERSON, DRAFT_MISSING, DRAFT_UNVERIFIED
from app.services.contact_send_state import SendSituation, message_situation
from app.services.contact_workflow import SEQUENCE_CLOSING_STATES
from app.services.errors import ActorNotAllowedError, ContactMessageError, InvalidFieldError

logger = logging.getLogger(__name__)

M = ContactMessageStatus


@dataclass(frozen=True, slots=True)
class UnsentItem:
    prospect_id: uuid.UUID
    first_name: str | None
    last_name: str | None
    company_name: str | None
    cohort_code: str | None
    status: ContactMessageStatus
    revision: int
    # `unconfirmed` | `missed` | `draft_missing`
    kind: str
    send: SendSituation


@dataclass(frozen=True, slots=True)
class UnsentOverview:
    items: list[UnsentItem]
    # Scheduled messages whose draft the last check could not prove either way (mailbox of more
    # than 100 drafts).
    unverified_drafts: int


def overview(session: Session) -> UnsentOverview:
    open_sequences = (
        ContactSequence.is_current,
        ContactSequence.closed_at.is_(None),
        Prospect.contactability_status == ContactabilityStatus.CONTACTABLE,
        or_(
            ContactTracking.status.is_(None),
            ContactTracking.status.not_in(tuple(SEQUENCE_CLOSING_STATES)),
        ),
    )

    statement = (
        select(ContactMessage, Prospect, Company.display_name, Cohort.code)
        .join(ContactSequence, ContactSequence.id == ContactMessage.sequence_id)
        .join(Prospect, Prospect.id == ContactMessage.prospect_id)
        .outerjoin(ContactTracking, ContactTracking.prospect_id == Prospect.id)
        .outerjoin(Company, Company.id == Prospect.company_id)
        .outerjoin(Cohort, Cohort.id == ContactSequence.cohort_id)
        .where(
            *open_sequences,
            or_(
                ContactMessage.status.in_((M.DRAFT, M.VALIDATED))
                & ContactMessage.missed_reason.not_in(tuple(BY_PERSON)),
                (ContactMessage.status == M.SCHEDULED)
                & (
                    ContactMessage.dispatch_claim_id.is_not(None)
                    | (ContactMessage.draft_check == DRAFT_MISSING)
                ),
            ),
        )
        .order_by(
            func.coalesce(ContactMessage.missed_scheduled_at, ContactMessage.scheduled_at),
            func.lower(Prospect.last_name).asc().nulls_last(),
            ContactMessage.rank,
        )
    )
    items = []
    for message, prospect, company, cohort in session.execute(statement).tuples():
        send = message_situation(message)
        # A claim still running (no recorded outcome) is not for a person yet.
        if send is None or (send.state == "scheduled" and not send.draft_missing):
            continue
        items.append(
            UnsentItem(
                prospect_id=prospect.id,
                first_name=prospect.first_name,
                last_name=prospect.last_name,
                company_name=company,
                cohort_code=cohort,
                status=message.status,
                revision=message.revision,
                kind="draft_missing" if send.state == "scheduled" else send.state,
                send=send,
            )
        )
    unverified = session.scalar(
        select(func.count())
        .select_from(ContactMessage)
        .join(ContactSequence, ContactSequence.id == ContactMessage.sequence_id)
        .join(Prospect, Prospect.id == ContactMessage.prospect_id)
        .outerjoin(ContactTracking, ContactTracking.prospect_id == Prospect.id)
        .where(
            *open_sequences,
            ContactMessage.status == M.SCHEDULED,
            ContactMessage.draft_check == DRAFT_UNVERIFIED,
        )
    )
    return UnsentOverview(items=items, unverified_drafts=unverified or 0)


# --- recovery -------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class Target:
    prospect_id: uuid.UUID
    rank: int
    expected_revision: int
    # The person looked in the sent items for this message.
    sent_check_confirmed: bool = False


@dataclass(frozen=True, slots=True)
class Refused:
    prospect_id: uuid.UUID
    rank: int
    code: str


@dataclass(slots=True)
class Recovery:
    # Message ids handled.
    done: list[uuid.UUID] = field(default_factory=list)
    refused: list[Refused] = field(default_factory=list)


def _require_person(actor: ActorContext) -> None:
    if actor.type is not ActorType.HUMAN or not actor.id:
        raise ActorNotAllowedError("An unsent message is recovered by a person.")


def reschedule(
    session: Session,
    actor: ActorContext,
    targets: Sequence[Target],
    scheduled_at: datetime,
    *,
    now: datetime | None = None,
) -> Recovery:
    """Schedule each target at `scheduled_at`, each in its own savepoint: one refusal (changed
    meanwhile, to validate again, sent check not confirmed…) never stops the others."""
    _require_person(actor)
    current = now or datetime.now(UTC)
    contact_messages.require_send_moment(scheduled_at, current)
    result = Recovery()
    for target in targets:
        try:
            with session.begin_nested():
                scheduled = contact_messages.schedule(
                    session,
                    actor,
                    target.prospect_id,
                    target.rank,
                    target.expected_revision,
                    scheduled_at,
                    sent_check_confirmed=target.sent_check_confirmed,
                    now=current,
                )
        except (ContactMessageError, InvalidFieldError) as error:
            code = getattr(error, "code", "invalid")
            result.refused.append(Refused(target.prospect_id, target.rank, code))
            continue
        result.done.append(scheduled.message.id)
    logger.info(
        "contact_unsent.rescheduled scheduled=%s refused=%s",
        len(result.done),
        len(result.refused),
    )
    return result


def recreate_drafts(session: Session, actor: ActorContext, targets: Sequence[Target]) -> Recovery:
    """A scheduled message whose draft is missing loses it (queued for deletion, should it still
    exist somewhere) so that the caller creates a new one; the send moment stays. Only with the
    person's confirmation that the mail is not in the sent items."""
    _require_person(actor)
    result = Recovery()
    for target in targets:
        message = session.scalar(
            select(ContactMessage)
            .join(ContactSequence, ContactSequence.id == ContactMessage.sequence_id)
            .where(
                ContactSequence.is_current,
                ContactMessage.prospect_id == target.prospect_id,
                ContactMessage.rank == target.rank,
            )
            .with_for_update(of=ContactMessage)
            .execution_options(populate_existing=True)
        )
        code = None
        if message is None:
            code = "message_not_found"
        elif message.revision != target.expected_revision:
            code = "revision_conflict"
        elif message.dispatch_claim_id is not None:
            code = "dispatch_in_progress"
        elif message.status is not M.SCHEDULED or message.draft_check != DRAFT_MISSING:
            code = "invalid_transition"
        elif not target.sent_check_confirmed:
            code = "sent_check_required"
        if message is None or code is not None:
            result.refused.append(Refused(target.prospect_id, target.rank, code or "invalid"))
            continue
        audit.annotate(
            session,
            actor,
            message,
            AuditAction.CONTACT_MESSAGE_DRAFT_REPLACED,
            reason="sent_items_checked",
        )
        detach_remote_draft(session, message, "replaced")
        session.flush()
        result.done.append(message.id)
    logger.info(
        "contact_unsent.drafts_replaced replaced=%s refused=%s",
        len(result.done),
        len(result.refused),
    )
    return result
