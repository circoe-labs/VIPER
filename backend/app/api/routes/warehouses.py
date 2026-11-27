"""Protected warehouse directory and its dedicated workbook import."""

import re
import uuid
from datetime import UTC, date, datetime
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors, refusal
from app.api.query_types import Department, Many
from app.core.actor import ActorType
from app.models import Warehouse, WarehouseDraft
from app.repositories.list_sort import EntitySort
from app.services import audit, eligibility, warehouse_import, warehouses
from app.services.errors import InvalidFieldError
from app.services.warehouse_draft_text import apply_category
from app.services.warehouses import WarehouseCounts, WarehouseInput, WarehouseOut, WarehousePage

router = APIRouter(prefix="/warehouses", tags=["warehouses"])


class WarehouseDraftOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    phase: int
    prospecting_category: Literal['sme', 'other'] | None = None
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
    human_validated: bool
    scheduled_at: datetime | None
    send_state: str | None
    recovery_possible: bool
    failure_code: str | None
    failed_at: datetime | None


@router.get("/drafts", response_model=list[WarehouseDraftOut])
def list_drafts(session: SessionDep) -> list[WarehouseDraftOut]:
    return [
        WarehouseDraftOut.model_validate(draft).model_copy(update={"prospecting_category": category})
        for draft, category in session.execute(
            select(WarehouseDraft, Warehouse.prospecting_category)
            .join(Warehouse, Warehouse.id == WarehouseDraft.warehouse_id)
            .order_by(
                WarehouseDraft.warehouse_name, WarehouseDraft.contact_name, WarehouseDraft.id
            )
        )
    ]


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


class WarehouseDraftBatchRecovery(BaseModel):
    scheduled_at: AwareDatetime
    confirmed_not_sent: Literal[True]
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


def refuse_blocked(session: SessionDep, draft: WarehouseDraft) -> None:
    """A mail to someone, or a company, removed from prospecting is not prepared to leave."""
    block = eligibility.warehouse_block(session, draft)
    if block is not None:
        raise refusal(
            409, block.value, f"Envoi impossible : {eligibility.LABELS[block].lower()}."
        )


@router.put("/drafts/{draft_id}", response_model=WarehouseDraftOut)
def edit_draft(
    draft_id: uuid.UUID, body: WarehouseDraftEdit, session: SessionDep, actor: CurrentActor
) -> WarehouseDraft:
    draft = locked_draft(session, draft_id, body.revision)
    if draft.send_state in ("sending", "uncertain", "sent"):
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
    if draft.send_state == "scheduled" and not recipient:
        raise HTTPException(422, "Un message programmé doit avoir un destinataire valide.")
    warehouse = session.get(Warehouse, draft.warehouse_id)
    new_body = apply_category(body.body.strip(), warehouse.prospecting_category if warehouse else None)
    if (draft.recipient != (recipient or None) or draft.subject != body.subject.strip() or draft.body != new_body):
        draft.human_validated = False
        if draft.send_state == "scheduled":
            draft.send_state = "planned"
    draft.recipient = recipient or None
    draft.subject = body.subject.strip()
    draft.body = new_body
    draft.validated_at = datetime.now(UTC) if draft.send_state == "scheduled" else None
    draft.validated_by = actor.display if draft.send_state == "scheduled" else None
    if draft.send_state not in ("planned", "scheduled"):
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
    if draft.send_state in ("sending", "uncertain", "sent"):
        raise HTTPException(409, "Ce message ne peut pas être validé dans son état actuel.")
    if draft.send_state not in ("planned", "scheduled"):
        raise HTTPException(422, "Préprogrammez ce brouillon avant de le valider.")
    if not draft.recipient or not draft.subject.strip() or not draft.body.strip():
        raise HTTPException(422, "Choisissez un destinataire et complétez l’objet et le message.")
    refuse_blocked(session, draft)
    warehouse = session.get(Warehouse, draft.warehouse_id)
    content = draft.body.casefold()
    if not warehouse or warehouse.prospecting_category not in ("sme", "other"):
        raise HTTPException(422, "Classez d’abord l’entrepôt dans une catégorie de prospection.")
    if ("dihnamo" in content) != (warehouse.prospecting_category == "sme"):
        raise HTTPException(422, "Vérifiez la mention DIHNAMO selon la catégorie de l’entrepôt.")
    if draft.send_state == "planned":
        if draft.scheduled_at is None or draft.scheduled_at <= datetime.now(UTC):
            raise HTTPException(422, "Choisissez une date de programmation future avant validation.")
        draft.send_state = "scheduled"
    draft.validated_at = datetime.now(UTC)
    draft.validated_by = actor.display
    if actor.type == ActorType.HUMAN:
        draft.human_validated = True
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
    refuse_blocked(session, draft)
    if not draft.human_validated:
        raise HTTPException(422, "Validez d’abord ce message individuellement.")
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
    draft.failure_code = draft.failed_at = None
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


