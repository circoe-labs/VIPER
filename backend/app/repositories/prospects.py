"""Prospect persistence, including the only write path allowed to clear a do-not-contact status."""

import uuid
from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import func, literal, select, union_all
from sqlalchemy.orm import Session

from app.models import ContactTracking, Email, ImportBatch, ImportRowMetadata, Phone
from app.models.enums import ContactabilityStatus
from app.models.prospects import Prospect, ProspectSource

# Transaction-local setting read by the `guard_do_not_contact` trigger (migration 0002).
CONTACTABILITY_CLEAR_SETTING = "viper.allow_contactability_clear"


def get_prospect(session: Session, prospect_id: uuid.UUID) -> Prospect | None:
    return session.get(Prospect, prospect_id)


def lock_prospect(session: Session, prospect_id: uuid.UUID) -> Prospect | None:
    """The prospect row locked until the end of the transaction (`SELECT … FOR UPDATE`), with
    fresh values: concurrent saves of one prospect run one after the other."""
    return session.get(Prospect, prospect_id, with_for_update=True, populate_existing=True)


def version_rows(
    session: Session, prospect_id: uuid.UUID
) -> Sequence[tuple[str, uuid.UUID, datetime]]:
    """`(kind, id, updated_at)` of the prospect and of every row the editor saves with it (e-mails,
    phones, contact tracking), read from the database without loading the ORM collections."""
    parts = [
        select(literal("prospect"), Prospect.id, Prospect.updated_at).where(
            Prospect.id == prospect_id
        ),
        select(literal("email"), Email.id, Email.updated_at).where(
            Email.prospect_id == prospect_id
        ),
        select(literal("phone"), Phone.id, Phone.updated_at).where(
            Phone.prospect_id == prospect_id
        ),
        select(literal("tracking"), ContactTracking.id, ContactTracking.updated_at).where(
            ContactTracking.prospect_id == prospect_id
        ),
    ]
    return session.execute(union_all(*parts)).tuples().all()


def sources_with_batches(
    session: Session, prospect_id: uuid.UUID
) -> Sequence[tuple[ProspectSource, str | None]]:
    """The prospect's sources, oldest first, with the file name of their import batch."""
    statement = (
        select(ProspectSource, ImportBatch.filename)
        .outerjoin(ImportBatch, ImportBatch.id == ProspectSource.import_batch_id)
        .where(ProspectSource.prospect_id == prospect_id)
        .order_by(ProspectSource.collected_at, ProspectSource.id)
    )
    return session.execute(statement).tuples().all()


def count_import_rows(session: Session, prospect_id: uuid.UUID) -> int:
    """Import-row traces (`import_row_metadata`) that go with the prospect when it is deleted."""
    statement = select(func.count()).where(ImportRowMetadata.prospect_id == prospect_id)
    return session.execute(statement).scalar_one()


def set_contactability_clear_flag(session: Session, enabled: bool) -> None:
    value = "on" if enabled else "off"
    session.execute(select(func.set_config(CONTACTABILITY_CLEAR_SETTING, value, True)))


def write_cleared_contactability(session: Session, prospect: Prospect) -> None:
    """Flush `prospect` back to contactable while the trigger's clearing flag is on.

    The flag is transaction-local and switched off again before returning, so later statements of
    the caller's transaction stay guarded. If the flush fails, the transaction (or savepoint) is
    aborted and its rollback discards the flag; resetting it then would mask the original error.
    """
    set_contactability_clear_flag(session, True)
    try:
        prospect.contactability_status = ContactabilityStatus.CONTACTABLE
        prospect.do_not_contact_at = None
        prospect.do_not_contact_reason = None
        session.flush()
    finally:
        if session.is_active:
            set_contactability_clear_flag(session, False)
