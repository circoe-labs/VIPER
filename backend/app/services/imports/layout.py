"""Sheet recognition and column mapping, with the user's overrides (Task 09 remapping).

The prospect sheet is the one whose header row (within its first rows) names the most known
fields, including at least one identity field; every other sheet gets an explicit skip notice.
Headers are compared folded (case, accents, punctuation, spaces). A repeated header takes its
field's `repeat` target by position (second `A contacter` → legacy flag); any other repeat, unknown
or unnamed column is kept raw in legacy metadata, with a notice.
"""

from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum

from openpyxl.utils.cell import get_column_letter
from pydantic import BaseModel, ConfigDict, Field

from app.services.imports.diagnostics import (
    Diagnostic,
    DiagnosticCode,
    ImportRejectedError,
    diagnostic,
)
from app.services.imports.fields import FIELD_BY_HEADER, LEGACY_LAYOUT, SPECS, ImportField
from app.services.imports.text import fold, single_line
from app.services.imports.workbook import Sheet, SheetRow, Workbook

HEADER_SCAN_ROWS = 10
MIN_RECOGNIZED_FIELDS = 3
IDENTITY_FIELDS = frozenset(
    {ImportField.COMPANY_NAME, ImportField.LAST_NAME, ImportField.FIRST_NAME, ImportField.EMAIL}
)


class MatchedBy(StrEnum):
    HEADER = "header"  # historical header or accepted alias
    POSITION = "position"  # repeated header disambiguated by its position
    OVERRIDE = "override"  # chosen by the user
    NONE = "none"  # not mapped: values kept raw in legacy metadata


class ColumnMapping(BaseModel):
    model_config = ConfigDict(frozen=True)

    column: str  # letter
    index: int  # 0-based
    header: str | None
    field: ImportField | None
    matched_by: MatchedBy


class ImportMapping(BaseModel):
    """User corrections applied to a new preview: sheet, header row and column → field.

    `columns` maps a column letter to a field, or to `None` to keep that column raw.
    """

    model_config = ConfigDict(frozen=True)

    sheet: str | None = None
    header_row: int | None = None
    columns: dict[str, ImportField | None] = Field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class Layout:
    sheet: Sheet | None  # None when no prospect sheet was found
    header: SheetRow | None
    columns: tuple[ColumnMapping, ...]
    notices: tuple[Diagnostic, ...]


def header_fields(row: SheetRow) -> set[ImportField]:
    return {
        field
        for value in row.values
        if (text := single_line(value)) and (field := FIELD_BY_HEADER.get(fold(text)))
    }


def find_header(sheet: Sheet) -> tuple[int, SheetRow] | None:
    """(score, row) of the best header row among the first rows of `sheet`, if any qualifies."""
    best: tuple[int, SheetRow] | None = None
    for row in sheet.rows[:HEADER_SCAN_ROWS]:
        fields = header_fields(row)
        qualifies = len(fields) >= MIN_RECOGNIZED_FIELDS and fields & IDENTITY_FIELDS
        if qualifies and (best is None or len(fields) > best[0]):
            best = (len(fields), row)
    return best


def choose_sheet(
    workbook: Workbook, mapping: ImportMapping
) -> tuple[Sheet | None, SheetRow | None]:
    if mapping.sheet is not None:
        sheet = next((s for s in workbook.sheets if s.name == mapping.sheet), None)
        if sheet is None:
            raise ImportRejectedError(DiagnosticCode.MAPPING_UNKNOWN_SHEET, sheet=mapping.sheet)
        found = find_header(sheet)
        # A sheet chosen by the user is imported even without a recognisable header row: its
        # first row then serves as headers and columns are mapped by hand.
        return sheet, found[1] if found else (sheet.rows[0] if sheet.rows else None)
    candidates = [
        (found[0], -position, sheet, found[1])
        for position, sheet in enumerate(workbook.sheets)
        if (found := find_header(sheet))
    ]
    if not candidates:
        return None, None
    _, _, sheet, header = max(candidates, key=lambda candidate: candidate[:2])
    return sheet, header


