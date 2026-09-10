"""Import batch lifecycle and per-row trace, for the Excel import commit (Task 09).

Actor convention (decision I-29):

- the batch row keeps the human who started the import; lifecycle events
  (`import_batch.started|committed|failed|cancelled`) are by the actor passed — the signed-in user;
- rows written by the import itself run inside `importing(session, batch, confirmed_by)`: it binds
  `ActorContext(IMPORT, id=<batch id>, display="Import <filename>")` with the context
  `source=import`, `import_batch_id` and `on_behalf_of=<the human>`, and yields that actor for the
  services called inside.

Row metadata (`import_row_metadata`) is a write-once trace, not audited row by row: the batch
events and the entity events carry the import, and raw legacy values never enter the audit log.
A failed commit rolls back with its transaction; record `failed` in a new one (`get_batch`).
"""

import uuid
from collections.abc import Collection, Iterator, Mapping
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.models.enums import ImportBatchStatus
from app.models.imports import ImportBatch, ImportRowMetadata
from app.repositories import provenance as provenance_repository
from app.services import audit
from app.services.audit import AuditAction, AuditContext, AuditSource
from app.services.audit_changes import to_json
from app.services.errors import DomainError, NotFoundError

FINAL_STATUSES = {
    ImportBatchStatus.COMMITTED: AuditAction.IMPORT_BATCH_COMMITTED,
    ImportBatchStatus.FAILED: AuditAction.IMPORT_BATCH_FAILED,
    ImportBatchStatus.CANCELLED: AuditAction.IMPORT_BATCH_CANCELLED,
}


def import_actor(batch: ImportBatch) -> ActorContext:
    return ActorContext(type=ActorType.IMPORT, id=str(batch.id), display=f"Import {batch.filename}")


@contextmanager
def importing(
    session: Session, batch: ImportBatch, confirmed_by: ActorContext
) -> Iterator[ActorContext]:
    """Attribute the block's writes to the import, on behalf of `confirmed_by`."""
    current = audit.binding(session)
    context = AuditContext(
        source=AuditSource.IMPORT,
        request_id=current[1].request_id if current else None,
        import_batch_id=batch.id,
        on_behalf_of=confirmed_by,
    )
    actor = import_actor(batch)
    with audit.bound(session, actor, context):
        yield actor


def get_batch(session: Session, batch_id: uuid.UUID) -> ImportBatch:
    batch = provenance_repository.get_batch(session, batch_id)
    if batch is None:
        raise NotFoundError(f"Import batch {batch_id} not found.")
    return batch


def start_batch(
    session: Session,
    actor: ActorContext,
    *,
    filename: str,
    sheet_names: Collection[str],
    file_fingerprint: str | None = None,
) -> ImportBatch:
    """Open a `pending` batch for an uploaded file (metadata and optional SHA-256 only)."""
    if not filename.strip():
        raise DomainError("An import batch needs the file name.")
    batch = ImportBatch(
        filename=filename.strip(),
        sheet_names=list(sheet_names),
        file_fingerprint=file_fingerprint,
        status=ImportBatchStatus.PENDING,
        actor_type=actor.type,
        actor_id=actor.id,
        actor_display=actor.display,
    )
    audit.annotate(session, actor, batch, AuditAction.IMPORT_BATCH_STARTED)
    session.add(batch)
    session.flush()
    return batch


def record_row(
    session: Session,
    batch: ImportBatch,
    *,
    sheet: str,
    row_number: int,
    legacy_metadata: Mapping[str, Any],
    prospect_id: uuid.UUID | None = None,
    company_id: uuid.UUID | None = None,
) -> ImportRowMetadata:
    """Keep where a row came from, what it produced and its unmapped legacy values (JSON-safe)."""
    row = ImportRowMetadata(
        import_batch_id=batch.id,
        source_sheet=sheet,
        source_row_number=row_number,
        prospect_id=prospect_id,
        company_id=company_id,
        legacy_metadata=to_json(legacy_metadata),
    )
    session.add(row)
    session.flush()
    return row


def finish_batch(
    session: Session,
    actor: ActorContext,
    batch: ImportBatch,
    status: ImportBatchStatus,
    *,
    rows_total: int,
    rows_imported: int,
    rows_skipped: int,
) -> ImportBatch:
    """Close a pending batch as committed, failed or cancelled, with its row counts."""
    if status not in FINAL_STATUSES:
        raise DomainError(f"An import batch cannot finish as {status}.")
    if batch.status is not ImportBatchStatus.PENDING:
        raise DomainError(f"Import batch {batch.id} is already {batch.status}.")
    audit.annotate(session, actor, batch, FINAL_STATUSES[status])
    batch.status = status
    batch.rows_total = rows_total
    batch.rows_imported = rows_imported
    batch.rows_skipped = rows_skipped
    batch.committed_at = datetime.now(UTC) if status is ImportBatchStatus.COMMITTED else None
    session.flush()
    return batch
