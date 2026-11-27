"""Excel import API (`/api/imports`, Task 09, ADR-0012).

Stateless review: the browser keeps the file and sends it with every request.

- `POST /imports/preview` — multipart `file` (+ optional `options` JSON: layout mapping and cell
  corrections) → the review (preview, groups to resolve, defaults, digest) and the committed
  imports of the same file (re-import warning).
- `POST /imports/analyze` — multipart `file`: the import agent (AI) reads the workbook and returns
  its reading plan, to send back as `mapping.plan`. Nothing is written; the file's content goes to
  the configured AI service. Refusals `ai_*` (503 not configured, 502/504 service).
- `POST /imports/commit` — multipart `file` + `decisions` JSON (cohort dates and « Fichier vérifié
  humainement » included) → the committed batch and counts: entities, cohorts, sequences and
  imported sends, « Défaillant », alerts (`import_commit`, `operational_import`).
- `GET /imports/{id}/cancellation` — what cancelling the import would remove and keep (nothing
  written); `POST /imports/{id}/cancel` does it (`import_cancel`). An administrator or the person
  who imported (403 `forbidden`); 422 when the import is not committed.
- `GET /imports`, `GET /imports/{id}` — the import history (metadata only, never file content).

The multipart body is parsed inside the route, after the session/CSRF guard and a size check on
`Content-Length` (FastAPI would parse declared form parameters before any dependency). Refusals
carry a stable `detail.code`: `file_rejected` (with the engine's French `diagnostic`, 413 for size),
`length_required` (411), `invalid_request` (422, schema errors without their input values),
`file_changed` / `preview_outdated` / `reimport_not_acknowledged` (409), `invalid_decisions`
(422, with the plan's errors), `duplicate` (409, a role/category to create exists),
`commit_failed` (500, or 422 when a value was refused; a `failed` batch records the attempt and
nothing was imported).
"""

import uuid
from datetime import datetime
from functools import partial
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError
from sqlalchemy.orm import Session
from starlette.datastructures import UploadFile

from app.api.dependencies import (
    AuthDep,
    Authenticated,
    CurrentActor,
    SessionDep,
    SettingsDep,
)
from app.api.errors import business_errors, refusal
from app.core.actor import ActorType
from app.models.enums import ImportBatchStatus
from app.models.imports import ImportBatch
from app.models.organizations import OrganizationRole
from app.services import import_batches, import_cancel, import_commit
from app.services.imports import agent
from app.services.imports.decisions import ImportDecisions, PreviewOptions
from app.services.imports.diagnostics import DiagnosticCode, ImportRejectedError
from app.services.imports.plan import ImportPlanSpec
from app.services.imports.preview import ImportFile
from app.services.imports.review import ImportReview
from app.services.imports.workbook import ImportLimits

router = APIRouter(prefix="/imports", tags=["imports"])

# Room for the multipart framing and the JSON part (decisions for thousands of rows).
JSON_PART_MAX_BYTES = 2 * 1024 * 1024
HISTORY_MAX_LIMIT = 200


class BatchOut(BaseModel):
    id: uuid.UUID
    filename: str
    sheet_names: list[str]
    status: ImportBatchStatus
    created_at: datetime
    committed_at: datetime | None
    actor_type: ActorType
    actor_display: str
    rows_total: int
    rows_imported: int
    rows_skipped: int
    legal_basis_or_collection_context: str | None
    source_reference: str | None


class BatchDetailOut(BatchOut):
    rows_traced: int  # import_row_metadata rows
    prospect_count: int  # distinct prospects created or completed
    company_count: int


class PreviewOut(BaseModel):
    review: ImportReview
    # Committed imports of the same file (same SHA-256), newest first.
    previous_imports: list[BatchOut]


class CommitOut(BaseModel):
    batch: BatchOut
    counts: dict[str, int]


class AnalyzeOut(BaseModel):
    plan: ImportPlanSpec
    model: str