def resolve_layout(workbook: Workbook, mapping: ImportMapping | None = None) -> Layout:
    mapping = mapping or ImportMapping()
    sheet, header = choose_sheet(workbook, mapping)
    if sheet is not None and mapping.header_row is not None:
        header = next((row for row in sheet.rows if row.number == mapping.header_row), None)
        if header is None:
            raise ImportRejectedError(
                DiagnosticCode.MAPPING_INVALID_HEADER_ROW, row=mapping.header_row
            )
    notices = [
        diagnostic(DiagnosticCode.SHEET_SKIPPED, sheet=other.name)
        for other in workbook.sheets
        if other is not sheet
    ]
    if sheet is None or header is None:
        notices.insert(0, diagnostic(DiagnosticCode.SHEET_NOT_FOUND))
        return Layout(None, None, (), tuple(notices))
    if sheet.merged_ranges:
        notices.append(
            diagnostic(
                DiagnosticCode.SHEET_MERGED_CELLS, sheet=sheet.name, count=sheet.merged_ranges
            )
        )
    columns, column_notices = map_columns(header, sheet.width, mapping.columns)
    return Layout(sheet, header, columns, (*notices, *column_notices))


def map_columns(
    header: SheetRow, width: int, overrides: Mapping[str, ImportField | None]
) -> tuple[tuple[ColumnMapping, ...], list[Diagnostic]]:
    taken: set[ImportField] = set()
    duplicates: set[int] = set()
    columns: list[ColumnMapping] = []
    for index in range(width):
        text = single_line(header.value(index))
        field, matched_by = None, MatchedBy.NONE
        if text and (candidate := FIELD_BY_HEADER.get(fold(text))):
            repeat = SPECS[candidate].repeat
            if candidate not in taken:
                field, matched_by = candidate, MatchedBy.HEADER
            elif repeat is not None and repeat not in taken:
                field, matched_by = repeat, MatchedBy.POSITION
            else:
                duplicates.add(index)
        if field is not None:
            taken.add(field)
        columns.append(
            ColumnMapping(
                column=get_column_letter(index + 1),
                index=index,
                header=text,
                field=field,
                matched_by=matched_by,
            )
        )
    columns = apply_overrides(columns, overrides)
    return tuple(columns), column_notices(columns, duplicates)


def apply_overrides(
    columns: list[ColumnMapping], overrides: Mapping[str, ImportField | None]
) -> list[ColumnMapping]:
    letters = {column.column for column in columns}
    for letter in sorted(overrides):
        if letter not in letters:
            raise ImportRejectedError(DiagnosticCode.MAPPING_UNKNOWN_COLUMN, column=letter)
    claimed = [field for field in overrides.values() if field is not None]
    for field in sorted(set(claimed)):
        if claimed.count(field) > 1:
            raise ImportRejectedError(
                DiagnosticCode.MAPPING_DUPLICATE_FIELD, label=SPECS[field].label
            )
    result = []
    for column in columns:
        if column.column in overrides:
            column = column.model_copy(
                update={"field": overrides[column.column], "matched_by": MatchedBy.OVERRIDE}
            )
        elif column.field in claimed:
            column = column.model_copy(update={"field": None, "matched_by": MatchedBy.NONE})
        result.append(column)
    return result


def column_notices(columns: list[ColumnMapping], duplicates: set[int]) -> list[Diagnostic]:
    notices = []
    for column in columns:
        if column.field is not None:
            if SPECS[column.field].opaque:
                notices.append(
                    diagnostic(
                        DiagnosticCode.COLUMN_LEGACY_PRESERVED,
                        column=column.column,
                        field=column.field,
                        header=column.header,
                    )
                )
        elif column.matched_by is MatchedBy.OVERRIDE:
            continue  # kept raw on the user's request
        elif column.header is None:
            notices.append(diagnostic(DiagnosticCode.COLUMN_UNNAMED, column=column.column))
        else:
            code = (
                DiagnosticCode.COLUMN_DUPLICATE_HEADER
                if column.index in duplicates
                else DiagnosticCode.COLUMN_UNMAPPED
            )
            notices.append(diagnostic(code, column=column.column, header=column.header))
    mapped = {column.field for column in columns}
    for spec in LEGACY_LAYOUT:
        if spec.field not in mapped:
            code = DiagnosticCode.COLUMN_MISSING_KEY if spec.key else DiagnosticCode.COLUMN_MISSING
            notices.append(diagnostic(code, field=spec.field, label=spec.label))
    return notices
