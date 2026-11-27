"""The warehouse mails written before warehouse people became prospects, seen from Contact
(`doc/features/warehouses.md`). No new warehouse mail is written: these are history, plus the
already programmed ones the dispatcher still sends. This module keeps the two from sending twice:

- a mail is a prospect's (`mails_of`) when it is linked to them (`prospect_id`), or, still
  unlinked, when it went to one of their addresses under their name;
- `carry` records a real warehouse send as a Contact step of the prospect's open sequence, so it
  counts among the three e-mails (the one writer of a sent row besides `contact_messages`);
- `contact_refusal`: nothing leaves from Contact while a warehouse mail of the person is
  programmed or unsettled, or sent and not yet counted;
- `legacy_refusal`: a programmed warehouse mail does not leave to someone already written to.

Imports models and low-level services only (`contact_sequences` calls it).
"""

import logging
import re
import uuid
from datetime import UTC, datetime

from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models import ContactMessage, ContactSequence, Email, Prospect, WarehouseDraft
from app.models.enums import ContactMessageStatus, SendSource
from app.services import app_settings, audit
from app.services.audit import AuditAction
from app.services.contact_remote_drafts import detach_remote_draft
from app.services.contact_schedule_trace import forget_schedule_trace
from app.services.imports.text import fold

logger = logging.getLogger(__name__)

M = ContactMessageStatus
CIVILITIES = frozenset({"m", "mr", "mme", "mlle", "dr", "monsieur", "madame", "mademoiselle"})
# Programmed, being sent, or possibly sent.
PENDING = ("scheduled", "sending", "uncertain")
ADDRESS = re.compile(r"[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+")
# API refusal codes; the dispatcher's `last_error_code` are their `send_…` twins.
PENDING_CODE = "warehouse_send_pending"
UNRECORDED_CODE = "warehouse_send_unrecorded"
DISPATCH_CODES = {
    PENDING_CODE: "send_warehouse_pending",
    UNRECORDED_CODE: "send_warehouse_unrecorded",
}
MESSAGES = {
    PENDING_CODE: "A warehouse mail to this person is programmed or not settled: settle it first.",
    UNRECORDED_CODE: "A warehouse mail already sent to this person is not counted yet: use "
    "« Contacter » on the warehouse sheet.",
}
# The `failure_code` of a programmed warehouse mail to someone already written to.
ALREADY_CONTACTED = "contacted_in_contact"
CARRY_REASON = "warehouse_mail"


def name_key(name: str | None) -> str:
    """The words of a person's name without civility, accents, case or order."""
    return " ".join(sorted(word for word in fold(name or "").split() if word not in CIVILITIES))


def mails_of(session: Session, prospect_id: uuid.UUID) -> list[WarehouseDraft]:
    """Every warehouse mail of the person, oldest first."""
    addresses = select(Email.address).where(Email.prospect_id == prospect_id)
    found = session.scalars(
        select(WarehouseDraft)
        .where(
            or_(
                WarehouseDraft.prospect_id == prospect_id,
                WarehouseDraft.prospect_id.is_(None)
                & func.lower(func.trim(WarehouseDraft.recipient)).in_(addresses),
            )
        )
        .order_by(WarehouseDraft.created_at, WarehouseDraft.id)
    ).all()
    if all(draft.prospect_id is not None for draft in found):
        return list(found)
    first, last = session.execute(
        select(Prospect.first_name, Prospect.last_name).where(Prospect.id == prospect_id)
    ).one()
    mine = name_key(f"{first or ''} {last or ''}")
    return [d for d in found if d.prospect_id is not None or name_key(d.contact_name) == mine]


def sent_moment(draft: WarehouseDraft) -> datetime:
    return draft.sent_at or draft.scheduled_at or draft.validated_at or draft.created_at


def contact_refusal(session: Session, prospect_id: uuid.UUID) -> str | None:
    """Why nothing may be programmed or leave from Contact for this person, None when free."""
    mails = mails_of(session, prospect_id)
    if any(draft.send_state in PENDING for draft in mails):
        return PENDING_CODE
    if any(d.send_state == "sent" and d.carried_message_id is None for d in mails):
        contacted = session.scalar(
            select(ContactMessage.id)
            .join(ContactSequence, ContactSequence.id == ContactMessage.sequence_id)
            .where(
                ContactSequence.prospect_id == prospect_id,
                ContactSequence.is_current,
                ContactMessage.rank == 0,
                ContactMessage.status == M.SENT,
            )
        )
        if contacted is None:
            return UNRECORDED_CODE
    return None


