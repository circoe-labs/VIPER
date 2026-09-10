"""Read-only SQL console (Task 13, ADR-0011): run one read statement as the reader role.

The security boundary is the database, not this module: queries run on their own engine, logged in
as the reader role (`sql_reader.py`: SELECT on the exposed columns only, read-only by default,
statement timeout). On top of it, each query runs:

- in a `READ ONLY` transaction with its own `statement_timeout`, always rolled back;
- as a prepared statement — the extended protocol refuses several commands in one query;
- through a server-side cursor (`DECLARE … CURSOR`), so at most `max_rows + 1` rows ever leave the
  server, however large the result; `EXPLAIN` (not declarable, small output) runs directly;
- on a connection closed afterwards (NullPool): nothing set by a query (settings, advisory locks)
  survives it.

`check_statement` only gives early, readable refusals (empty input, several statements, a
statement that is not a read); nothing relies on it.
"""

import json
import math
import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, time
from time import perf_counter
from typing import Any

import psycopg
import sqlalchemy as sa
from psycopg import sql
from sqlalchemy.pool import NullPool

from app.services.errors import DomainError

MAX_QUERY_LENGTH = 20_000
# Longer cell values are cut in the result (flagged).
MAX_CELL_CHARS = 500
READ_STATEMENTS = frozenset({"select", "with", "values", "table", "explain"})
CURSOR = "viper_console"
DECLARE = f"DECLARE {CURSOR} NO SCROLL CURSOR FOR "
# Integers beyond this lose precision as JSON numbers in the browser: sent as text.
SAFE_INTEGER = 2**53 - 1
CONNECT_TIMEOUT_SECONDS = 5


