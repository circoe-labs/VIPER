"""Read query model: the typed filter AST, sort and search, validated against table metadata.

Clients send an AST (`FilterNode`); `validate_query` checks every column name against the exposed
metadata, every operator against the column kind and parses every value into the column's Python
type. `statements.py` only ever receives these validated objects, so no client string reaches SQL
other than as a bound parameter.
"""

import uuid
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, TypeAdapter
from pydantic import ValidationError as PydanticValidationError

from app.services.errors import InvalidInputError
from app.services.explorer.metadata import ColumnInfo, ColumnKind, FilterOperator, TableInfo

MAX_FILTER_DEPTH = 4
MAX_FILTER_CONDITIONS = 50
MAX_IN_VALUES = 100
MAX_TEXT_VALUE_LENGTH = 1000
MAX_SEARCH_LENGTH = 200
MAX_SORT_KEYS = 10
MAX_PAGE_SIZE = 500
INT64_MAX = 2**63 - 1

type Scalar = str | int | float | bool | None


class FilterCondition(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["condition"] = "condition"
    column: str = Field(max_length=63)
    operator: FilterOperator
    value: Scalar = None
    values: list[Scalar] | None = Field(default=None, max_length=MAX_IN_VALUES)


class FilterGroup(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["group"] = "group"
    combinator: Literal["and", "or"] = "and"
    conditions: list[FilterNode] = Field(max_length=MAX_FILTER_CONDITIONS)


type FilterNode = Annotated[FilterCondition | FilterGroup, Field(discriminator="type")]
FilterGroup.model_rebuild()
FILTER_ADAPTER: TypeAdapter[FilterNode] = TypeAdapter(FilterNode)


@dataclass(frozen=True, slots=True)
class Condition:
    column: ColumnInfo
    operator: FilterOperator
    value: object = None
    values: tuple[object, ...] = ()


@dataclass(frozen=True, slots=True)
class Group:
    combinator: Literal["and", "or"]
    children: tuple[Condition | Group, ...]


@dataclass(frozen=True, slots=True)
class SortKey:
    column: ColumnInfo
    descending: bool


@dataclass(frozen=True, slots=True)
class ReadQuery:
    """A validated read: filters AND global search, ordered by `sort` then the primary key."""

    table: TableInfo
    filter: Condition | Group | None = None
    search: str | None = None
    sort: tuple[SortKey, ...] = ()


def parse_filter(raw: str | None) -> FilterNode | None:
    """Parse the JSON-encoded filter AST of a request (`None`/empty = no filter)."""
    if not raw:
        return None
    try:
        return FILTER_ADAPTER.validate_json(raw)
    except PydanticValidationError as error:
        raise InvalidInputError(f"Invalid filter: {error.error_count()} error(s).") from error


def validate_query(
    table: TableInfo,
    *,
    filter_node: FilterNode | None = None,
    search: str | None = None,
    sort: list[str] | None = None,
) -> ReadQuery:
    search = (search or "").strip() or None
    if search is not None and len(search) > MAX_SEARCH_LENGTH:
        raise InvalidInputError(f"Search is limited to {MAX_SEARCH_LENGTH} characters.")
    return ReadQuery(
        table=table,
        filter=_validate_node(table, filter_node, depth=1) if filter_node else None,
        search=search,
        sort=_validate_sort(table, sort or []),
    )


def _validate_node(table: TableInfo, node: FilterNode, *, depth: int) -> Condition | Group:
    if depth > MAX_FILTER_DEPTH:
        raise InvalidInputError(f"Filters are limited to {MAX_FILTER_DEPTH} nested levels.")
    if isinstance(node, FilterCondition):
        return _validate_condition(table, node)
    if _count_conditions(node) > MAX_FILTER_CONDITIONS:
        raise InvalidInputError(f"Filters are limited to {MAX_FILTER_CONDITIONS} conditions.")
    children = tuple(_validate_node(table, child, depth=depth + 1) for child in node.conditions)
    return Group(combinator=node.combinator, children=children)


def _count_conditions(node: FilterNode) -> int:
    if isinstance(node, FilterCondition):
        return 1
    return sum(_count_conditions(child) for child in node.conditions)


def _column(table: TableInfo, name: str, usage: str) -> ColumnInfo:
    column = table.column(name)
    if column is None:
        raise InvalidInputError(f"Unknown column {name!r} for {usage}.")
    if column.masked:
        raise InvalidInputError(f"Column {name!r} is masked and cannot be used for {usage}.")
    return column


def _validate_condition(table: TableInfo, condition: FilterCondition) -> Condition:
    column = _column(table, condition.column, "filtering")
    operator = condition.operator
    if operator not in column.operators:
        raise InvalidInputError(
            f"Operator {operator.value!r} is not available for {column.kind.value} column"
            f" {column.name!r}."
        )
    if operator in (FilterOperator.IS_NULL, FilterOperator.NOT_NULL):
        return Condition(column=column, operator=operator)
    if operator is FilterOperator.IN:
        if not condition.values:
            raise InvalidInputError(
                f"Operator 'in' needs a non-empty 'values' list ({column.name})."
            )
        values = tuple(_parse_value(column, operator, value) for value in condition.values)
        return Condition(column=column, operator=operator, values=values)
    return Condition(
        column=column, operator=operator, value=_parse_value(column, operator, condition.value)
    )


_DATETIME = TypeAdapter(AwareDatetime)
_DATE = TypeAdapter(date)


def _parse_value(column: ColumnInfo, operator: FilterOperator, value: Scalar) -> object:
    """The value as the column's Python type; text-matching operators always take a string."""
    if value is None:
        raise InvalidInputError(
            f"A value is required for {operator.value!r} on {column.name!r}"
            " (use 'is_null' / 'not_null' to match missing values)."
        )
    if operator in (FilterOperator.CONTAINS, FilterOperator.STARTS_WITH):
        return _text(column, value)
    try:
        match column.kind:
            case ColumnKind.TEXT:
                return _text(column, value)
            case ColumnKind.ENUM:
                text = _text(column, value)
                if text not in (column.allowed_values or ()):
                    raise InvalidInputError(f"{text!r} is not an allowed value of {column.name!r}.")
                return text
            case ColumnKind.INTEGER:
                if isinstance(value, bool) or not isinstance(value, int):
                    raise InvalidInputError(f"{column.name!r} expects an integer.")
                if abs(value) > INT64_MAX:
                    raise InvalidInputError(f"{column.name!r} value is out of range.")
                return value
            case ColumnKind.NUMBER:
                if isinstance(value, bool) or not isinstance(value, int | float):
                    raise InvalidInputError(f"{column.name!r} expects a number.")
                return Decimal(str(value))
            case ColumnKind.BOOLEAN:
                if not isinstance(value, bool):
                    raise InvalidInputError(f"{column.name!r} expects true or false.")
                return value
            case ColumnKind.DATETIME:
                parsed: datetime = _DATETIME.validate_python(_text(column, value))
                return parsed
            case ColumnKind.DATE:
                return _DATE.validate_python(_text(column, value))
            case ColumnKind.UUID:
                return uuid.UUID(_text(column, value))
            case ColumnKind.JSON | ColumnKind.ARRAY:
                raise InvalidInputError(f"{column.name!r} only supports text matching.")
    except (PydanticValidationError, ValueError) as error:
        raise InvalidInputError(
            f"Invalid {column.kind.value} value for {column.name!r}"
            " (datetimes need an ISO 8601 timezone offset)."
        ) from error


def _text(column: ColumnInfo, value: Scalar) -> str:
    if not isinstance(value, str):
        raise InvalidInputError(f"{column.name!r} expects a string value.")
    if len(value) > MAX_TEXT_VALUE_LENGTH:
        raise InvalidInputError(f"Filter values are limited to {MAX_TEXT_VALUE_LENGTH} characters.")
    return value


def _validate_sort(table: TableInfo, sort: list[str]) -> tuple[SortKey, ...]:
    """`sort` items are column names, prefixed with `-` for descending order."""
    if len(sort) > MAX_SORT_KEYS:
        raise InvalidInputError(f"Sorting is limited to {MAX_SORT_KEYS} columns.")
    keys: list[SortKey] = []
    for item in sort:
        descending = item.startswith("-")
        column = _column(table, item.removeprefix("-"), "sorting")
        if any(key.column.name == column.name for key in keys):
            raise InvalidInputError(f"Column {column.name!r} appears twice in the sort.")
        keys.append(SortKey(column=column, descending=descending))
    return tuple(keys)


def parse_record_key(table: TableInfo, raw: str) -> dict[str, object]:
    """Primary-key values of one row, from a JSON object `{"<pk column>": value, ...}`."""
    try:
        key = TypeAdapter(dict[str, Scalar]).validate_json(raw)
    except PydanticValidationError as error:
        raise InvalidInputError("The record key must be a JSON object.") from error
    names = [column.name for column in table.primary_key]
    if sorted(key) != sorted(names):
        raise InvalidInputError(f"The record key must contain exactly: {', '.join(names)}.")
    return {
        column.name: _parse_value(column, FilterOperator.EQ, key[column.name])
        for column in table.primary_key
    }
