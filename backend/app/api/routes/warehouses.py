"""Protected warehouse directory and its dedicated workbook import."""

import re
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy import select
from starlette.datastructures import UploadFile

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors, refusal
from app.models import WarehouseDraft
from app.services import audit, warehouse_import, warehouses
from app.services.warehouses import WarehouseCounts, WarehouseInput, WarehouseOut, WarehousePage

router = APIRouter(prefix="/warehouses", tags=["warehouses"])


class WarehouseDraftOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    warehouse_name: str
    contact_name: str
    contact_role: str | None
    source_email: str | None
    recipient: str | None
    subject: str
    body: str
    review_note: str
    revision: int
    validated_at: datetime | None
    validated_by: str | None
    scheduled_at: datetime | None
    send_state: str | None


@router.get("/drafts", response_model=list[WarehouseDraftOut])
def list_drafts(session: SessionDep) -> list[WarehouseDraft]:
    return list(
        session.scalars(
            select(WarehouseDraft).order_by(
                WarehouseDraft.warehouse_name, WarehouseDraft.contact_name, WarehouseDraft.id
            )
        )
    )


class WarehouseDraftEdit(BaseModel):
    revision: int = Field(ge=1)
    recipient: str = Field(max_length=320)
    subject: str = Field(min_length=1, max_length=998)
    body: str = Field(min_length=1, max_length=30000)


class WarehouseDraftValidation(BaseModel):
    revision: int = Field(ge=1)


class WarehouseDraftSchedule(WarehouseDraftValidation):
    scheduled_at: AwareDatetime


class WarehouseDraftBatchItem(WarehouseDraftValidation):
    id: uuid.UUID


class WarehouseDraftBatchSchedule(BaseModel):
    scheduled_at: AwareDatetime
    drafts: list[WarehouseDraftBatchItem] = Field(min_length=1, max_length=500)


def locked_draft(session: SessionDep, draft_id: uuid.UUID, revision: int) -> WarehouseDraft:
    draft = session.scalar(
        select(WarehouseDraft).where(WarehouseDraft.id == draft_id).with_for_update()
    )
    if draft is None:
        raise HTTPException(404, "Brouillon introuvable.")
    if draft.revision != revision:
        raise HTTPException(409, "Ce brouillon a changé. Rechargez avant de continuer.")
    return draft


@router.put("/drafts/{draft_id}", response_model=WarehouseDraftOut)
def edit_draft(
    draft_id: uuid.UUID, body: WarehouseDraftEdit, session: SessionDep, actor: CurrentActor
) -> WarehouseDraft:
    draft = locked_draft(session, draft_id, body.revision)
    if draft.send_state in ("scheduled", "sending", "uncertain", "sent"):
        raise HTTPException(409, "Retirez la programmation avant de modifier ce message.")
    recipient = body.recipient.strip()
    if recipient and not re.fullmatch(r"[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+", recipient):
        raise HTTPException(422, "Renseignez une seule adresse e-mail valide.")
    if (
        not body.subject.strip()
        or not body.body.strip()
        or "\n" in body.subject
        or "\r" in body.subject
    ):
        raise HTTPException(422, "L’objet et le message sont obligatoires.")
    draft.recipient = recipient or None
    draft.subject = body.subject.strip()
    draft.body = body.body.strip()
    draft.validated_at = None
    draft.validated_by = None
    draft.send_state = None
    draft.revision += 1
    session.flush()
    audit.record_event(
        session, actor, "warehouse_draft.updated", entity_type="warehouse_draft", entity_id=draft.id
    )
    return draft


@router.post("/drafts/{draft_id}/validate", response_model=WarehouseDraftOut)
def validate_draft(
    draft_id: uuid.UUID, body: WarehouseDraftValidation, session: SessionDep, actor: CurrentActor
) -> WarehouseDraft:
    draft = locked_draft(session, draft_id, body.revision)
    if draft.send_state in ("scheduled", "sending", "uncertain", "sent"):
        raise HTTPException(409, "Ce message ne peut pas être validé dans son état actuel.")
    if not draft.recipient or not draft.subject.strip() or not draft.body.strip():
        raise HTTPException(422, "Choisissez un destinataire et complétez l’objet et le message.")
    draft.validated_at = datetime.now(UTC)
    draft.validated_by = actor.display
    draft.revision += 1
    session.flush()
    audit.record_event(
        session,
        actor,
        "warehouse_draft.validated",
        entity_type="warehouse_draft",
        entity_id=draft.id,
    )
    return draft


