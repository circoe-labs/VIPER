"""Open Contact messages follow a change of the person's e-mail addresses.

A message keeps the recipients it was written with. When the primary address changes, or an
address is changed, deactivated or removed, no unsent message may silently keep going to the old
one:

- in `To`, the old primary and every address that is no longer an active one of the person is
  replaced by the new primary (dropped without one); `Cc`/`Bcc` lose the dead addresses;
- a `validated` or `scheduled` message goes back to `draft` (the validation was about other
  recipients): its send moment is kept in the trace (`recipient_changed`), its Infomaniak draft is
  queued for deletion, and the code stays on the message until it is validated again;
- a message being sent (claimed) is left to the dispatcher and counted.

A person's own choice of another, still active, address is kept. Every writer of e-mail rows calls
`follow_address_change` with the `addresses` it read before writing.
"""

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.contact_messages import ContactMessage
from app.models.enums import ContactMessageStatus
from app.models.prospects import Email
from app.services import audit
from app.services.audit import AuditAction
from app.services.contact_remote_drafts import detach_remote_draft
from app.services.contact_schedule_trace import RECIPIENT_CHANGED, leave_schedule

logger = logging.getLogger(__name__)

M = ContactMessageStatus


@dataclass(frozen=True, slots=True)
class Addresses:
    primary: str | None
    active: frozenset[str]


def addresses(session: Session, prospect_id: uuid.UUID) -> Addresses:
    rows = session.execute(
        select(Email.address, Email.is_primary).where(
            Email.prospect_id == prospect_id, Email.is_active
        )
    ).all()
    return Addresses(
        next((address for address, primary in rows if primary), None),
        frozenset(address for address, _ in rows),
    )


@dataclass(frozen=True, slots=True)
class Followed:
    # Unsent messages whose recipients changed; of them, those that lost their validation.
    updated: int = 0
    unvalidated: int = 0
    # Being sent right now to the former recipients: only the dispatcher touches them.
    in_flight: int = 0


def _replaced(values: list[str], stale: frozenset[str], by: str | None) -> list[str]:
    out: list[str] = []
    for value in values:
        new = by if value in stale else value
        if new is not None and new not in out:
            out.append(new)
    return out


def follow_address_change(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, before: Addresses
) -> Followed:
    """Apply the module rules after the e-mail rows changed from `before` (flushed by the
    caller)."""
    after = addresses(session, prospect_id)
    stale = before.active - after.active
    if before.primary is not None and before.primary != after.primary:
        stale |= {before.primary}
    if not stale:
        return Followed()
    messages = session.scalars(
        select(ContactMessage)
        .where(ContactMessage.prospect_id == prospect_id, ContactMessage.status != M.SENT)
        .order_by(ContactMessage.rank)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    updated = unvalidated = in_flight = 0
    moment = datetime.now(UTC)
    for message in messages:
        to = _replaced(message.to_recipients, stale, after.primary)
        dead = stale - after.active
        cc = [a for a in message.cc_recipients if a not in dead and a not in to]
        bcc = [a for a in message.bcc_recipients if a not in dead and a not in to + cc]
        if (to, cc, bcc) == (
            message.to_recipients,
            message.cc_recipients,
            message.bcc_recipients,
        ):
            continue
        if message.dispatch_claim_id is not None:
            in_flight += 1
            continue
        validated = message.status in (M.VALIDATED, M.SCHEDULED)
        audit.annotate(
            session,
            actor,
            message,
            AuditAction.CONTACT_MESSAGE_UNVALIDATED if validated else None,
            reason=RECIPIENT_CHANGED,
        )
        message.to_recipients, message.cc_recipients, message.bcc_recipients = to, cc, bcc
        message.revision += 1
        if validated:
            leave_schedule(message, RECIPIENT_CHANGED, moment)
            message.status = M.DRAFT
            message.scheduled_at = None
            message.validated_revision = None
            message.validated_at = None
            message.validated_by_actor_id = None
            message.validated_by_display = None
            detach_remote_draft(session, message, "edited")
            message.dispatch_attempts = 0
            message.last_error_code = RECIPIENT_CHANGED
            message.last_error_at = moment
            unvalidated += 1
        updated += 1
    session.flush()
    if updated or in_flight:
        # Identifiers and counts only, never an address.
        logger.info(
            "contact_message.recipients_followed prospect=%s updated=%s unvalidated=%s "
            "in_flight=%s",
            prospect_id,
            updated,
            unvalidated,
            in_flight,
        )
    return Followed(updated, unvalidated, in_flight)
