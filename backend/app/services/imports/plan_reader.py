"""Applies an `ImportPlanSpec` to a workbook: which cells make which row. Pure."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace

from openpyxl.utils.cell import column_index_from_string, get_column_letter

from app.services.imports.fields import SPECS, ImportField
from app.services.imports.layout import ColumnMapping, MatchedBy
from app.services.imports.plan import ImportPlanSpec, PlanBlock, PlanName
from app.services.imports.text import fold, is_blank, single_line
from app.services.imports.workbook import Sheet, SheetRow, Workbook

# Values shared by everyone of a company: copied down to the rows of the same company block.
COMPANY_LEVEL = frozenset(
    {
        ImportField.COMPANY_NAME,
        ImportField.LEGAL_NAME,
        ImportField.SITE_NAME,
        ImportField.SIRET,
        ImportField.CITY,
        ImportField.POSTAL_CODE,
        ImportField.ADDRESS,
        ImportField.COMPANY_SIZE,
        ImportField.WEBSITE,
        ImportField.CATEGORY,
    }
)
# A row filling one of these starts a new company: nothing of the previous one is copied into it.
COMPANY_IDENTITY = frozenset(
    {
        ImportField.COMPANY_NAME,
        ImportField.LEGAL_NAME,
        ImportField.SITE_NAME,
        ImportField.SIRET,
    }
)


@dataclass(frozen=True, slots=True)
class PlannedRow:
    number: int  # unique across the sheets: the key of corrections and decisions
    sheet: str
    source_row: int
    row: SheetRow
    columns: tuple[ColumnMapping, ...]


@dataclass(frozen=True, slots=True)
class PlannedSheet:
    sheet: Sheet
    used_rows: int
    ignored_rows: tuple[int, ...]  # non-empty rows no block reads (headers excluded)


def split_full_name(text: str) -> tuple[str, str]:
    """(first, last): the all-capitals words are the last name (`Alice SAINT-JORE`); else the
    first word is the first name (`Remi Chevassus`). A single word is a last name."""
    words = text.split()
    if len(words) < 2:
        return "", text.strip()
    capitals = [w for w in words if len(w.strip(".-'")) > 1 and w.isupper()]
    others = [w for w in words if w not in capitals]
    if capitals and others:
        return " ".join(others), " ".join(capitals)
    return words[0], " ".join(words[1:])


def name_parts(text: str, override: PlanName | None) -> tuple[str, str]:
    """The agent's split when it uses exactly the words of the cell, else the rule above."""
    if override is not None:
        wanted = sorted(fold(text).split())
        given = sorted(fold(f"{override.first_name} {override.last_name}").split())
        if wanted == given:
            return override.first_name.strip(), override.last_name.strip()
    return split_full_name(text)


def block_columns(sheet: Sheet, block: PlanBlock) -> tuple[ColumnMapping, ...]:
    """Every column of the sheet, mapped as the block says (a field once; unmapped stay raw)."""
    header = next((r for r in sheet.rows if r.number == block.header_row), None)
    wanted: dict[int, ImportField] = {}
    taken: set[ImportField] = set()
    for item in block.columns:
        index = column_index_from_string(item.column) - 1
        if index < sheet.width and item.field not in taken and index not in wanted:
            wanted[index] = item.field
            taken.add(item.field)
    return tuple(
        ColumnMapping(
            column=get_column_letter(index + 1),
            index=index,
            header=single_line(header.value(index)) if header else None,
            field=wanted.get(index),
            matched_by=MatchedBy.AGENT if index in wanted else MatchedBy.NONE,
        )
        for index in range(sheet.width)
    )


def has_data(row: SheetRow, columns: Sequence[ColumnMapping]) -> bool:
    return any(c.field is not None and not is_blank(row.value(c.index)) for c in columns)


