"""Entry point of the import engine: `build_preview(file, reference, mapping)` → `ImportPreview`.

Pure and deterministic: no database, clock, randomness or I/O besides the given bytes; the same
input always yields the same JSON. Reference data comes in as a snapshot
(`reference_loader.load_reference_data` builds it from the database for Task 09).
"""

from collections import Counter
from collections.abc import Mapping
from dataclasses import dataclass, replace
from typing import Any

from app.services.imports.dedup import annotate_duplicates, unify_companies
from app.services.imports.diagnostics import (
    Diagnostic,
    DiagnosticCode,
    ImportRejectedError,
    Severity,
    diagnostic,
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
from app.services.imports.plan import ImportPlanSpec
from app.services.imports.plan_reader import PlannedSheet, read_plan
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
    corrections = corrections or {}
    if mapping is not None and mapping.plan is not None:
        return planned_preview(workbook, mapping.plan, reference, corrections)
    layout = resolve_layout(workbook, mapping)
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
    summary = summarize(workbook, layout, rows, email_groups)
    if mapping is None or not mapping.columns:
        summary = summary.model_copy(update={"agent_recommended": needs_agent(workbook, layout)})
    return ImportPreview(summary=summary, rows=rows)


def needs_agent(workbook: Workbook, layout: Layout) -> bool:
    """No prospect sheet recognised, or a titled column the historical layout does not know."""
    if layout.sheet is None:
        return any(sheet.rows for sheet in workbook.sheets)
    return any(c.field is None and c.header is not None for c in layout.columns)


def planned_preview(
    workbook: Workbook,
    plan: ImportPlanSpec,
    reference: ImportReferenceData,
    corrections: ImportCorrections,
) -> ImportPreview:
    """The preview of every sheet as the import agent's `plan` reads it."""
    planned, sheets = read_plan(workbook, plan)
    check_row_corrections(
        corrections, {row.number: {c.field for c in row.columns if c.field} for row in planned}
    )
    drafts = []
    for item in planned:
        draft = RowBuilder(
            replace(item.row, number=item.number),
            item.columns,
            reference,
            corrections.get(item.number),
        ).build()
        draft.source_sheet, draft.source_row = item.sheet, item.source_row
        drafts.append(draft)
    unify_companies(drafts, [group.names for group in plan.same_companies])
    email_groups = annotate_duplicates(drafts, reference)
    rows = [draft.finish() for draft in drafts]
    notices = tuple(
        diagnostic(DiagnosticCode.SHEET_ROWS_NOT_READ, **not_read(item))
        for item in sheets
        if item.ignored_rows
    )
    used = [item.sheet.name for item in sheets if item.used_rows]
    summary = summarize(workbook, Layout(None, None, (), notices), rows, email_groups)
    summary = summary.model_copy(
        update={
            "sheet": ", ".join(used) or None,
            "sheets": [
                SheetSummary(
                    name=item.sheet.name,
                    status=SheetStatus.IMPORTED if item.used_rows else SheetStatus.SKIPPED,
                    rows=len(item.sheet.rows),
                    merged_ranges=item.sheet.merged_ranges,
                )
                for item in sheets
            ],
            "plan": plan,
        }
    )
    return ImportPreview(summary=summary, rows=rows)


def not_read(item: PlannedSheet) -> dict[str, Any]:
    numbers = [str(n) for n in item.ignored_rows]
    listed = ", ".join(numbers[:15]) + (", …" if len(numbers) > 15 else "")
    return {"sheet": item.sheet.name, "count": len(numbers), "rows": listed}


def check_corrections(corrections: ImportCorrections, rows: set[int], layout: Layout) -> None:
    mapped = {column.field for column in layout.columns if column.field is not None}
    check_row_corrections(corrections, {number: mapped for number in rows})


def check_row_corrections(
    corrections: ImportCorrections, rows: Mapping[int, set[ImportField]]
) -> None:
    """Each corrected row is a data row and each corrected field one that row has a column for."""
    for number in sorted(corrections):
        if number not in rows:
            raise ImportRejectedError(DiagnosticCode.MAPPING_UNKNOWN_ROW, row=number)
        for field in sorted(corrections[number]):
            if field not in CORRECTABLE_FIELDS or field not in rows[number]:
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
