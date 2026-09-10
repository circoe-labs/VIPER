"""Staged change sets of the Database Explorer: request model, value parsing and validation.

A change set targets one table and carries row updates (by primary key, with the row version read
by the client), inserts and deletes. `validate_change_set` checks every change against the table
metadata and its editability policy and parses every value into the column's Python type; errors
are collected per change (and per column), never raised on the first one, so the grid can show them
all. `writes.py` applies a validated change set.
"""

import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any

import sqlalchemy as sa
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, TypeAdapter
from pydantic import ValidationError as PydanticValidationError

from app.services.errors import DomainError, InvalidInputError
from app.services.explorer.metadata import ColumnInfo, ColumnKind, TableInfo
from app.services.explorer.query import record_key

MAX_CHANGES = 500
# Upper bound for unbounded `text` columns (varchar columns use their own length).
MAX_TEXT_LENGTH = 20_000

type CellValue = str | int | float | bool | None


class RowUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: dict[str, CellValue]
    # The row's `updated_at` as read by the client (optimistic concurrency, ADR-0008).
    version: str | None = None
    values: dict[str, CellValue] = Field(min_length=1)


class RowInsertIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    values: dict[str, CellValue]


class RowDeleteIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: dict[str, CellValue]
    version: str | None = None


class ChangeSetIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    updates: list[RowUpdateIn] = Field(default_factory=list, max_length=MAX_CHANGES)
    inserts: list[RowInsertIn] = Field(default_factory=list, max_length=MAX_CHANGES)
    deletes: list[RowDeleteIn] = Field(default_factory=list, max_length=MAX_CHANGES)


class Operation(StrEnum):
    UPDATE = "update"
    INSERT = "insert"
    DELETE = "delete"


class ErrorCode(StrEnum):
    NOT_ALLOWED = "not_allowed"
    INVALID_KEY = "invalid_key"
    DUPLICATE = "duplicate"
    UNKNOWN_COLUMN = "unknown_column"
    READ_ONLY = "read_only"
    INVALID_VALUE = "invalid_value"
    REQUIRED = "required"
    NOT_FOUND = "not_found"
    CONFLICT = "conflict"
    REFERENCE_NOT_FOUND = "reference_not_found"
    UNIQUE = "unique_violation"
    CHECK = "check_violation"
    FOREIGN_KEY = "foreign_key_violation"
    DO_NOT_CONTACT = "do_not_contact"
    REJECTED = "rejected"


@dataclass(frozen=True, slots=True)
class ChangeRef:
    """Position of a change in the request: `updates[3]`, `inserts[0]`…"""

    operation: Operation
    index: int


@dataclass(frozen=True, slots=True)
class ChangeError:
    ref: ChangeRef
    code: ErrorCode
    message: str
    # None: the error concerns the whole row.
    column: str | None = None


class ChangeSetRejected(DomainError):
    """Nothing was applied: every error found, per change."""

    def __init__(self, errors: list[ChangeError]) -> None:
        super().__init__(f"{len(errors)} change(s) rejected.")
        self.errors = errors

    @property
    def conflict(self) -> bool:
        return any(error.code is ErrorCode.CONFLICT for error in self.errors)


@dataclass(frozen=True, slots=True)
class RowUpdate:
    ref: ChangeRef
    key: dict[str, object]
    version: datetime | None
    values: dict[str, object]


@dataclass(frozen=True, slots=True)
class RowInsert:
    ref: ChangeRef
    values: dict[str, object]


@dataclass(frozen=True, slots=True)
class RowDelete:
    ref: ChangeRef
    key: dict[str, object]
    version: datetime | None


@dataclass(frozen=True, slots=True)
class ChangeSet:
    table: TableInfo
    updates: tuple[RowUpdate, ...]
    inserts: tuple[RowInsert, ...]
    deletes: tuple[RowDelete, ...]


