"""Excel import batches and per-row legacy metadata. Raw workbook bytes are never stored."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.actor import ActorType
from app.db.base import Base
from app.models.common import TimestampMixin, UUIDPrimaryKeyMixin, text_enum
from app.models.enums import ImportBatchStatus


class ImportBatch(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "import_batches"
    __table_args__ = (
        CheckConstraint("file_fingerprint ~ '^[0-9a-f]{64}$'", name="file_fingerprint_sha256"),
        CheckConstraint(
            "rows_total >= 0 AND rows_imported >= 0 AND rows_skipped >= 0", name="row_counts"
        ),
        CheckConstraint(
            "(status = 'committed') = (committed_at IS NOT NULL)", name="committed_at_consistency"
        ),
    )

    filename: Mapped[str] = mapped_column(String(255))
    sheet_names: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=text("'{}'"))
    # Optional SHA-256 (hex) of the uploaded file, to recognise a re-import of the same file.
    file_fingerprint: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[ImportBatchStatus] = mapped_column(
        text_enum(ImportBatchStatus, "status"), server_default=ImportBatchStatus.PENDING.value
    )
    rows_total: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    rows_imported: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    rows_skipped: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    committed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    actor_type: Mapped[ActorType] = mapped_column(text_enum(ActorType, "actor_type"))
    actor_id: Mapped[str | None] = mapped_column(String(128))
    actor_display: Mapped[str] = mapped_column(String(255))


class ImportRowMetadata(UUIDPrimaryKeyMixin, Base):
    """One imported source row: its location, resulting entities and opaque legacy values."""

    __tablename__ = "import_row_metadata"
    __table_args__ = (
        CheckConstraint("source_row_number > 0", name="source_row_number_positive"),
        Index(
            "uq_import_row_metadata_batch_sheet_row",
            "import_batch_id",
            "source_sheet",
            "source_row_number",
            unique=True,
        ),
    )

    import_batch_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("import_batches.id", ondelete="CASCADE")
    )
    source_sheet: Mapped[str] = mapped_column(String(255))
    source_row_number: Mapped[int] = mapped_column(Integer)
    # Legacy values may be personal data: they go when the prospect is deleted.
    prospect_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("prospects.id", ondelete="CASCADE"), index=True
    )
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("companies.id", ondelete="SET NULL"), index=True
    )
    # Unknown or intentionally opaque legacy columns, keyed by source header (no silent loss).
    legacy_metadata: Mapped[dict[str, Any]] = mapped_column(
        JSONB, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