class SqlConsoleError(DomainError):
    """A refused or failed query: `code` for the client, a French `message`, the database's
    own `detail` and the 1-based character `position` in the query when known."""

    def __init__(
        self, code: str, message: str, *, detail: str | None = None, position: int | None = None
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail
        self.position = position


@dataclass(frozen=True, slots=True)
class SqlColumn:
    name: str
    type: str


@dataclass(frozen=True, slots=True)
class SqlResult:
    columns: list[SqlColumn]
    rows: list[list[Any]]
    # (row, column) of each cell cut at MAX_CELL_CHARS.
    truncated_cells: list[tuple[int, int]]
    # More rows than `max_rows` exist; only the first `max_rows` are returned.
    truncated: bool
    duration_ms: int


def create_reader_engine(url: str) -> sa.Engine:
    """Engine logged in as the reader role; one fresh connection per query (no pooled state)."""
    return sa.create_engine(
        url,
        poolclass=NullPool,
        connect_args={"connect_timeout": CONNECT_TIMEOUT_SECONDS, "application_name": "viper-sql"},
    )


# --- early checks (readability, not security) ------------------------------------------------

_DOLLAR_TAG = re.compile(r"\$([A-Za-z_][A-Za-z0-9_]*)?\$")
_WORD = re.compile(r"[A-Za-z]+")


def _skip(text: str, start: int) -> int:
    """Index after the comment or quoted token starting at `start`, or `start` if there is none."""
    if text.startswith("--", start):
        end = text.find("\n", start)
        return len(text) if end < 0 else end + 1
    if text.startswith("/*", start):
        depth, index = 0, start
        while index < len(text):
            if text.startswith("/*", index):
                depth, index = depth + 1, index + 2
            elif text.startswith("*/", index):
                depth, index = depth - 1, index + 2
                if depth == 0:
                    return index
            else:
                index += 1
        return len(text)
    quote = text[start]
    if quote in "'\"":
        escapes = quote == "'" and start > 0 and text[start - 1] in "eE"
        index = start + 1
        while index < len(text):
            if escapes and text[index] == "\\":
                index += 2
            elif text[index] == quote:
                if not text.startswith(quote * 2, index):
                    return index + 1
                index += 2
            else:
                index += 1
        return len(text)
    if quote == "$" and (tag := _DOLLAR_TAG.match(text, start)):
        end = text.find(tag.group(0), tag.end())
        return len(text) if end < 0 else end + len(tag.group(0))
    return start


def _statements(text: str) -> list[str]:
    """`text` split on top-level semicolons (outside strings, identifiers and comments)."""
    parts, begin, index = [], 0, 0
    while index < len(text):
        after = _skip(text, index)
        if after != index:
            index = after
        elif text[index] == ";":
            parts.append(text[begin:index])
            begin = index = index + 1
        else:
            index += 1
    parts.append(text[begin:])
    return parts


def _first_word(text: str) -> str:
    index = 0
    while index < len(text):
        after = _skip(text, index)
        if after != index:
            index = after
        elif text[index].isspace() or text[index] == "(":
            index += 1
        else:
            word = _WORD.match(text, index)
            return word.group(0).lower() if word else text[index]
    return ""


def _is_blank(text: str) -> bool:
    return _first_word(text) == ""


def check_statement(text: str) -> str:
    """The single read statement of `text`, trailing semicolon removed, else `SqlConsoleError`."""
    if len(text) > MAX_QUERY_LENGTH:
        raise SqlConsoleError("too_long", f"Requête limitée à {MAX_QUERY_LENGTH} caractères.")
    first, *rest = _statements(text)
    if _is_blank(first):
        raise SqlConsoleError("empty", "Saisissez une requête SQL.")
    if any(not _is_blank(part) for part in rest):
        raise SqlConsoleError(
            "multiple", "Une seule instruction à la fois : retirez le « ; » et ce qui le suit."
        )
    if _first_word(first) not in READ_STATEMENTS:
        raise SqlConsoleError(
            "not_read",
            "La console est en lecture seule : SELECT, WITH, VALUES, TABLE ou EXPLAIN uniquement.",
        )
    return first.rstrip()


# --- execution ---------------------------------------------------------------------------------


def run_query(engine: sa.Engine, text: str, *, max_rows: int, timeout_ms: int) -> SqlResult:
    """Run one read statement as the reader role; `SqlConsoleError` on any refusal or failure."""
    started = perf_counter()
    direct = _first_word(text) == "explain"
    try:
        with engine.connect() as connection:
            raw = connection.connection.driver_connection
            assert isinstance(raw, psycopg.Connection)
            try:
                columns, rows = _fetch(
                    raw, text, direct=direct, max_rows=max_rows, timeout_ms=timeout_ms
                )
            finally:
                raw.rollback()
    except sa.exc.OperationalError as error:
        raise SqlConsoleError(
            "unavailable",
            "Console SQL indisponible : le rôle de lecture n’est pas configuré ou la base ne répond"
            " pas (python -m app.cli provision-sql-reader).",
        ) from error
    except psycopg.Error as error:
        raise _failure(
            error, offset=0 if direct else len(DECLARE), timeout_ms=timeout_ms
        ) from error
    cells, truncated_cells = _cells(rows[:max_rows])
    return SqlResult(
        columns=columns,
        rows=cells,
        truncated_cells=truncated_cells,
        truncated=len(rows) > max_rows,
        duration_ms=round((perf_counter() - started) * 1000),
    )


def _fetch(
    raw: psycopg.Connection[Any], text: str, *, direct: bool, max_rows: int, timeout_ms: int
) -> tuple[list[SqlColumn], Sequence[tuple[Any, ...]]]:
    with raw.cursor() as cursor:
        cursor.execute("SET TRANSACTION READ ONLY")
        cursor.execute("SELECT set_config('statement_timeout', %s, true)", (f"{timeout_ms}ms",))
        if direct:
            cursor.execute(sql.SQL(text), prepare=True)
        else:
            cursor.execute(sql.SQL(DECLARE) + sql.SQL(text), prepare=True)
            cursor.execute(f"FETCH FORWARD {max_rows + 1} FROM {CURSOR}")
        if cursor.description is None:
            return [], []
        columns = [SqlColumn(column.name, column.type_display) for column in cursor.description]
        return columns, cursor.fetchmany(max_rows + 1)


def _cells(rows: Sequence[tuple[Any, ...]]) -> tuple[list[list[Any]], list[tuple[int, int]]]:
    cells: list[list[Any]] = []
    truncated: list[tuple[int, int]] = []
    for row_index, row in enumerate(rows):
        values = []
        for column_index, value in enumerate(row):
            cell = _json_value(value)
            if isinstance(cell, str) and len(cell) > MAX_CELL_CHARS:
                cell = cell[:MAX_CELL_CHARS]
                truncated.append((row_index, column_index))
            values.append(cell)
        cells.append(values)
    return cells, truncated


def _json_value(value: Any) -> Any:
    match value:
        case None | bool():
            return value
        case int():
            return value if abs(value) <= SAFE_INTEGER else str(value)
        case float():
            return value if math.isfinite(value) else str(value)
        case datetime() | date() | time():
            return value.isoformat()
        case bytes() | memoryview():
            return "\\x" + bytes(value).hex()
        case dict() | list():
            return json.dumps(value, ensure_ascii=False, default=str)
    return str(value)


# SQLSTATE (or class) → (code, French message).
_FAILURES: dict[str, tuple[str, str]] = {
    "42601": ("syntax", "Erreur de syntaxe."),
    "42501": (
        "forbidden",
        "Accès refusé : fonction ou opération réservée à l’administration de la base.",
    ),
    "25006": ("read_only", "Écriture refusée : la console est en lecture seule."),
    "0A000": ("unsupported", "Instruction non prise en charge par la console (lecture seule)."),
    "42P01": ("unknown_object", "Table inconnue."),
    "42703": ("unknown_object", "Colonne inconnue."),
    "42883": ("unknown_object", "Fonction inconnue ou arguments incompatibles."),
    "55P03": ("timeout", "Verrou indisponible : la requête attendait une ressource occupée."),
    "22": ("invalid", "Valeur invalide dans la requête (conversion, division par zéro…)."),
    "53": ("resources", "Ressources insuffisantes pour cette requête : réduisez-la."),
}


_REJECTED = ("rejected", "La base a refusé la requête.")


def _failure(error: psycopg.Error, *, offset: int, timeout_ms: int) -> SqlConsoleError:
    diag = error.diag
    state = error.sqlstate or ""
    detail = diag.message_primary or str(error).splitlines()[0]
    # Positions count from the start of the query as typed (not of the DECLARE wrapping it).
    raw_position = int(diag.statement_position) - offset if diag.statement_position else 0
    position = raw_position if raw_position > 0 else None
    if state == "57014":
        message = f"Requête interrompue : elle a dépassé {timeout_ms / 1000:g} s."
        return SqlConsoleError("timeout", message, detail=detail)
    code, message = _FAILURES.get(state) or _FAILURES.get(state[:2]) or _REJECTED
    if code == "forbidden" and "for table" in detail:
        message = (
            "Table non accessible : la console ne lit que les tables exposées de l’explorateur."
        )
    elif code == "syntax" and position is not None:
        message = f"Erreur de syntaxe à la position {position}."
    return SqlConsoleError(code, message, detail=detail, position=position)