@router.get("/drafts/dispatch-status")
def warehouse_dispatch_status(request: Request) -> dict[str, bool]:
    dispatcher = request.app.state.contact_dispatcher
    return {"active": dispatcher is not None and dispatcher.status().active}


@router.post("/drafts/{draft_id}/schedule", response_model=WarehouseDraftOut)
def schedule_draft(
    draft_id: uuid.UUID, body: WarehouseDraftSchedule, session: SessionDep, actor: CurrentActor
) -> WarehouseDraft:
    draft = locked_draft(session, draft_id, body.revision)
    if draft.send_state in ("scheduled", "sending", "uncertain", "sent"):
        raise HTTPException(409, "Ce message est déjà programmé ou son envoi doit être vérifié.")
    if (
        not draft.recipient
        or not re.fullmatch(r"[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+", draft.recipient)
        or not draft.subject.strip()
        or not draft.body.strip()
    ):
        raise HTTPException(422, "Vérifiez le destinataire, l’objet et le message.")
    if body.scheduled_at <= datetime.now(UTC):
        raise HTTPException(422, "Choisissez une date et une heure futures.")
    draft.validated_at = datetime.now(UTC)
    draft.validated_by = actor.display
    draft.scheduled_at = body.scheduled_at
    draft.send_state = "scheduled"
    draft.remote_draft_id = None
    draft.revision += 1
    session.flush()
    audit.record_event(
        session,
        actor,
        "warehouse_draft.scheduled",
        entity_type="warehouse_draft",
        entity_id=draft.id,
    )
    return draft


@router.post("/drafts/schedule-batch")
def schedule_draft_batch(
    body: WarehouseDraftBatchSchedule, session: SessionDep, actor: CurrentActor
) -> dict[str, int]:
    if body.scheduled_at <= datetime.now(UTC):
        raise HTTPException(422, "Choisissez une date et une heure futures.")
    ids = [item.id for item in body.drafts]
    if len(set(ids)) != len(ids):
        raise HTTPException(422, "Un brouillon apparaît plusieurs fois.")
    expected = {item.id: item.revision for item in body.drafts}
    drafts = list(
        session.scalars(
            select(WarehouseDraft)
            .where(WarehouseDraft.id.in_(ids))
            .order_by(WarehouseDraft.id)
            .with_for_update()
        )
    )
    if len(drafts) != len(ids):
        raise HTTPException(409, "Un brouillon est introuvable. Rechargez la liste.")
    for draft in drafts:
        if draft.revision != expected[draft.id] or draft.send_state in (
            "scheduled",
            "sending",
            "uncertain",
            "sent",
        ):
            raise HTTPException(
                409, "Un brouillon a changé. Rechargez la liste avant de programmer."
            )
        if (
            not draft.recipient
            or not re.fullmatch(r"[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+", draft.recipient)
            or not draft.subject.strip()
            or not draft.body.strip()
        ):
            raise HTTPException(
                422, "Un brouillon ne contient pas une adresse et un message valides."
            )
    now = datetime.now(UTC)
    for draft in drafts:
        draft.validated_at = now
        draft.validated_by = actor.display
        draft.scheduled_at = body.scheduled_at
        draft.send_state = "scheduled"
        draft.remote_draft_id = None
        draft.revision += 1
        audit.record_event(
            session,
            actor,
            "warehouse_draft.scheduled",
            entity_type="warehouse_draft",
            entity_id=draft.id,
        )
    return {"scheduled": len(drafts)}


@router.post("/drafts/{draft_id}/unschedule", response_model=WarehouseDraftOut)
def unschedule_draft(
    draft_id: uuid.UUID, body: WarehouseDraftValidation, session: SessionDep, actor: CurrentActor
) -> WarehouseDraft:
    draft = locked_draft(session, draft_id, body.revision)
    if draft.send_state != "scheduled":
        raise HTTPException(409, "La programmation ne peut plus être retirée ; vérifiez son état.")
    draft.scheduled_at = None
    draft.send_state = None
    draft.revision += 1
    session.flush()
    audit.record_event(
        session,
        actor,
        "warehouse_draft.unscheduled",
        entity_type="warehouse_draft",
        entity_id=draft.id,
    )
    return draft


class WarehouseReplace(WarehouseInput):
    version: str = Field(min_length=1, max_length=64)


@router.get("")
def list_warehouses(
    session: SessionDep,
    q: Annotated[str, Query(max_length=200)] = "",
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    to_contact: bool = False,
) -> WarehousePage:
    return warehouses.list_warehouses(session, q, limit, offset, to_contact)


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


@router.get("/counts")
def count_warehouses(session: SessionDep) -> WarehouseCounts:
    return warehouses.count_warehouses(session)


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
