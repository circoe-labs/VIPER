"""ProvenanceService: where a prospect's data came from (`prospect_sources`).

Provenance is not audit. A source record states the origin (`manual`, `excel_import`…), when VIPER
obtained the data (`collected_at`), the legal basis or collection context and who recorded it; the
audit log states who changed what. A prospect may have several sources over time. Creating one is
itself a row change and is audited like any other (`prospect_source.created`).
"""

import uuid
from datetime import datetime

from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.enums import ProspectSourceType
from app.models.imports import ImportBatch
from app.models.prospects import ProspectSource
from app.repositories import provenance as provenance_repository
from app.services import audit
from app.services.errors import DomainError
from app.services.prospects import get_prospect


def _clean(text: str | None) -> str | None:
    return (text or "").strip() or None


def add_source(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    source_type: ProspectSourceType,
    *,
    source_reference: str | None = None,
    collected_at: datetime | None = None,
    legal_basis_or_collection_context: str | None = None,
    notes: str | None = None,
    import_batch_id: uuid.UUID | None = None,
) -> ProspectSource:
    """Record a source; `collected_at` defaults to now (the database transaction time)."""
    get_prospect(session, prospect_id)
    if (source_type is ProspectSourceType.EXCEL_IMPORT) != (import_batch_id is not None):
        raise DomainError("An import source needs its import batch, and only an import source.")
    if collected_at is not None and collected_at.tzinfo is None:
        raise DomainError("The collection date must carry a time zone.")
    source = ProspectSource(
        prospect_id=prospect_id,
        source_type=source_type,
        source_reference=_clean(source_reference),
        import_batch_id=import_batch_id,
        legal_basis_or_collection_context=_clean(legal_basis_or_collection_context),
        notes=_clean(notes),
        actor_type=actor.type,
        actor_id=actor.id,
        actor_display=actor.display,
    )
    if collected_at is not None:
        source.collected_at = collected_at
    audit.annotate(session, actor, source)
    session.add(source)
    session.flush()
    return source


def add_manual_source(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    *,
    legal_basis_or_collection_context: str | None = None,
    source_reference: str | None = None,
    notes: str | None = None,
) -> ProspectSource:
    """Provenance of a prospect entered by hand: `manual`, collected now, by `actor`."""
    return add_source(
        session,
        actor,
        prospect_id,
        ProspectSourceType.MANUAL,
        source_reference=source_reference,
        legal_basis_or_collection_context=legal_basis_or_collection_context,
        notes=notes,
    )


def import_row_reference(filename: str, sheet: str, row_number: int) -> str:
    return f"{filename} / {sheet} / ligne {row_number}"


def add_import_source(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    batch: ImportBatch,
    *,
    sheet: str,
    row_number: int,
    legal_basis_or_collection_context: str | None = None,
) -> ProspectSource:
    """Provenance of a prospect created or matched by an import row: the batch plus a readable
    `file / sheet / ligne n` reference; collected at import time (the true original collection
    date of legacy rows is unknown, decision I-15)."""
    return add_source(
        session,
        actor,
        prospect_id,
        ProspectSourceType.EXCEL_IMPORT,
        source_reference=import_row_reference(batch.filename, sheet, row_number),
        legal_basis_or_collection_context=legal_basis_or_collection_context,
        import_batch_id=batch.id,
    )


def list_sources(session: Session, prospect_id: uuid.UUID) -> list[ProspectSource]:
    """The prospect's sources, oldest first."""
    return provenance_repository.list_sources(session, prospect_id)
