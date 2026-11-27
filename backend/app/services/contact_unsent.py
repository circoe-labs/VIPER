"""The sends a person has to look at, and how they are recovered (never by themselves).

`overview` lists, for the prospects still in the automatic actions:

- `unconfirmed`    scheduled and claimed, the outcome unknown (settled in the editor);
- `doubt`          not scheduled and may have left (`sent_doubt_*`), whatever its status or
                   sequence: it stays until a person says they looked in the sent items;
- `missed`         scheduled, did not leave (`missed_reason`), not scheduled again yet;
- `draft_missing`  still scheduled, but the last check did not find its Infomaniak draft.

Recovery is a person's act: `reschedule` (the rules of `contact_messages.schedule`, message by
message), `recreate_drafts` and `confirm_not_sent`. A mail that may have left goes through only
with the person's confirmation **on that item**: no bulk path carries one along.
"""

import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models import Cohort, ContactMessage, ContactSequence, ContactTracking, Prospect
from app.models.companies import Company
from app.models.enums import ContactMessageStatus
from app.services import audit, contact_messages, eligibility, email_identity
from app.services.audit import AuditAction
from app.services.contact_remote_drafts import detach_remote_draft
from app.services.contact_schedule_trace import (
    BY_PERSON,
    DRAFT_MISSING,
    DRAFT_UNVERIFIED,
    clear_doubt,
    covering_doubts,
)
from app.services.contact_send_state import SendSituation, message_situation
from app.services.contact_workflow import SEQUENCE_CLOSING_STATES
from app.services.errors import ActorNotAllowedError, ContactMessageError, InvalidFieldError

logger = logging.getLogger(__name__)

M = ContactMessageStatus


@dataclass(frozen=True, slots=True)
class UnsentItem:
    message_id: uuid.UUID
    # In the prospect's open current sequence (only those can be scheduled again).
    current: bool
    prospect_id: uuid.UUID
    first_name: str | None
    last_name: str | None
    company_name: str | None
    cohort_code: str | None
    status: ContactMessageStatus
    revision: int
    # `unconfirmed` | `doubt` | `missed` | `draft_missing`
    kind: str
    send: SendSituation


@dataclass(frozen=True, slots=True)
class UnsentOverview:
    items: list[UnsentItem]
    # Scheduled messages whose draft the last check could not prove either way (mailbox of more
    # than 100 drafts).
    unverified_drafts: int


