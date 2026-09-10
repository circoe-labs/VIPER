"""Entry point of the import engine: `build_preview(file, reference, mapping)` → `ImportPreview`.

Pure and deterministic: no database, clock, randomness or I/O besides the given bytes; the same
input always yields the same JSON. Reference data comes in as a snapshot
(`reference_loader.load_reference_data` builds it from the database for Task 09).
"""

from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass

from app.services.imports.dedup import annotate_duplicates
from app.services.imports.diagnostics import (
    Diagnostic,
    DiagnosticCode,
    ImportRejectedError,
    Severity,
)
from app.services.imports.fields import CORRECTABLE_FIELDS, SPECS, ImportField
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


# Source row number → field → the text the user typed instead of the cell (None clears it).
type ImportCorrections = Mapping[int, Mapping[ImportField, str | None]]


def build_preview(
    file: ImportFile,
    reference: ImportReferenceData = EMPTY_REFERENCE,
    mapping: ImportMapping | None = None,
    corrections: ImportCorrections | None = None,
    *,
    limits: ImportLimits = DEFAULT_LIMITS,
) -> ImportPreview:
    """Parse, map, normalize and check `file` without side effects.

    `corrections` replace single cells before any rule runs (the originals stay in legacy
    metadata), so a corrected row is normalized, matched and checked for duplicates exactly like
    a source row.

    Raises `ImportRejectedError` when the file cannot be read at all (format, size, encryption,
    corruption, limits), when `mapping` names an unknown sheet/column or maps a field twice, or
    when `corrections` name a row outside the sheet's data or a field that cannot be corrected.
    """
    workbook = read_workbook(file.filename, file.content, limits)
    layout = resolve_layout(workbook, mapping)
    corrections = corrections or {}
    drafts = []
    if layout.sheet is not None and layout.header is not None:
        header_number = layout.header.number
        data = [row for row in layout.sheet.rows if row.number > header_number]
        check_corrections(corrections, {row.number for row in data}, layout)
        drafts = [
            RowBuilder(row, layout.columns, reference, corrections.get(row.number)).build()
            for row in data
        ]
    else:
        check_corrections(corrections, set(), layout)
    email_groups = annotate_duplicates(drafts, reference)
    rows = [draft.finish() for draft in drafts]
    return ImportPreview(summary=summarize(workbook, layout, rows, email_groups), rows=rows)


def check_corrections(corrections: ImportCorrections, rows: set[int], layout: Layout) -> None:
    mapped = {column.field for column in layout.columns if column.field is not None}
    for number in sorted(corrections):
        if number not in rows:
            raise ImportRejectedError(DiagnosticCode.MAPPING_UNKNOWN_ROW, row=number)
        for field in sorted(corrections[number]):
            if field not in CORRECTABLE_FIELDS or field not in mapped:
                raise ImportRejectedError(
                    DiagnosticCode.MAPPING_UNCORRECTABLE_FIELD, row=number, label=SPECS[field].label
                )


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
