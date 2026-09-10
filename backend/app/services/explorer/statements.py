"""Database Explorer statements: SQLAlchemy Core over policy-approved `Table` objects.

The explorer's own persistence layer (it has no domain entities, so it does not use
`app.repositories`). Inputs are validated `ReadQuery` objects (`query.py`): column objects come
from the ORM metadata and every client value is a bound parameter. Text matching uses ILIKE with
`autoescape`, so `%`, `_` and the escape character in user input match literally.
"""

from collections.abc import Iterator, Mapping, Sequence
from typing import Any

import sqlalchemy as sa
from sqlalchemy import RowMapping
from sqlalchemy.orm import Session

from app.services.explorer.metadata import ColumnInfo, ColumnKind, FilterOperator, TableInfo
from app.services.explorer.query import Condition, Group, ReadQuery

EXPORT_BATCH_SIZE = 1000


def count_rows(session: Session, tables: Sequence[sa.Table]) -> dict[str, int]:
    """Exact row count of each table, in one round trip (V1 tables hold thousands of rows)."""
    if not tables:
        return {}
    counts = sa.select(
        *(
            sa.select(sa.func.count()).select_from(table).scalar_subquery().label(table.name)
            for table in tables
        )
    )
    row = session.execute(counts).one()
    return {table.name: int(row._mapping[table.name]) for table in tables}


def count_matching(session: Session, query: ReadQuery) -> int:
    statement = sa.select(sa.func.count()).select_from(query.table.table)
    return int(session.execute(statement.where(*_where(query))).scalar_one())


def select_page(session: Session, query: ReadQuery, *, offset: int, limit: int) -> list[RowMapping]:
    statement = _select(query).offset(offset).limit(limit)
    return list(session.execute(statement).mappings())


def iter_rows(session: Session, query: ReadQuery) -> Iterator[RowMapping]:
    """Every matching row in order, fetched through a server-side cursor in batches."""
    result = session.execute(_select(query), execution_options={"yield_per": EXPORT_BATCH_SIZE})
    yield from result.mappings()


def select_record(
    session: Session, table: TableInfo, key: Mapping[str, object]
) -> RowMapping | None:
    conditions = [column.column == key[column.name] for column in table.primary_key]
    statement = sa.select(*_selected(table)).where(*conditions)
    return session.execute(statement).mappings().one_or_none()


def _selected(table: TableInfo) -> list[sa.ColumnElement[Any]]:
    # Masked columns are never read: their values cannot leak through any code path.
    return [
        sa.null().label(column.name) if column.masked else column.column for column in table.columns
    ]


def _select(query: ReadQuery) -> sa.Select[Any]:
    order: list[sa.ColumnElement[Any]] = [
        key.column.column.desc() if key.descending else key.column.column.asc()
        for key in query.sort
    ]
    sorted_names = {key.column.name for key in query.sort}
    # The primary key closes every ordering, so pages are stable and disjoint.
    order += [pk.column.asc() for pk in query.table.primary_key if pk.name not in sorted_names]
    return sa.select(*_selected(query.table)).where(*_where(query)).order_by(*order)


def _where(query: ReadQuery) -> list[sa.ColumnElement[bool]]:
    clauses = []
    if query.filter is not None:
        clauses.append(_compile(query.filter))
    if query.search is not None:
        searchable = [column for column in query.table.columns if column.searchable]
        clauses.append(
            sa.or_(
                sa.false(),
                *(
                    _as_text(column).icontains(query.search, autoescape=True)
                    for column in searchable
                ),
            )
        )
    return clauses


def _compile(node: Condition | Group) -> sa.ColumnElement[bool]:
    if isinstance(node, Condition):
        return _condition(node)
    children = [_compile(child) for child in node.children]
    if node.combinator == "or":
        return sa.or_(sa.false(), *children)
    return sa.and_(sa.true(), *children)


def _as_text(column: ColumnInfo) -> sa.ColumnElement[str]:
    if column.kind in (ColumnKind.TEXT, ColumnKind.ENUM):
        return column.column  # type: ignore[return-value]
    return sa.cast(column.column, sa.Text)


def _condition(condition: Condition) -> sa.ColumnElement[bool]:
    column = condition.column.column
    value = condition.value
    match condition.operator:
        case FilterOperator.IS_NULL:
            return column.is_(None)
        case FilterOperator.NOT_NULL:
            return column.is_not(None)
        case FilterOperator.EQ:
            return column == value
        case FilterOperator.NEQ:
            # "Different from X" keeps rows where the column is NULL.
            return column.is_distinct_from(value)
        case FilterOperator.GT:
            return column > value
        case FilterOperator.GTE:
            return column >= value
        case FilterOperator.LT:
            return column < value
        case FilterOperator.LTE:
            return column <= value
        case FilterOperator.IN:
            return column.in_(condition.values)
        case FilterOperator.CONTAINS:
            return _as_text(condition.column).icontains(value, autoescape=True)
        case FilterOperator.STARTS_WITH:
            return _as_text(condition.column).istartswith(value, autoescape=True)