def batch_out(batch: ImportBatch) -> BatchOut:
    return BatchOut.model_validate(batch, from_attributes=True)


def file_refusal(error: ImportRejectedError, status_code: int = 422) -> HTTPException:
    return refusal(
        status_code,
        "file_rejected",
        error.diagnostic.message,
        diagnostic=error.diagnostic.model_dump(mode="json"),
    )


def invalid_request(error: ValidationError) -> HTTPException:
    # Locations and types only: input values may be personal data.
    errors = [{"loc": list(item["loc"]), "type": item["type"]} for item in error.errors()]
    return refusal(
        status.HTTP_422_UNPROCESSABLE_CONTENT,
        "invalid_request",
        "Malformed import request.",
        errors=errors,
    )


async def read_upload[Model: BaseModel](
    request: Request, limits: ImportLimits, part: str, model: type[Model], *, required: bool
) -> tuple[ImportFile, Model]:
    """The uploaded file and the JSON part `part`, bounded before anything is parsed."""
    length = request.headers.get("content-length")
    if length is None or not length.isdigit():
        raise refusal(status.HTTP_411_LENGTH_REQUIRED, "length_required", "Content-Length needed.")
    if int(length) > limits.max_file_bytes + JSON_PART_MAX_BYTES:
        too_large = ImportRejectedError(
            DiagnosticCode.FILE_TOO_LARGE, limit_mb=limits.max_file_bytes // (1024 * 1024)
        )
        raise file_refusal(too_large, status.HTTP_413_CONTENT_TOO_LARGE)
    async with request.form(max_files=1, max_fields=1, max_part_size=JSON_PART_MAX_BYTES) as form:
        upload = form.get("file")
        raw = form.get(part)
        if not isinstance(upload, UploadFile):
            raise file_refusal(ImportRejectedError(DiagnosticCode.FILE_EMPTY))
        content = await upload.read()
        filename = upload.filename or "import"
    if not isinstance(raw, str | None) or (required and raw is None):
        raise refusal(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_request", f"`{part}` is required."
        )
    try:
        data = model.model_validate_json(raw) if raw else model.model_validate({})
    except ValidationError as error:
        raise invalid_request(error) from None
    return ImportFile(filename, content), data


@router.post("/preview")
async def preview_import(
    request: Request, session: SessionDep, settings: SettingsDep
) -> PreviewOut:
    """Analyse an uploaded file: nothing is written."""
    limits = ImportLimits.from_settings(settings)
    file, options = await read_upload(request, limits, "options", PreviewOptions, required=False)
    try:
        review, previous = await run_in_threadpool(
            import_commit.review_upload, session, file, options, limits
        )
    except ImportRejectedError as error:
        raise file_refusal(error) from None
    return PreviewOut(review=review, previous_imports=[batch_out(batch) for batch in previous])


@router.post("/analyze")
async def analyze_import(
    request: Request, session: SessionDep, settings: SettingsDep
) -> AnalyzeOut:
    """The import agent's reading of an uploaded file: nothing is written."""
    limits = ImportLimits.from_settings(settings)
    file, _ = await read_upload(request, limits, "options", PreviewOptions, required=False)
    # The analysis can last minutes: the authentication's transaction ends here.
    session.commit()
    try:
        with business_errors():
            answer = await run_in_threadpool(
                partial(
                    agent.analyze,
                    file.filename,
                    file.content,
                    settings,
                    limits,
                    transport=request.app.state.openai_transport,
                )
            )
    except ImportRejectedError as error:
        raise file_refusal(error) from None
    return AnalyzeOut(plan=answer.plan, model=answer.model)


