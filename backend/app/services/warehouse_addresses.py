"""Warehouse mails and the e-mail addresses of people (`doc/features/prospecting-lifecycle.md`).

A warehouse mail holds a free-text recipient, so an address change or removal does not rewrite it:

- `stop_for_removed` (called with every address change, `contact_recipients`): a mail to an
  address a person no longer actively holds loses its human validation, and a planned or
  scheduled one becomes `failed` (`recipient_changed`) — a person validates it again;
- `refusal` is the one send check (validation, programming and the send itself); it does not rely
  on that having been called. In order: the blocks of `eligibility.warehouse_block`; then the audit
  log for an address nobody actively holds (someone who held it and is blocked still blocks it, and
  one removed after the mail's last human validation waits for a new one); then an address that
  looks like someone else's (`email_identity.warehouse_doubt`).

The audit log keeps e-mail addresses in clear (`app.core.audit_policy`, `personal_values`).
"""

from collections.abc import Collection
from datetime import datetime

from sqlalchemy import and_, func, or_, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models import AuditLogEntry, Email, WarehouseDraft
from app.services import audit, eligibility, email_identity
from app.services.contact_message_cancellation import stop_warehouse_drafts
from app.services.contact_schedule_trace import RECIPIENT_CHANGED


def stop_for_removed(
    session: Session, actor: ActorContext, removed: Collection[str], moment: datetime
) -> int:
    """The mails to `removed` addresses wait for a person; how many were planned or scheduled."""
    if not removed:
        return 0
    which = func.lower(func.trim(WarehouseDraft.recipient)).in_(sorted(removed))
    stopped = stop_warehouse_drafts(session, actor, which, RECIPIENT_CHANGED, moment)
    # Validated but not programmed: it cannot be programmed on the former decision either.
    for draft in session.scalars(
        select(WarehouseDraft)
        .where(
            which,
            WarehouseDraft.human_validated,
            or_(
                WarehouseDraft.send_state.is_(None),
                WarehouseDraft.send_state == "failed",
            ),
        )
        .order_by(WarehouseDraft.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all():
        draft.human_validated = False
        draft.revision += 1
        audit.record_event(
            session,
            actor,
            "warehouse_draft.updated",
            entity_type="warehouse_draft",
            entity_id=draft.id,
            reason=RECIPIENT_CHANGED,
        )
    session.flush()
    return stopped


def refusal(session: Session, draft: WarehouseDraft, *, deciding: bool = False) -> str | None:
    """Why the mail may not leave (an `eligibility.Block` value, `recipient_changed` or
    `email_identity.CODE`), None when it may. `deciding`: a person is validating or preparing it,
    which is the new decision a removed address asks for; a block or a doubt still refuses."""
    code = _lifecycle_refusal(session, draft, deciding)
    if code is not None:
        return code
    doubt = email_identity.warehouse_doubt(session, draft)
    return email_identity.CODE if doubt is not None else None


def _lifecycle_refusal(session: Session, draft: WarehouseDraft, deciding: bool) -> str | None:
    block = eligibility.warehouse_block(session, draft)
    if block is not None:
        return block.value
    address = (draft.recipient or "").strip().lower()
    if not address:
        return None
    held_now = session.scalar(
        select(Email.id).where(Email.address == address, Email.is_active).limit(1)
    )
    if held_now is not None:
        return None
    value = AuditLogEntry.changes["address"]
    held = session.execute(
        select(AuditLogEntry.entity_id, AuditLogEntry.subject_id)
        .where(
            AuditLogEntry.entity_type == "email",
            or_(value["after"].astext == address, value["before"].astext == address),
        )
        .distinct()
    ).all()
    if not held:
        return None  # never a person's address
    rows = [row for row, _ in held if row is not None]
    holders = [person for _, person in held if person is not None]
    blocks = set(eligibility.blocks_of(session, holders).values())
    if blocks:
        return next(item.value for item in eligibility.Block if item.value in blocks)
    if deciding:
        return None
    removed_at = session.scalar(
        select(func.max(AuditLogEntry.occurred_at)).where(
            or_(
                # Changed to something else, deleted, or deactivated…
                and_(
                    AuditLogEntry.entity_type == "email",
                    AuditLogEntry.entity_id.in_(rows),
                    or_(
                        value["before"].astext == address,
                        AuditLogEntry.changes["is_active"]["after"].astext == "false",
                    ),
                ),
                # … or gone with its person.
                and_(
                    AuditLogEntry.entity_type == "prospect",
                    AuditLogEntry.entity_id.in_(holders),
                    AuditLogEntry.action == "prospect.deleted",
                ),
            )
        )
    )
    if removed_at is None:
        return None
    validated_at = session.scalar(
        select(func.max(AuditLogEntry.occurred_at)).where(
            AuditLogEntry.entity_type == "warehouse_draft",
            AuditLogEntry.entity_id == draft.id,
            AuditLogEntry.action == "warehouse_draft.validated",
        )
    )
    if validated_at is None or removed_at > validated_at:
        return RECIPIENT_CHANGED
    return None
