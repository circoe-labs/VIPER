"""Are the Infomaniak drafts of the scheduled messages still reachable? (before their due time)

A Toolbox disconnected and reconnected (another account, a mailbox emptied) must not be discovered
at send time. The worker looks right after a (re)connection and then every `CHECK_INTERVAL`; a
person may ask for a look too. One `list_drafts` call, its answers recorded in `draft_check`:

- listed                                  → NULL;
- absent from a complete list             → `missing` (shown, a person decides);
- absent from a full page (100, the
  Toolbox maximum: absence proves nothing) → `unverified` (an earlier `missing` stays).

**Nothing is recreated, unscheduled or sent here.** A draft may be absent because the person sent
it by hand from Infomaniak: recreating it by itself would send the mail twice. A person checks the
sent items, then recreates the draft (`contact_unsent.recreate_drafts`) or settles the message. At
the due time `send_draft` stays the judge: a false alarm sends normally.
"""

import logging
import uuid
from dataclasses import dataclass

from sqlalchemy import ColumnElement, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.actor import ActorContext
from app.models import ContactMessage
from app.models.enums import ContactMessageStatus
from app.services import audit
from app.services.audit import AuditAction
from app.services.contact_dispatch import DISPATCH_ACTOR, DISPATCH_CONTEXT, RECONCILE_LIST_LIMIT
from app.services.contact_schedule_trace import DRAFT_MISSING, DRAFT_UNVERIFIED
from app.services.toolbox.mcp_client import MailToolbox

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class DraftCheck:
    present: int = 0
    missing: int = 0
    unverified: int = 0


def _waiting() -> tuple[ColumnElement[bool], ...]:
    return (
        ContactMessage.status == ContactMessageStatus.SCHEDULED,
        ContactMessage.dispatch_claim_id.is_(None),
        ContactMessage.remote_draft_id.is_not(None),
    )


def check_scheduled_drafts(
    session_factory: sessionmaker[Session],
    toolbox: MailToolbox,
    actor: ActorContext = DISPATCH_ACTOR,
) -> DraftCheck:
    """Raises the Toolbox's `ToolboxError` when the list cannot be read (nothing is changed)."""
    with audit.attributed_unit_of_work(session_factory, actor, DISPATCH_CONTEXT) as session:
        # Read before the list: a draft created during the call is not judged by an older list.
        known: list[tuple[uuid.UUID, str | None]] = [
            (message_id, draft_id)
            for message_id, draft_id in session.execute(
                select(ContactMessage.id, ContactMessage.remote_draft_id).where(*_waiting())
            ).tuples()
        ]
    result = DraftCheck()
    if not known:
        return result
    drafts = toolbox.list_drafts(RECONCILE_LIST_LIMIT)
    listed = {draft.draft_id for draft in drafts}
    complete = len(drafts) < RECONCILE_LIST_LIMIT
    for message_id, draft_id in known:
        with audit.attributed_unit_of_work(session_factory, actor, DISPATCH_CONTEXT) as session:
            message = session.scalar(
                select(ContactMessage)
                .where(ContactMessage.id == message_id, *_waiting())
                .with_for_update(skip_locked=True)
            )
            if message is None or message.remote_draft_id != draft_id:
                continue  # claimed, changed or being written meanwhile: next look
            if draft_id in listed:
                found = None
                result.present += 1
            elif complete or message.draft_check == DRAFT_MISSING:
                found = DRAFT_MISSING
                result.missing += 1
            else:
                found = DRAFT_UNVERIFIED
                result.unverified += 1
            if found == message.draft_check:
                continue
            action = (
                AuditAction.CONTACT_MESSAGE_DRAFT_MISSING
                if found == DRAFT_MISSING
                else AuditAction.CONTACT_MESSAGE_DRAFT_CHECKED
            )
            audit.annotate(session, actor, message, action)
            message.draft_check = found
            if found == DRAFT_MISSING:
                logger.warning(
                    "contact_dispatch.draft_missing message=%s prospect=%s step=%s",
                    message.id,
                    message.prospect_id,
                    message.step,
                )
    logger.info(
        "contact_dispatch.draft_check present=%s missing=%s unverified=%s listed=%s",
        result.present,
        result.missing,
        result.unverified,
        len(drafts),
    )
    return result
