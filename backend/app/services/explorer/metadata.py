"""Table and column metadata of exposed tables, derived from the ORM metadata.

The ORM is the explorer's schema source: `tests/test_migrations.py` guarantees it matches the
migrated database, and it carries what reflection would lose (CHECK value lists as enums).
"""

from dataclasses import dataclass
from enum import StrEnum
from typing import Any

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import DefaultClause

import app.models  # noqa: F401  (registers every table on Base.metadata)
from app.db.base import Base
from app.services.errors import NotFoundError
from app.services.explorer.policy import DEFAULT_COLUMN_POLICY, ColumnVisibility, ExposurePolicy

_DIALECT = postgresql.dialect()  # type: ignore[no-untyped-call]


class ColumnKind(StrEnum):
    """Value family of a column: drives operators, value parsing, search and rendering."""

    TEXT = "text"
    ENUM = "enum"
    INTEGER = "integer"
    NUMBER = "number"
    BOOLEAN = "boolean"
    DATETIME = "datetime"
    DATE = "date"
    UUID = "uuid"
    JSON = "json"
    ARRAY = "array"


class FilterOperator(StrEnum):
    EQ = "eq"
    NEQ = "neq"
    CONTAINS = "contains"
    STARTS_WITH = "starts_with"
    GT = "gt"
    GTE = "gte"
    LT = "lt"
    LTE = "lte"
    IS_NULL = "is_null"
    NOT_NULL = "not_null"
    IN = "in"


_Op = FilterOperator
_NULLS = (_Op.IS_NULL, _Op.NOT_NULL)
_ORDERED = (_Op.EQ, _Op.NEQ, _Op.GT, _Op.GTE, _Op.LT, _Op.LTE)

OPERATORS: dict[ColumnKind, tuple[FilterOperator, ...]] = {
    ColumnKind.TEXT: (_Op.CONTAINS, _Op.EQ, _Op.NEQ, _Op.STARTS_WITH, _Op.IN, *_NULLS),
    ColumnKind.ENUM: (_Op.EQ, _Op.NEQ, _Op.IN, *_NULLS),
    ColumnKind.INTEGER: (*_ORDERED, _Op.IN, *_NULLS),
    ColumnKind.NUMBER: (*_ORDERED, _Op.IN, *_NULLS),
    ColumnKind.BOOLEAN: (_Op.EQ, _Op.NEQ, *_NULLS),
    ColumnKind.DATETIME: (*_ORDERED, *_NULLS),
    ColumnKind.DATE: (*_ORDERED, *_NULLS),
    ColumnKind.UUID: (_Op.EQ, _Op.NEQ, _Op.IN, _Op.STARTS_WITH, *_NULLS),
    ColumnKind.JSON: (_Op.CONTAINS, *_NULLS),
    ColumnKind.ARRAY: (_Op.CONTAINS, *_NULLS),
}

# Kinds matched by the global search (as text, case-insensitive).
SEARCHABLE_KINDS = frozenset(
    {ColumnKind.TEXT, ColumnKind.ENUM, ColumnKind.UUID, ColumnKind.JSON, ColumnKind.ARRAY}
)


@dataclass(frozen=True, slots=True)
class ColumnRef:
    table: str
    column: str


@dataclass(frozen=True, slots=True)
class ColumnInfo:
    name: str
    sql_type: str
    kind: ColumnKind
    nullable: bool
    default: str | None
    primary_key: bool
    foreign_key: ColumnRef | None
    allowed_values: tuple[str, ...] | None
    masked: bool
    column: sa.Column[object]

    @property
    def operators(self) -> tuple[FilterOperator, ...]:
        return () if self.masked else OPERATORS[self.kind]

    @property
    def sortable(self) -> bool:
        return not self.masked

    @property
    def searchable(self) -> bool:
        return not self.masked and self.kind in SEARCHABLE_KINDS


@dataclass(frozen=True, slots=True)
class Reference:
    """An incoming foreign key: `table.column` references this table's `referenced_column`."""

    table: str
    column: str
    referenced_column: str


