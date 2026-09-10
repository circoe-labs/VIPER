"""Read-only SQL console (`POST /api/explorer/sql`, ADR-0011).

A POST only because the query text can be long and must not land in URLs or access logs; it never
writes domain data. Each attempt is audited (`explorer.sql_executed`, source `database_explorer`)
with the query's hash and length, never its text, and its outcome.
"""

import hashlib
from typing import Any

from fastapi import APIRouter, Depends, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.api.dependencies import CurrentActor, SessionDep, audit_source
from app.core.actor import ActorContext
from app.core.config import Settings
from app.services import audit
from app.services.audit import AuditAction, AuditSource
from app.services.explorer.sql_console import (
    MAX_QUERY_LENGTH,
    SqlConsoleError,
    SqlResult,
    check_statement,
    run_query,
)

router = APIRouter(
    prefix="/explorer",
    tags=["explorer"],
    dependencies=[Depends(audit_source(AuditSource.DATABASE_EXPLORER))],
)

SQL_ENTITY = "sql_query"


class SqlQueryIn(BaseModel):
    # Longer texts are refused with a readable message by `check_statement`.
    sql: str = Field(max_length=MAX_QUERY_LENGTH + 1)


class SqlColumnOut(BaseModel):
    name: str
    type: str


class SqlResultOut(BaseModel):
    columns: list[SqlColumnOut]
    rows: list[list[Any]]
    truncated_cells: list[tuple[int, int]]
    row_count: int
    truncated: bool
    max_rows: int
    duration_ms: int


def _record(
    session: Session, actor: ActorContext, text: str, outcome: str, result: SqlResult | None
) -> None:
    facts: dict[str, Any] = {
        "query_sha256": hashlib.sha256(text.encode()).hexdigest(),
        "query_length": len(text),
        "outcome": outcome,
    }
    if result is not None:
        facts |= {
            "row_count": len(result.rows),
            "truncated": result.truncated,
            "duration_ms": result.duration_ms,
        }
    audit.record_event(
        session,
        actor,
        AuditAction.EXPLORER_SQL_EXECUTED,
        entity_type=SQL_ENTITY,
        entity_id=None,
        changes={name: {"before": None, "after": value} for name, value in facts.items()},
    )


@router.post(
    "/sql",
    response_model=SqlResultOut,
    responses={
        status.HTTP_422_UNPROCESSABLE_CONTENT: {"description": "Query refused or failed"},
        status.HTTP_503_SERVICE_UNAVAILABLE: {"description": "Reader role not provisioned"},
    },
)
def run_sql(
    request: Request, session: SessionDep, actor: CurrentActor, body: SqlQueryIn
) -> SqlResultOut | JSONResponse:
    settings: Settings = request.app.state.settings
    try:
        statement = check_statement(body.sql)
        result = run_query(
            request.app.state.sql_engine,
            statement,
            max_rows=settings.sql_max_rows,
            timeout_ms=settings.sql_statement_timeout_ms,
        )
    except SqlConsoleError as error:
        # Refusals are audited too: the response is not an exception, so the event is committed.
        _record(session, actor, body.sql, error.code, None)
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE
            if error.code == "unavailable"
            else status.HTTP_422_UNPROCESSABLE_CONTENT,
            content={
                "detail": {
                    "code": error.code,
                    "message": error.message,
                    "detail": error.detail,
                    "position": error.position,
                }
            },
        )
    _record(session, actor, body.sql, "ok", result)
    return SqlResultOut(
        columns=[SqlColumnOut(name=column.name, type=column.type) for column in result.columns],
        rows=result.rows,
        truncated_cells=result.truncated_cells,
        row_count=len(result.rows),
        truncated=result.truncated,
        max_rows=settings.sql_max_rows,
        duration_ms=result.duration_ms,
    )