def carried(
    row: SheetRow,
    columns: Sequence[ColumnMapping],
    extra: frozenset[str],
    previous: Mapping[ImportField, object],
) -> SheetRow:
    """`row` completed with the company values of the company it belongs to."""
    values = list(row.values) + [None] * (len(columns) - len(row.values))
    copied = set(row.copied)
    for column in columns:
        field = column.field
        if field is None or not (field in COMPANY_LEVEL or column.column in extra):
            continue
        if is_blank(values[column.index]) and field in previous:
            values[column.index] = previous[field]  # type: ignore[call-overload]
            copied.add(column.index)
    return replace(row, values=tuple(values), copied=frozenset(copied))


def with_full_name(
    row: SheetRow, columns: tuple[ColumnMapping, ...], override: PlanName | None
) -> tuple[SheetRow, tuple[ColumnMapping, ...]]:
    """A `Nom et prénom` column becomes two derived cells (`B·prénom`, `B·nom`) after the sheet's
    columns, so names are normalized, matched and correctable like any other."""
    full = next((c for c in columns if c.field is ImportField.FULL_NAME), None)
    fields = {c.field for c in columns}
    if full is None or fields & {ImportField.FIRST_NAME, ImportField.LAST_NAME}:
        return row, columns
    text = single_line(row.value(full.index))
    first, last = name_parts(text, override) if text else ("", "")
    values = list(row.values) + [None] * (len(columns) - len(row.values))
    derived = []
    for field, suffix, value in (
        (ImportField.FIRST_NAME, "prénom", first),
        (ImportField.LAST_NAME, "nom", last),
    ):
        derived.append(
            ColumnMapping(
                column=f"{full.column}·{suffix}",
                index=len(values),
                header=SPECS[field].label,
                field=field,
                matched_by=MatchedBy.AGENT,
            )
        )
        values.append(value or None)
    return replace(row, values=tuple(values)), (*columns, *derived)


def read_plan(
    workbook: Workbook, plan: ImportPlanSpec
) -> tuple[list[PlannedRow], list[PlannedSheet]]:
    """The data rows the plan designates, in sheet then row order. Blocks naming an unknown
    sheet, overlapping an earlier block or mapping nothing are skipped (their rows are then
    reported as not read)."""
    overrides = {(n.sheet, n.row): n for n in plan.names}
    planned: list[PlannedRow] = []
    sheets: list[PlannedSheet] = []
    offset = 0
    for sheet in workbook.sheets:
        blocks = sorted(
            (b for b in plan.blocks if b.sheet == sheet.name), key=lambda b: b.first_row
        )
        headers = {b.header_row for b in blocks if b.header_row is not None}
        read: set[int] = set()
        used = 0
        for block in blocks:
            columns = block_columns(sheet, block)
            if not any(c.field for c in columns):
                continue
            previous: dict[ImportField, object] = {}
            for row in sheet.rows:
                if not block.first_row <= row.number <= block.last_row:
                    continue
                if row.number in headers or row.number in read:
                    continue
                if not has_data(row, columns):
                    continue
                read.add(row.number)
                starts = any(
                    c.field in COMPANY_IDENTITY
                    and not is_blank(row.value(c.index))
                    and c.index not in row.copied
                    for c in columns
                )
                if starts:
                    previous = {}
                completed = carried(row, columns, frozenset(block.carry_down), previous)
                for column in columns:
                    value = completed.value(column.index)
                    shared = column.field in COMPANY_LEVEL or column.column in block.carry_down
                    if column.field is not None and shared and not is_blank(value):
                        previous[column.field] = value
                number = offset + row.number
                completed, named = with_full_name(
                    completed, columns, overrides.get((sheet.name, row.number))
                )
                planned.append(PlannedRow(number, sheet.name, row.number, completed, named))
                used += 1
        ignored = tuple(r.number for r in sheet.rows if r.number not in read | headers)
        sheets.append(PlannedSheet(sheet, used, ignored))
        offset += max((r.number for r in sheet.rows), default=0)
    return planned, sheets
