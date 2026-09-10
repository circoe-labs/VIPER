"""Explorer read operations used by the HTTP routes: tables, metadata, row pages, records, CSV.

Read-only by construction: nothing here adds, flushes or deletes ORM objects.
"""

import csv
import io
import json
import re
from collections.abc import Iterator, Mapping
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from sqlalchemy import RowMapping
from sqlalchemy.orm import Session

from app.db.base import Base
from app.services.errors import NotFoundError
from app.services.explorer import statements
from app.services.explorer.metadata import TableInfo, exposed_table_names
from app.services.explorer.policy import ExposurePolicy
from app.services.explorer.query import ReadQuery

# Longer text/JSON values are cut in row pages (flagged); `read_record` returns them in full.
LIST_VALUE_MAX_CHARS = 240
CSV_DELIMITER = ";"  # French-locale Excel splits on semicolons
CSV_ROWS_PER_CHUNK = 500
BOM = "\ufeff"  # lets Excel detect UTF-8
# Cells Excel would evaluate as a formula (CSV injection). A signed plain number stays untouched.
_FORMULA_PREFIXES = ("=", "+", "-", "@", "\t", "\r")
_SIGNED_NUMBER = re.compile(r"[+-][0-9][0-9 .,]*")


@dataclass(frozen=True, slots=True)
class TableSummary:
    name: str
    row_count: int


@dataclass(frozen=True, slots=True)
class Row:
    values: dict[str, Any]
    truncated: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class RowPage:
    total: int
    offset: int
    limit: int
    rows: list[Row]


def list_tables(session: Session, policy: ExposurePolicy) -> list[TableSummary]:
    tables = [Base.metadata.tables[name] for name in exposed_table_names(policy)]
    counts = statements.count_rows(session, tables)
    return [TableSummary(name=table.name, row_count=counts[table.name]) for table in tables]


def count_table_rows(session: Session, table: TableInfo) -> int:
    return statements.count_rows(session, [table.table])[table.name]


def read_page(session: Session, query: ReadQuery, *, offset: int, limit: int) -> RowPage:
    rows = [
        _list_row(row) for row in statements.select_page(session, query, offset=offset, limit=limit)
    ]
    total = statements.count_matching(session, query)
    return RowPage(total=total, offset=offset, limit=limit, rows=rows)


def read_record(session: Session, table: TableInfo, key: Mapping[str, object]) -> dict[str, Any]:
    """One full row (no truncation) by primary key."""
    row = statements.select_record(session, table, key)
    if row is None:
        raise NotFoundError(f"No {table.name} row matches this key.")
    return dict(row)


def export_csv(session: Session, query: ReadQuery) -> Iterator[str]:
    """The filtered, sorted rows as CSV chunks: UTF-8 BOM, `;` separator, CRLF line endings.

    Hidden columns are absent, masked columns are exported empty.
    """
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=CSV_DELIMITER, lineterminator="\r\n")
    names = [column.name for column in query.table.columns]
    writer.writerow(names)
    yield BOM + _drain(buffer)
    for index, row in enumerate(statements.iter_rows(session, query), start=1):
        writer.writerow([_csv_cell(row[name]) for name in names])
        if index % CSV_ROWS_PER_CHUNK == 0:
            yield _drain(buffer)
    if tail := _drain(buffer):
        yield tail


def _list_row(row: RowMapping) -> Row:
    values: dict[str, Any] = {}
    truncated: list[str] = []
    for name, value in row.items():
        text = value if isinstance(value, str) else None
        if isinstance(value, dict | list):
            text = json.dumps(value, ensure_ascii=False, default=str)
        if text is not None and len(text) > LIST_VALUE_MAX_CHARS:
            values[name] = text[:LIST_VALUE_MAX_CHARS]
            truncated.append(name)
        else:
            values[name] = value
    return Row(values=values, truncated=tuple(truncated))


def _drain(buffer: io.StringIO) -> str:
    text = buffer.getvalue()
    buffer.seek(0)
    buffer.truncate()
    return text


def _csv_cell(value: object) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, dict | list):
        return json.dumps(value, ensure_ascii=False, default=str)
    if isinstance(value, str):
        return _neutralize(value)
    return str(value)


def _neutralize(text: str) -> str:
    if text.startswith(_FORMULA_PREFIXES) and not _SIGNED_NUMBER.fullmatch(text):
        return "'" + text
    return text
