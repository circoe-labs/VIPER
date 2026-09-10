"""Provenance and import-batch persistence."""

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.imports import ImportBatch
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