@router.post("/commit", response_model=CommitOut)
async def commit_import(
    request: Request, session: SessionDep, settings: SettingsDep, actor: CurrentActor
) -> Response | CommitOut:
    """Apply the reviewed decisions in one transaction (see the module docstring)."""
    limits = ImportLimits.from_settings(settings)
    file, decisions = await read_upload(
        request, limits, "decisions", ImportDecisions, required=True
    )
    try:
        with business_errors():
            result = await run_in_threadpool(
                import_commit.commit_import, session, actor, file, decisions, limits
            )
    except ImportRejectedError as error:
        raise file_refusal(error) from None
    except import_commit.StalePreviewError as error:
        raise refusal(status.HTTP_409_CONFLICT, error.code, str(error)) from None
    except import_commit.ReimportNotAcknowledgedError as error:
        previous = [batch_out(batch).model_dump(mode="json") for batch in error.previous]
        raise refusal(
            status.HTTP_409_CONFLICT, "reimport_not_acknowledged", str(error), previous=previous
        ) from None
    except import_commit.InvalidDecisionsError as error:
        errors = [item.model_dump(mode="json") for item in error.errors]
        raise refusal(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "invalid_decisions", str(error), errors=errors
        ) from None
    except import_commit.ImportCommitFailedError as error:
        # Returned, not raised: the request's transaction must commit the `failed` batch record.
        detail: dict[str, Any] = {
            "code": "commit_failed",
            "message": str(error),
            "batch_id": str(error.batch_id),
            "row": error.row,
            "reason": error.reason,
        }
        failed = error.reason == "invalid"
        code = status.HTTP_422_UNPROCESSABLE_CONTENT if failed else 500
        return JSONResponse(status_code=code, content={"detail": detail})
    return CommitOut(batch=batch_out(result.batch), counts=result.counts)


class CancellationOut(BaseModel):
    prospects_deleted: int
    prospects_kept: int
    companies_deleted: int
    companies_kept: int
    additions_removed: int
    fields_restored: int


def require_canceller(session: Session, auth: Authenticated, batch_id: uuid.UUID) -> None:
    """Cancelling erases data: an administrator's call, or the importer's on their own import."""
    with business_errors():
        batch = import_batches.get_batch(session, batch_id)
    user = auth.user
    if user.is_superadmin or user.role is OrganizationRole.ADMIN or batch.actor_id == str(user.id):
        return
    raise refusal(
        status.HTTP_403_FORBIDDEN,
        "forbidden",
        "Seul un administrateur ou l'auteur de l'import peut l'annuler.",
    )


@router.get("/{batch_id}/cancellation")
def preview_cancellation(
    batch_id: uuid.UUID, session: SessionDep, actor: CurrentActor, auth: AuthDep
) -> CancellationOut:
    require_canceller(session, auth, batch_id)
    with business_errors():
        result = import_cancel.preview(session, actor, batch_id)
    return CancellationOut.model_validate(result, from_attributes=True)


@router.post("/{batch_id}/cancel")
def cancel_import(
    batch_id: uuid.UUID, session: SessionDep, actor: CurrentActor, auth: AuthDep
) -> CancellationOut:
    require_canceller(session, auth, batch_id)
    with business_errors():
        result = import_cancel.cancel(session, actor, batch_id)
    return CancellationOut.model_validate(result, from_attributes=True)


@router.get("")
def list_imports(
    session: SessionDep, limit: Annotated[int, Query(ge=1, le=HISTORY_MAX_LIMIT)] = 50
) -> list[BatchOut]:
    """Import history, newest first: metadata and counts only."""
    return [batch_out(batch) for batch in import_batches.list_batches(session, limit=limit)]


@router.get("/{batch_id}")
def get_import(batch_id: uuid.UUID, session: SessionDep) -> BatchDetailOut:
    with business_errors():
        batch = import_batches.get_batch(session, batch_id)
    rows, prospects, companies = import_batches.batch_counts(session, batch.id)
    return BatchDetailOut(
        **batch_out(batch).model_dump(),
        rows_traced=rows,
        prospect_count=prospects,
        company_count=companies,
    )