def overview(session: Session) -> UnsentOverview:
    eligible = (
        eligibility.eligible_sql(),
        or_(
            ContactTracking.status.is_(None),
            ContactTracking.status.not_in(tuple(SEQUENCE_CLOSING_STATES)),
        ),
    )
    current = and_(ContactSequence.is_current, ContactSequence.closed_at.is_(None))
    statement = (
        select(ContactMessage, Prospect, Company.display_name, Cohort.code, current)
        .join(ContactSequence, ContactSequence.id == ContactMessage.sequence_id)
        .join(Prospect, Prospect.id == ContactMessage.prospect_id)
        .outerjoin(ContactTracking, ContactTracking.prospect_id == Prospect.id)
        .outerjoin(Company, Company.id == Prospect.company_id)
        .outerjoin(Cohort, Cohort.id == ContactSequence.cohort_id)
        .where(
            *eligible,
            or_(
                and_(
                    current,
                    ContactMessage.status.in_((M.DRAFT, M.VALIDATED)),
                    ContactMessage.missed_reason.not_in(tuple(BY_PERSON)),
                ),
                and_(
                    current,
                    ContactMessage.status == M.SCHEDULED,
                    ContactMessage.dispatch_claim_id.is_not(None)
                    | (ContactMessage.draft_check == DRAFT_MISSING),
                ),
                and_(
                    ContactMessage.status != M.SENT,
                    ContactMessage.sent_doubt_reason.is_not(None),
                ),
            ),
        )
        .order_by(
            func.coalesce(ContactMessage.missed_scheduled_at, ContactMessage.scheduled_at),
            func.lower(Prospect.last_name).asc().nulls_last(),
            ContactMessage.rank,
        )
    )
    rows = session.execute(statement).tuples().all()
    # The sequences holding a doubt, per prospect: it covers the messages of the other ones.
    doubtful: dict[uuid.UUID, set[uuid.UUID]] = {}
    for message, *_ in rows:
        if message.sent_doubt_reason is not None:
            doubtful.setdefault(message.prospect_id, set()).add(message.sequence_id)
    items = []
    for message, prospect, company, cohort, is_current in rows:
        send = message_situation(message)
        if send is None:
            continue
        if message.status is M.SCHEDULED:
            # A claim still running (no recorded outcome) is not for a person yet; a draft seen
            # again leaves at its time.
            if send.state == "scheduled" and not send.draft_missing:
                continue
            kind = "draft_missing" if send.state == "scheduled" else send.state
        else:
            kind = "doubt" if send.state == "doubt" else "missed"
        if doubtful.get(prospect.id, set()) - {message.sequence_id}:
            send = replace(send, needs_sent_check=True)
        items.append(
            UnsentItem(
                message_id=message.id,
                current=bool(is_current),
                prospect_id=prospect.id,
                first_name=prospect.first_name,
                last_name=prospect.last_name,
                company_name=company,
                cohort_code=cohort,
                status=message.status,
                revision=message.revision,
                kind=kind,
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
            *eligible,
            current,
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
        elif email_identity.message_doubts(
            session,
            message.prospect_id,
            message.to_recipients,
            [*message.cc_recipients, *message.bcc_recipients],
        ):
            code = email_identity.CODE
        if message is None or code is not None:
            result.refused.append(Refused(target.prospect_id, target.rank, code or "invalid"))
            continue
        for doubt in covering_doubts(session, message):
            if doubt.id != message.id:
                _checked(session, actor, doubt)
        audit.annotate(
            session,
            actor,
            message,
            AuditAction.CONTACT_MESSAGE_DRAFT_REPLACED,
            reason="sent_items_checked",
        )
        clear_doubt(message)
        detach_remote_draft(session, message, "replaced")
        session.flush()
        result.done.append(message.id)
    logger.info(
        "contact_unsent.drafts_replaced replaced=%s refused=%s",
        len(result.done),
        len(result.refused),
    )
    return result


def _checked(session: Session, actor: ActorContext, message: ContactMessage) -> None:
    audit.annotate(
        session,
        actor,
        message,
        AuditAction.CONTACT_MESSAGE_SENT_CHECKED,
        reason="sent_items_checked",
    )
    clear_doubt(message)


def confirm_not_sent(
    session: Session, actor: ActorContext, targets: Sequence[tuple[uuid.UUID, int]]
) -> Recovery:
    """The person looked in the sent items: these mails (`(message_id, revision)`) did not leave.
    Only the doubt goes; nothing is scheduled. A scheduled message is refused (its missing draft
    is recreated, or its unconfirmed send settled)."""
    _require_person(actor)
    result = Recovery()
    for message_id, revision in targets:
        message = session.get(ContactMessage, message_id, with_for_update=True)
        if message is None:
            result.refused.append(Refused(message_id, 0, "message_not_found"))
            continue
        code = None
        if message.revision != revision:
            code = "revision_conflict"
        elif message.status in (M.SENT, M.SCHEDULED) or message.sent_doubt_reason is None:
            code = "invalid_transition"
        if code is not None:
            result.refused.append(Refused(message.prospect_id, message.rank, code))
            continue
        _checked(session, actor, message)
        session.flush()
        result.done.append(message.id)
    logger.info(
        "contact_unsent.confirmed_not_sent confirmed=%s refused=%s",
        len(result.done),
        len(result.refused),
    )
    return result
