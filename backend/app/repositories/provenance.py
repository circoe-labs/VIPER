"""Provenance and import-batch persistence."""

import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.models.enums import ImportBatchStatus
from app.models.imports import ImportBatch, ImportRowMetadata
from app.models.prospects import ProspectSource


def list_sources(session: Session, prospect_id: uuid.UUID) -> list[ProspectSource]:
    """Oldest first: the original source, then later confirmations/enrichments."""
    return list(
        session.scalars(
            select(ProspectSource)
            .where(ProspectSource.prospect_id == prospect_id)
            .order_by(ProspectSource.collected_at, ProspectSource.id)
        )
    )


def get_batch(session: Session, batch_id: uuid.UUID) -> ImportBatch | None:
    return session.get(ImportBatch, batch_id)


def list_batches(session: Session, *, limit: int) -> list[ImportBatch]:
    return list(
        session.scalars(
            select(ImportBatch)
            .order_by(ImportBatch.created_at.desc(), ImportBatch.id.desc())
            .limit(limit)
        )
    )


def committed_batches(session: Session, fingerprint: str) -> list[ImportBatch]:
    return list(
        session.scalars(
            select(ImportBatch)
            .where(
                ImportBatch.file_fingerprint == fingerprint,
                ImportBatch.status == ImportBatchStatus.COMMITTED,
            )
            .order_by(ImportBatch.committed_at.desc(), ImportBatch.id.desc())
        )
    )


def batch_row_counts(session: Session, batch_id: uuid.UUID) -> tuple[int, int, int]:
    """(row metadata rows, distinct prospects, distinct companies) recorded by a batch."""
    rows, prospects, companies = session.execute(
        select(
            func.count(),
            func.count(ImportRowMetadata.prospect_id.distinct()),
            func.count(ImportRowMetadata.company_id.distinct()),
        ).where(ImportRowMetadata.import_batch_id == batch_id)
    ).one()
    return rows, prospects, companies
