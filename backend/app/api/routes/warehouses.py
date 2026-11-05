"""Protected warehouse directory and its dedicated workbook import."""

import uuid
from typing import Annotated

from fastapi import APIRouter, Query, Request
from pydantic import Field
from starlette.datastructures import UploadFile

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors, refusal
from app.services import warehouse_import, warehouses
from app.services.warehouses import WarehouseInput, WarehouseOut, WarehousePage

router = APIRouter(prefix="/warehouses", tags=["warehouses"])


class WarehouseReplace(WarehouseInput):
    version: str = Field(min_length=1, max_length=64)


@router.get("")
def list_warehouses(
    session: SessionDep,
    q: Annotated[str, Query(max_length=200)] = "",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> WarehousePage:
    return warehouses.list_warehouses(session, q, limit, offset)


@router.post("", status_code=201)
def create_warehouse(
    body: WarehouseInput, session: SessionDep, actor: CurrentActor
) -> WarehouseOut:
    with business_errors():
        return warehouses.save_warehouse(session, actor, body)


async def uploaded(request: Request) -> tuple[bytes, str]:
    length = request.headers.get("content-length", "")
    if not length.isdigit() or int(length) > warehouse_import.MAX_BYTES + 65536:
        raise refusal(413, "file_too_large", "Le fichier doit faire moins de 16 Mo.")
    async with request.form(max_files=1, max_fields=0) as form:
        file = form.get("file")
        if not isinstance(file, UploadFile):
            raise refusal(422, "invalid", "Choisissez un fichier Excel.")
        return await file.read(warehouse_import.MAX_BYTES + 1), file.filename or "import.xlsx"


@router.post("/import-preview")
async def preview_import(request: Request, session: SessionDep) -> warehouse_import.ImportPreview:
    content, filename = await uploaded(request)
    with business_errors():
        result = warehouse_import.preview(content, filename)
    known = warehouse_import.existing_keys(session)
    result.existing = sum(warehouse_import.key(item.name) in known for item in result.items)
    return result


@router.post("/import")
async def import_warehouses(
    request: Request, session: SessionDep, actor: CurrentActor
) -> warehouse_import.ImportResult:
    content, filename = await uploaded(request)
    with business_errors():
        return warehouse_import.import_workbook(session, actor, content, filename)


@router.get("/{warehouse_id}")
def get_warehouse(warehouse_id: uuid.UUID, session: SessionDep) -> WarehouseOut:
    with business_errors():
        return warehouses.present(warehouses.get_warehouse(session, warehouse_id))


@router.put("/{warehouse_id}")
def update_warehouse(
    warehouse_id: uuid.UUID, body: WarehouseReplace, session: SessionDep, actor: CurrentActor
) -> WarehouseOut:
    with business_errors():
        return warehouses.save_warehouse(
            session,
            actor,
            WarehouseInput.model_validate(body.model_dump(exclude={"version"})),
            warehouse_id,
            body.version,
        )