@dataclass(frozen=True, slots=True)
class TableInfo:
    name: str
    table: sa.Table
    columns: tuple[ColumnInfo, ...]
    referenced_by: tuple[Reference, ...]

    @property
    def primary_key(self) -> tuple[ColumnInfo, ...]:
        return tuple(column for column in self.columns if column.primary_key)

    def column(self, name: str) -> ColumnInfo | None:
        return next((column for column in self.columns if column.name == name), None)


def exposed_table_names(policy: ExposurePolicy) -> list[str]:
    return sorted(name for name in policy.tables if name in Base.metadata.tables)


def describe_table(policy: ExposurePolicy, name: str) -> TableInfo:
    """Metadata of an exposed table; `NotFoundError` for anything the policy does not expose."""
    table_policy = policy.table(name)
    table = Base.metadata.tables.get(name)
    if table_policy is None or table is None:
        raise NotFoundError(f"Table {name!r} is not available in the explorer.")
    if any(table_policy.column(pk.name) != DEFAULT_COLUMN_POLICY for pk in table.primary_key):
        # Row identity (default order, record lookup, FK navigation) needs the key.
        raise ValueError(f"Primary key columns of {name!r} cannot be hidden or masked.")
    columns = tuple(
        _column_info(policy, column, masked=visibility is ColumnVisibility.MASKED)
        for column in table.columns
        if (visibility := table_policy.column(column.name).visibility)
        is not ColumnVisibility.HIDDEN
    )
    return TableInfo(
        name=name,
        table=table,
        columns=columns,
        referenced_by=_references_to(policy, name),
    )


def _column_info(policy: ExposurePolicy, column: sa.Column[object], *, masked: bool) -> ColumnInfo:
    column_type = column.type
    return ColumnInfo(
        name=column.name,
        sql_type=column_type.compile(dialect=_DIALECT).lower(),
        kind=_kind(column_type),
        nullable=bool(column.nullable),
        default=_server_default(column),
        primary_key=column.primary_key,
        foreign_key=_foreign_key(policy, column),
        allowed_values=tuple(column_type.enums) if isinstance(column_type, sa.Enum) else None,
        masked=masked,
        column=column,
    )


def _kind(column_type: sa.types.TypeEngine[object]) -> ColumnKind:
    # Order matters: Enum is a String, Text is a String, JSONB is a JSON, Float is a Numeric.
    kinds: tuple[tuple[type[Any], ColumnKind], ...] = (
        (sa.Enum, ColumnKind.ENUM),
        (sa.Boolean, ColumnKind.BOOLEAN),
        (sa.Integer, ColumnKind.INTEGER),
        (sa.Numeric, ColumnKind.NUMBER),
        (sa.DateTime, ColumnKind.DATETIME),
        (sa.Date, ColumnKind.DATE),
        (sa.Uuid, ColumnKind.UUID),
        (sa.JSON, ColumnKind.JSON),
        (sa.ARRAY, ColumnKind.ARRAY),
        (sa.String, ColumnKind.TEXT),
    )
    for type_class, kind in kinds:
        if isinstance(column_type, type_class):
            return kind
    raise TypeError(f"Unsupported column type for the explorer: {column_type!r}")


def _server_default(column: sa.Column[object]) -> str | None:
    default = column.server_default
    if not isinstance(default, DefaultClause):
        return None
    if isinstance(default.arg, str):
        return f"'{default.arg}'"
    return str(default.arg.compile(dialect=_DIALECT, compile_kwargs={"literal_binds": True}))


def _foreign_key(policy: ExposurePolicy, column: sa.Column[object]) -> ColumnRef | None:
    # A reference to a table the policy hides is not disclosed.
    for foreign_key in column.foreign_keys:
        target = foreign_key.column
        if policy.table(target.table.name) is not None:
            return ColumnRef(table=target.table.name, column=target.name)
    return None


def _references_to(policy: ExposurePolicy, name: str) -> tuple[Reference, ...]:
    references: list[Reference] = []
    for table_name in exposed_table_names(policy):
        table_policy = policy.tables[table_name]
        for column in Base.metadata.tables[table_name].columns:
            if table_policy.column(column.name).visibility is ColumnVisibility.HIDDEN:
                continue
            references.extend(
                Reference(table=table_name, column=column.name, referenced_column=fk.column.name)
                for fk in column.foreign_keys
                if fk.column.table.name == name
            )
    return tuple(references)
