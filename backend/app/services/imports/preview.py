"""Entry point of the import engine: `build_preview(file, reference, mapping)` → `ImportPreview`.

Pure and deterministic: no database, clock, randomness or I/O besides the given bytes; the same
input always yields the same JSON. Reference data comes in as a snapshot
(`reference_loader.load_reference_data` builds it from the database for Task 09).
"""

from collections import Counter
from dataclasses import dataclass

from app.services.imports.dedup import annotate_duplicates
from app.services.imports.diagnostics import Diagnostic, Severity
from app.services.imports.layout import ImportMapping, Layout, resolve_layout
from app.services.imports.models import (
    ImportPreview,
    ImportSummary,
    PreviewRow,
    RowStatus,
    SheetStatus,
    SheetSummary,
)
from app.services.imports.reference import EMPTY_REFERENCE, ImportReferenceData
from app.services.imports.rows import RowBuilder
from app.services.imports.workbook import ImportLimits, Workbook, read_workbook

DEFAULT_LIMITS = ImportLimits()


@dataclass(frozen=True, slots=True)
class ImportFile:
    filename: str
    content: bytes


def build_preview(
    file: ImportFile,
    reference: ImportReferenceData = EMPTY_REFERENCE,
    mapping: ImportMapping | None = None,
    *,
    limits: ImportLimits = DEFAULT_LIMITS,
) -> ImportPreview:
    """Parse, map, normalize and check `file` without side effects.

    Raises `ImportRejectedError` when the file cannot be read at all (format, size, encryption,
    corruption, limits) or when `mapping` names an unknown sheet/column or maps a field twice.
    """
    workbook = read_workbook(file.filename, file.content, limits)
    layout = resolve_layout(workbook, mapping)
    drafts = []
    if layout.sheet is not None and layout.header is not None:
        header_number = layout.header.number
        drafts = [
            RowBuilder(row, layout.columns, reference).build()
            for row in layout.sheet.rows
            if row.number > header_number
        ]
    email_groups = annotate_duplicates(drafts, reference)
    rows = [draft.finish() for draft in drafts]
    return ImportPreview(summary=summarize(workbook, layout, rows, email_groups), rows=rows)


def summarize(
    workbook: Workbook, layout: Layout, rows: list[PreviewRow], email_groups: int
) -> ImportSummary:
    notices: list[Diagnostic] = [*workbook.notices, *layout.notices]
    everything = [*notices, *(item for row in rows for item in row.diagnostics)]
    codes = Counter(item.code.value for item in everything)
    severities = Counter(item.severity for item in everything)
    statuses = Counter(row.status for row in rows)
    rows_empty = 0
    if rows and layout.header is not None:
        rows_empty = rows[-1].row_number - layout.header.number - len(rows)
    return ImportSummary(
        file_name=workbook.filename,
        file_format=workbook.format,
        file_fingerprint=workbook.fingerprint,
        encoding=workbook.encoding,
        delimiter=workbook.delimiter,
        sheet=layout.sheet.name if layout.sheet else None,
        header_row=layout.header.number if layout.header else None,
        sheets=[
            SheetSummary(
                name=sheet.name,
                status=SheetStatus.IMPORTED if sheet is layout.sheet else SheetStatus.SKIPPED,
                rows=len(sheet.rows),
                merged_ranges=sheet.merged_ranges,
            )
            for sheet in workbook.sheets
        ],
        columns=list(layout.columns),
        rows_total=len(rows),
        rows_empty=rows_empty,
        rows_by_status={status.value: statuses[status] for status in RowStatus},
        counts_by_severity={severity.value: severities[severity] for severity in Severity},
        counts_by_code=dict(sorted(codes.items())),
        duplicate_email_groups=email_groups,
        notices=notices,
    )
