"""Database Explorer staged writes (`/api/explorer`): apply a change set, check a deletion.

Every write of these routes is audited with the signed-in user and `source=database_explorer`
(router dependency). The request's transaction is the unit: a rejected change set answers 422 (409
when a row changed meanwhile) with every error, and nothing is kept.
"""

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from app.api.dependencies import CurrentActor, SessionDep, audit_source
from app.api.routes.explorer import PolicyDep, TableName, http_errors, table_or_404
from app.services.audit import AuditSource
from app.services.explorer.changes import ChangeSetIn, ChangeSetRejected, validate_change_set
from app.services.explorer.deletion import MAX_DELETE_CHECK_KEYS, check_delete
from app.services.explorer.query import parse_record_key
from app.services.explorer.writes import apply_change_set

router = APIRouter(
    prefix="/explorer",
    tags=["explorer"],
    dependencies=[Depends(audit_source(AuditSource.DATABASE_EXPLORER))],
)


class ChangeErrorOut(BaseModel):
    operation: str
    index: int
    column: str | None
    code: str
    message: str


class ChangeSetResultOut(BaseModel):
    updated: int
    inserted: int
    deleted: int
    inserted_keys: list[dict[str, Any]]


class DeleteEffectOut(BaseModel):
    table: str | None
    column: str | None
    action: str
    count: int
    depth: int


class DeleteCheckOut(BaseModel):
    rows: int
    allowed: bool
    blockers: list[str]
    effects: list[DeleteEffectOut]


def _rejection(error: ChangeSetRejected) -> HTTPException:
    count = len(error.errors)
    return HTTPException(
        status.HTTP_409_CONFLICT if error.conflict else status.HTTP_422_UNPROCESSABLE_CONTENT,
        {
            "message": f"{count} erreur(s) : aucune modification n’a été enregistrée.",
            "errors": [
                ChangeErrorOut(
                    operation=item.ref.operation.value,
                    index=item.ref.index,
                    column=item.column,
                    code=item.code.value,
                    message=item.message,
                ).model_dump()
                for item in error.errors
            ],
        },
    )


@router.post("/tables/{table_name}/changes")
def save_changes(
    session: SessionDep,
    policy: PolicyDep,
    actor: CurrentActor,
    table_name: TableName,
    body: ChangeSetIn,
) -> ChangeSetResultOut:
    table = table_or_404(policy, table_name)
    try:
        with http_errors():
            changes = validate_change_set(table, body)
        result = apply_change_set(session, actor, changes)
    except ChangeSetRejected as error:
        raise _rejection(error) from error
    return ChangeSetResultOut(
        updated=result.updated,
        inserted=result.inserted,
        deleted=result.deleted,
        inserted_keys=result.inserted_keys,
    )


@router.get("/tables/{table_name}/delete-check")
def delete_check(
    session: SessionDep,
    policy: PolicyDep,
    table_name: TableName,
    key: Annotated[
        list[str],
        Query(
            min_length=1,
            max_length=MAX_DELETE_CHECK_KEYS,
            description="JSON objects of primary-key values, one per row.",
        ),
    ],
) -> DeleteCheckOut:
    table = table_or_404(policy, table_name)
    with http_errors():
        keys = [parse_record_key(table, raw) for raw in key]
    check = check_delete(session, policy, table, keys)
    return DeleteCheckOut(
        rows=check.rows,
        allowed=check.allowed,
        blockers=check.blockers,
        effects=[
            DeleteEffectOut(
                table=effect.table,
                column=effect.column,
                action=effect.action.value,
                count=effect.count,
                depth=effect.depth,
            )
            for effect in check.effects
        ],
    )