def legacy_refusal(session: Session, draft: WarehouseDraft) -> str | None:
    """`ALREADY_CONTACTED` when the prospect a programmed warehouse mail is for has been written
    to: a Contact message sent or being sent, or another warehouse mail of theirs."""
    people = {draft.prospect_id} if draft.prospect_id else set()
    address = (draft.recipient or "").strip().lower()
    if not people and address:
        for found, first, last in session.execute(
            select(Prospect.id, Prospect.first_name, Prospect.last_name)
            .join(Email, Email.prospect_id == Prospect.id)
            .where(Email.address == address)
        ).tuples():
            if name_key(f"{first or ''} {last or ''}") == name_key(draft.contact_name):
                people.add(found)
    for prospect_id in people:
        written = session.scalar(
            select(ContactMessage.id)
            .where(
                ContactMessage.prospect_id == prospect_id,
                or_(
                    ContactMessage.status == M.SENT,
                    ContactMessage.dispatch_claim_id.is_not(None),
                ),
            )
            .limit(1)
        )
        other = any(
            d.id != draft.id and d.send_state in ("sending", "uncertain", "sent")
            for d in mails_of(session, prospect_id)
        )
        if written is not None or other:
            return ALREADY_CONTACTED
    return None


def carry(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, *, now: datetime | None = None
) -> int:
    """Count the linked warehouse sends not yet accounted for; returns how many steps were
    written. A send no later (by day) than a recorded Contact send is covered by it. Otherwise it
    becomes the first unsent step of the open sequence (never in S0, never beyond « max
    relances »; the step's unsent text stays in its versions). Without such a sequence it waits:
    nothing can be programmed meanwhile (there is no sequence, or `contact_refusal`). Idempotent:
    a counted mail is marked (`carried_message_id`)."""
    drafts = sorted(
        session.scalars(
            select(WarehouseDraft)
            .where(
                WarehouseDraft.prospect_id == prospect_id,
                WarehouseDraft.send_state == "sent",
                WarehouseDraft.carried_message_id.is_(None),
            )
            .with_for_update()
        ).all(),
        key=sent_moment,
    )
    if not drafts:
        return 0
    moment = now or datetime.now(UTC)
    sequence = session.scalar(
        select(ContactSequence)
        .where(
            ContactSequence.prospect_id == prospect_id,
            ContactSequence.is_current,
            ContactSequence.closed_at.is_(None),
        )
        .with_for_update(of=ContactSequence)
    )
    written = 0
    for draft in drafts:
        left = sent_moment(draft)
        sends = session.scalars(
            select(ContactMessage)
            .where(ContactMessage.prospect_id == prospect_id, ContactMessage.status == M.SENT)
            .order_by(ContactMessage.sent_at, ContactMessage.rank)
        ).all()
        covering = next(
            (m for m in sends if m.sent_at is not None and m.sent_at.date() >= left.date()), None
        )
        if covering is None:
            if sequence is None or sequence.cohort.out_of_campaign:
                continue
            rows = {
                row.rank: row
                for row in session.scalars(
                    select(ContactMessage)
                    .where(ContactMessage.sequence_id == sequence.id)
                    .with_for_update()
                    .execution_options(populate_existing=True)
                )
            }
            rank = 0
            while rank in rows and rows[rank].status is M.SENT:
                rank += 1
            if rank > app_settings.max_follow_ups(session):
                covering = rows[rank - 1]
            else:
                message = rows.get(rank)
                if message is not None and message.dispatch_claim_id is not None:
                    continue  # being sent: the dispatcher owns it
                covering = _record(
                    session, actor, sequence, rank, message, draft, min(left, moment)
                )
                written += 1
        draft.carried_message_id = covering.id
        session.flush()
    if written:
        logger.info("warehouse_history.carried prospect=%s steps=%s", prospect_id, written)
    return written


def _record(
    session: Session,
    actor: ActorContext,
    sequence: ContactSequence,
    rank: int,
    message: ContactMessage | None,
    draft: WarehouseDraft,
    left: datetime,
) -> ContactMessage:
    new = message is None
    if message is None:
        message = ContactMessage(
            prospect_id=sequence.prospect_id, sequence_id=sequence.id, rank=rank
        )
    audit.annotate(session, actor, message, AuditAction.CONTACT_MESSAGE_SENT, reason=CARRY_REASON)
    if not new:
        detach_remote_draft(session, message, "replaced")
        forget_schedule_trace(message)
        message.revision += 1
        message.cancelled_at = None
        message.cancel_reason = None
        message.generation_model = None
        message.generation_prompt_version = None
        message.generated_at = None
    recipient = (draft.recipient or "").strip().lower()
    message.to_recipients = [recipient] if ADDRESS.fullmatch(recipient) else []
    message.cc_recipients = []
    message.bcc_recipients = []
    message.from_email = None
    message.subject = draft.subject
    message.body_text = draft.body
    message.status = M.SENT
    message.sent_at = left
    message.sent_source = SendSource.MIGRATION
    if new:
        session.add(message)
    session.flush()
    return message
