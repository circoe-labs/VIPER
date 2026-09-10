"""Database Explorer read API (`/api/explorer`). GET only: this router has no write path."""

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Path, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session, sessionmaker

from app.api.dependencies import SessionDep
from app.db.session import unit_of_work
from app.services.errors import InvalidInputError, NotFoundError
from app.services.explorer import reads
from app.services.explorer.metadata import ColumnInfo, TableInfo, describe_table
from app.services.explorer.policy import DEFAULT_POLICY, ExposurePolicy
from app.services.explorer.query import (
    MAX_PAGE_SIZE,
    MAX_SORT_KEYS,
    ReadQuery,
    parse_filter,
    parse_record_key,
    validate_query,
)

router = APIRouter(prefix="/explorer", tags=["explorer"])


def get_policy() -> ExposurePolicy:
    return DEFAULT_POLICY


PolicyDep = Annotated[ExposurePolicy, Depends(get_policy)]
TableName = Annotated[str, Path(max_length=63)]
Search = Annotated[str | None, Query(alias="q", max_length=200)]
Sort = Annotated[
    list[str] | None,
    Query(max_length=MAX_SORT_KEYS, description="Column names; prefix with '-' for descending."),
]
Filter = Annotated[
    str | None, Query(alias="filter", max_length=8000, description="JSON filter AST.")
]


class ForeignKeyOut(BaseModel):
    table: str
    column: str


class ColumnOut(BaseModel):
    name: str
    sql_type: str
    kind: str
    nullable: bool
    default: str | None
    primary_key: bool
    foreign_key: ForeignKeyOut | None
    allowed_values: list[str] | None
    masked: bool
    filter_operators: list[str]
    sortable: bool
    searchable: bool


class ReferenceOut(BaseModel):
    table: str
    column: str
    referenced_column: str


class TableSummaryOut(BaseModel):
    name: str
    row_count: int


class TableOut(TableSummaryOut):
    primary_key: list[str]
    columns: list[ColumnOut]
    referenced_by: list[ReferenceOut]


class RowOut(BaseModel):
    values: dict[str, Any]
    truncated: list[str]


class RowPageOut(BaseModel):
    total: int
    offset: int
    limit: int
    rows: list[RowOut]


class RecordOut(BaseModel):
    values: dict[str, Any]


@contextmanager
def _http_errors() -> Iterator[None]:
    try:
        yield
    except NotFoundError as error:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(error)) from error
    except InvalidInputError as error:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(error)) from error


def _table(policy: ExposurePolicy, name: str) -> TableInfo:
    with _http_errors():
        return describe_table(policy, name)


def _query(
    table: TableInfo, search: str | None, sort: list[str] | None, raw_filter: str | None
) -> ReadQuery:
    with _http_errors():
        return validate_query(table, filter_node=parse_filter(raw_filter), search=search, sort=sort)


def _column_out(column: ColumnInfo) -> ColumnOut:
    foreign_key = column.foreign_key
    return ColumnOut(
        name=column.name,
        sql_type=column.sql_type,
        kind=column.kind.value,
        nullable=column.nullable,
        default=column.default,
        primary_key=column.primary_key,
        foreign_key=ForeignKeyOut(table=foreign_key.table, column=foreign_key.column)
        if foreign_key
        else None,
        allowed_values=list(column.allowed_values) if column.allowed_values is not None else None,
        masked=column.masked,
        filter_operators=[operator.value for operator in column.operators],
        sortable=column.sortable,
        searchable=column.searchable,
    )


@router.get("/tables")
def list_tables(session: SessionDep, policy: PolicyDep) -> list[TableSummaryOut]:
    return [
        TableSummaryOut(name=table.name, row_count=table.row_count)
        for table in reads.list_tables(session, policy)
    ]


@router.get("/tables/{table_name}")
def get_table(session: SessionDep, policy: PolicyDep, table_name: TableName) -> TableOut:
    table = _table(policy, table_name)
    return TableOut(
        name=table.name,
        row_count=reads.count_table_rows(session, table),
        primary_key=[column.name for column in table.primary_key],
        columns=[_column_out(column) for column in table.columns],
        referenced_by=[
            ReferenceOut(
                table=ref.table, column=ref.column, referenced_column=ref.referenced_column
            )
            for ref in table.referenced_by
        ],
    )


@router.get("/tables/{table_name}/rows")
def read_rows(
    session: SessionDep,
    policy: PolicyDep,
    table_name: TableName,
    search: Search = None,
    sort: Sort = None,
    raw_filter: Filter = None,
    offset: Annotated[int, Query(ge=0, le=10_000_000)] = 0,
    limit: Annotated[int, Query(ge=1, le=MAX_PAGE_SIZE)] = 100,
) -> RowPageOut:
    query = _query(_table(policy, table_name), search, sort, raw_filter)
    page = reads.read_page(session, query, offset=offset, limit=limit)
    return RowPageOut(
        total=page.total,
        offset=page.offset,
        limit=page.limit,
        rows=[RowOut(values=row.values, truncated=list(row.truncated)) for row in page.rows],
    )


@router.get("/tables/{table_name}/record")
def read_record(
    session: SessionDep,
    policy: PolicyDep,
    table_name: TableName,
    key: Annotated[str, Query(max_length=2000, description="JSON object of primary-key values.")],
) -> RecordOut:
    table = _table(policy, table_name)
    with _http_errors():
        return RecordOut(values=reads.read_record(session, table, parse_record_key(table, key)))


@router.get(
    "/tables/{table_name}/export.csv",
    response_class=StreamingResponse,
    responses={status.HTTP_200_OK: {"content": {"text/csv": {}}}},
)
def export_csv(
    request: Request,
    policy: PolicyDep,
    table_name: TableName,
    search: Search = None,
    sort: Sort = None,
    raw_filter: Filter = None,
) -> StreamingResponse:
    query = _query(_table(policy, table_name), search, sort, raw_filter)
    session_factory: sessionmaker[Session] = request.app.state.session_factory

    # The body is produced after the route returns, so it owns its own (read) transaction.
    def body() -> Iterator[str]:
        with unit_of_work(session_factory) as session:
            yield from reads.export_csv(session, query)

    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    return StreamingResponse(
        body(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{table_name}-{stamp}.csv"'},
    )