@router.post("/drafts/plan-batch")
def plan_draft_batch(
    body: WarehouseDraftBatchSchedule, session: SessionDep, actor: CurrentActor
) -> dict[str, int]:
    if body.scheduled_at <= datetime.now(UTC):
        raise HTTPException(422, "Choisissez une date et une heure futures.")
    ids = [item.id for item in body.drafts]
    if len(set(ids)) != len(ids):
        raise HTTPException(422, "Un brouillon apparaît plusieurs fois.")
    expected = {item.id: item.revision for item in body.drafts}
    drafts = list(session.scalars(
        select(WarehouseDraft).where(WarehouseDraft.id.in_(ids))
        .order_by(WarehouseDraft.id).with_for_update()
    ))
    if len(drafts) != len(ids) or any(
        d.revision != expected[d.id] or d.send_state not in (None, "planned", "scheduled", "failed")
        for d in drafts
    ):
        raise HTTPException(409, "Un brouillon a changé ou ne peut pas être préprogrammé.")
    for draft in drafts:
        refuse_blocked(session, draft)
    for draft in drafts:
        draft.scheduled_at = body.scheduled_at
        draft.send_state = "planned"
        draft.failure_code = draft.failed_at = None
        draft.validated_at = None
        draft.validated_by = None
        draft.human_validated = False
        draft.revision += 1
        audit.record_event(session, actor, "warehouse_draft.planned", entity_type="warehouse_draft", entity_id=draft.id)
    return {"scheduled": len(drafts)}


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
        refuse_blocked(session, draft)
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
            not draft.human_validated
            or
            not draft.recipient
            or not re.fullmatch(r"[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+", draft.recipient)
            or not draft.subject.strip()
            or not draft.body.strip()
        ):
            raise HTTPException(
                422, "Un brouillon ne contient pas une adresse et un message valides."
            )
    for draft in drafts:
        draft.validated_at = datetime.now(UTC)
        draft.validated_by = actor.display
        draft.scheduled_at = body.scheduled_at
        draft.send_state = "scheduled"
        draft.remote_draft_id = None
        draft.failure_code = draft.failed_at = None
        draft.revision += 1
        audit.record_event(
            session,
            actor,
            "warehouse_draft.scheduled",
            entity_type="warehouse_draft",
            entity_id=draft.id,
        )
    return {"scheduled": len(drafts)}


@router.post("/drafts/recover-batch")
def recover_uncertain_draft_batch(
    body: WarehouseDraftBatchRecovery, session: SessionDep, actor: CurrentActor
) -> dict[str, int]:
    """Reprogram approved mails only after a person confirms the mailbox check.

    Unknown sends with a saved remote draft id stay locked: they need individual reconciliation.
    """
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
        refuse_blocked(session, draft)
        if draft.revision != expected[draft.id] or not draft.recovery_possible:
            raise HTTPException(
                409,
                "Un brouillon ne peut plus être repris sans vérification. Rechargez la liste.",
            )
        if (
            not draft.recipient
            or not re.fullmatch(r"[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+", draft.recipient)
            or not draft.subject.strip()
            or not draft.body.strip()
        ):
            raise HTTPException(422, "Un brouillon ne contient pas une adresse et un message valides.")
    for draft in drafts:
        draft.scheduled_at = body.scheduled_at
        draft.send_state = "scheduled"
        draft.failure_code = draft.failed_at = None
        draft.revision += 1
        audit.record_event(
            session,
            actor,
            "warehouse_draft.scheduled",
            entity_type="warehouse_draft",
            entity_id=draft.id,
            reason="Reprogrammé après confirmation humaine de l’absence dans les envoyés et brouillons Infomaniak.",
        )
    return {"scheduled": len(drafts)}


@router.post("/drafts/{draft_id}/unschedule", response_model=WarehouseDraftOut)
def unschedule_draft(
    draft_id: uuid.UUID, body: WarehouseDraftValidation, session: SessionDep, actor: CurrentActor
) -> WarehouseDraft:
    draft = locked_draft(session, draft_id, body.revision)
    if draft.send_state not in ("scheduled", "planned"):
        raise HTTPException(409, "La programmation ne peut plus être retirée ; vérifiez son état.")
    draft.scheduled_at = None
    draft.send_state = None
    draft.failure_code = draft.failed_at = None
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
    category: Many[Literal['sme', 'other', 'unclassified']] = None,
    sort: EntitySort = EntitySort.NAME,
    status: Many[Literal['verified', 'usable', 'incomplete']] = None,
    department: Many[Department] = None,
    created_from: date | None = None,
    created_to: date | None = None,
) -> WarehousePage:
    """`sort`: name (A-Z, default), created (newest first) or updated (newest first); ties by id.
    `status`: the file status (verified / usable / incomplete), computed from the record.
    The filters may be repeated: any of one filter's values (OR), the filters combined with AND."""
    with business_errors():
        if created_from is not None and created_to is not None and created_to < created_from:
            raise InvalidFieldError(
                "created_to", "The end must not precede the start.", "before_start"
            )
        return warehouses.list_warehouses(
            session,
            q,
            limit,
            offset,
            to_contact,
            category or (),
            sort,
            status or (),
            department or (),
            created_from,
            created_to,
        )


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
    # Parsing and database work block: off the event loop, which every other request needs.
    with business_errors():
        result = await run_in_threadpool(warehouse_import.preview, content, filename)
    known = await run_in_threadpool(warehouse_import.existing_keys, session)
    result.existing = sum(warehouse_import.key(item.name) in known for item in result.items)
    return result


@router.post("/import")
async def import_warehouses(
    request: Request, session: SessionDep, actor: CurrentActor
) -> warehouse_import.ImportResult:
    content, filename = await uploaded(request)
    with business_errors():
        return await run_in_threadpool(
            warehouse_import.import_workbook, session, actor, content, filename
        )


@router.get("/counts")
def count_warehouses(session: SessionDep) -> WarehouseCounts:
    return warehouses.count_warehouses(session)


@router.get("/{warehouse_id}")
def get_warehouse(warehouse_id: uuid.UUID, session: SessionDep) -> WarehouseOut:
    with business_errors():
        return warehouses.present(session, warehouses.get_warehouse(session, warehouse_id))


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