class CellError(Exception):
    def __init__(self, code: ErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


_DATETIME = TypeAdapter(AwareDatetime)
_DATE = TypeAdapter(date)
_INVALID = ErrorCode.INVALID_VALUE


def parse_cell(column: ColumnInfo, value: CellValue) -> object:
    """`value` as the column's Python type, or `CellError` with a French message."""
    if value is None:
        if not column.nullable:
            raise CellError(ErrorCode.REQUIRED, "Valeur obligatoire : la colonne refuse NULL.")
        return None
    column_type = column.column.type
    match column.kind:
        case ColumnKind.TEXT:
            text = _string(value, "Texte attendu.")
            limit = getattr(column_type, "length", None) or MAX_TEXT_LENGTH
            if len(text) > limit:
                raise CellError(_INVALID, f"{limit} caractères au maximum.")
            return text
        case ColumnKind.ENUM:
            text = _string(value, "Valeur de la liste attendue.")
            if text not in (column.allowed_values or ()):
                allowed = ", ".join(column.allowed_values or ())
                raise CellError(_INVALID, f"Valeur non autorisée. Valeurs possibles : {allowed}.")
            enum_class = getattr(column_type, "enum_class", None)
            return enum_class(text) if enum_class is not None else text
        case ColumnKind.INTEGER:
            if isinstance(value, bool) or not isinstance(value, int):
                raise CellError(_INVALID, "Nombre entier attendu.")
            if abs(value) > _integer_limit(column_type):
                raise CellError(_INVALID, "Nombre hors limites pour cette colonne.")
            return value
        case ColumnKind.NUMBER:
            if isinstance(value, bool) or not isinstance(value, int | float):
                raise CellError(_INVALID, "Nombre attendu.")
            return Decimal(str(value))
        case ColumnKind.BOOLEAN:
            if not isinstance(value, bool):
                raise CellError(_INVALID, "Vrai ou faux attendu.")
            return value
        case ColumnKind.DATETIME:
            return _parsed(_DATETIME, value, "Date et heure ISO 8601 avec fuseau attendues.")
        case ColumnKind.DATE:
            return _parsed(_DATE, value, "Date attendue (AAAA-MM-JJ).")
        case ColumnKind.UUID:
            try:
                return uuid.UUID(_string(value, "Identifiant UUID attendu."))
            except ValueError as error:
                raise CellError(_INVALID, "Identifiant UUID invalide.") from error
        case ColumnKind.JSON | ColumnKind.ARRAY:
            raise CellError(ErrorCode.READ_ONLY, "Valeur structurée : lecture seule.")


def _string(value: CellValue, message: str) -> str:
    if not isinstance(value, str):
        raise CellError(_INVALID, message)
    return value


def _parsed(adapter: TypeAdapter[Any], value: CellValue, message: str) -> object:
    try:
        return adapter.validate_python(_string(value, message))
    except PydanticValidationError as error:
        raise CellError(_INVALID, message) from error


def _integer_limit(column_type: sa.types.TypeEngine[Any]) -> int:
    if isinstance(column_type, sa.SmallInteger):
        return 2**15 - 1
    if isinstance(column_type, sa.BigInteger):
        return 2**63 - 1
    return 2**31 - 1


class _Collector:
    def __init__(self) -> None:
        self.errors: list[ChangeError] = []

    def add(self, ref: ChangeRef, code: ErrorCode, message: str, column: str | None = None) -> None:
        self.errors.append(ChangeError(ref, code, message, column))


def validate_change_set(table: TableInfo, raw: ChangeSetIn) -> ChangeSet:
    """Typed, policy-checked change set; `ChangeSetRejected` lists every problem found."""
    total = len(raw.updates) + len(raw.inserts) + len(raw.deletes)
    if total == 0:
        raise InvalidInputError("The change set is empty.")
    if total > MAX_CHANGES:
        raise InvalidInputError(f"A change set is limited to {MAX_CHANGES} changes.")
    errors = _Collector()
    updates = tuple(
        update
        for index, item in enumerate(raw.updates)
        if (update := _update(table, ChangeRef(Operation.UPDATE, index), item, errors))
    )
    inserts = tuple(
        insert
        for index, new in enumerate(raw.inserts)
        if (insert := _insert(table, ChangeRef(Operation.INSERT, index), new, errors))
    )
    deletes = tuple(
        delete
        for index, gone in enumerate(raw.deletes)
        if (delete := _delete(table, ChangeRef(Operation.DELETE, index), gone, errors))
    )
    _reject_duplicates([*updates, *deletes], errors)
    if errors.errors:
        raise ChangeSetRejected(errors.errors)
    return ChangeSet(table=table, updates=updates, inserts=inserts, deletes=deletes)


def _update(
    table: TableInfo, ref: ChangeRef, item: RowUpdateIn, errors: _Collector
) -> RowUpdate | None:
    if table.writes.update is not None:
        errors.add(ref, ErrorCode.NOT_ALLOWED, table.writes.update)
        return None
    key = _key(table, ref, item.key, errors)
    version = _version(table, ref, item.version, errors)
    values = _values(table, ref, item.values, errors, inserting=False)
    if key is None or values is None or (version is None and table.version_column):
        return None
    return RowUpdate(ref=ref, key=key, version=version, values=values)


def _insert(
    table: TableInfo, ref: ChangeRef, item: RowInsertIn, errors: _Collector
) -> RowInsert | None:
    if table.writes.insert is not None:
        errors.add(ref, ErrorCode.NOT_ALLOWED, table.writes.insert)
        return None
    values = _values(table, ref, item.values, errors, inserting=True)
    missing = [
        column.name
        for column in table.columns
        if column.required_on_insert and column.name not in item.values
    ]
    for name in missing:
        errors.add(ref, ErrorCode.REQUIRED, "Valeur obligatoire pour une nouvelle ligne.", name)
    return RowInsert(ref=ref, values=values) if values is not None and not missing else None


def _delete(
    table: TableInfo, ref: ChangeRef, item: RowDeleteIn, errors: _Collector
) -> RowDelete | None:
    if table.writes.delete is not None:
        errors.add(ref, ErrorCode.NOT_ALLOWED, table.writes.delete)
        return None
    key = _key(table, ref, item.key, errors)
    version = _version(table, ref, item.version, errors)
    if key is None or (version is None and table.version_column):
        return None
    return RowDelete(ref=ref, key=key, version=version)


def _key(
    table: TableInfo, ref: ChangeRef, raw: dict[str, CellValue], errors: _Collector
) -> dict[str, object] | None:
    try:
        return record_key(table, raw)
    except InvalidInputError:
        errors.add(ref, ErrorCode.INVALID_KEY, "Clé de ligne invalide : actualisez la table.")
        return None


def _version(
    table: TableInfo, ref: ChangeRef, raw: str | None, errors: _Collector
) -> datetime | None:
    if table.version_column is None:
        return None
    try:
        version: datetime = _DATETIME.validate_python(raw)
    except PydanticValidationError:
        errors.add(ref, ErrorCode.INVALID_KEY, "Version de ligne absente : actualisez la table.")
        return None
    return version


def _values(
    table: TableInfo,
    ref: ChangeRef,
    raw: dict[str, CellValue],
    errors: _Collector,
    *,
    inserting: bool,
) -> dict[str, object] | None:
    values: dict[str, object] = {}
    valid = True
    for name, value in raw.items():
        column = table.column(name)
        if column is None:
            errors.add(ref, ErrorCode.UNKNOWN_COLUMN, "Colonne inconnue.", name)
            valid = False
            continue
        if not (column.insertable if inserting else column.updatable):
            reason = column.read_only_reason or "Colonne en lecture seule."
            errors.add(ref, ErrorCode.READ_ONLY, reason, name)
            valid = False
            continue
        try:
            values[name] = parse_cell(column, value)
        except CellError as error:
            errors.add(ref, error.code, error.message, name)
            valid = False
    return values if valid else None


def _reject_duplicates(changes: list[RowUpdate | RowDelete], errors: _Collector) -> None:
    seen: set[tuple[tuple[str, str], ...]] = set()
    for change in changes:
        identity = tuple(sorted((name, str(value)) for name, value in change.key.items()))
        if identity in seen:
            errors.add(change.ref, ErrorCode.DUPLICATE, "Cette ligne figure deux fois.")
        seen.add(identity)
