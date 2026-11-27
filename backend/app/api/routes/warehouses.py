"""Protected warehouse directory and its dedicated workbook import."""

import uuid
from datetime import UTC, date, datetime, timedelta
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from app.api.dependencies import CurrentActor, SessionDep
from app.api.errors import business_errors, refusal
from app.api.query_types import Department, Many
from app.api.routes.email_identity import IdentityDoubtOut
from app.core.actor import ActorType
from app.models import WarehouseDraft
from app.models.enums import Civility
from app.repositories.list_sort import EntitySort
from app.services import (
    audit,
    email_identity,
    prospects,
    warehouse_history,
    warehouse_import,
    warehouse_people,
    warehouses,
)
from app.services.errors import InvalidFieldError
from app.services.warehouses import WarehouseCounts, WarehouseInput, WarehouseOut, WarehousePage

router = APIRouter(prefix="/warehouses", tags=["warehouses"])
# A mail still « being sent » this long after its moment is settled by a person.
STALE_SENDING = timedelta(minutes=15)


class WarehouseDraftOut(BaseModel):
    """A mail of the former warehouse pipeline: history, or still programmed."""

    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    warehouse_id: uuid.UUID
    prospect_id: uuid.UUID | None
    phase: int
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
    sent_at: datetime | None
    failure_code: str | None
    failed_at: datetime | None
    # The recipient looks like someone else's (`email_identity`): nothing can be sent.
    identity_doubt: IdentityDoubtOut | None = None


def drafts_out(session: SessionDep, drafts: list[WarehouseDraft]) -> list[WarehouseDraftOut]:
    doubts = email_identity.warehouse_doubts(
        session, [draft for draft in drafts if draft.send_state != "sent"]
    )
    return [
        WarehouseDraftOut.model_validate(draft).model_copy(
            update={
                "identity_doubt": IdentityDoubtOut.model_validate(doubts[draft.id])
                if draft.id in doubts
                else None
            }
        )
        for draft in drafts
    ]


@router.get("/drafts")
def list_drafts(
    session: SessionDep, prospect_id: uuid.UUID | None = None
) -> list[WarehouseDraftOut]:
    """Every warehouse mail, or one prospect's (`warehouse_history.mails_of`)."""
    if prospect_id is not None:
        with business_errors():
            prospects.get_prospect(session, prospect_id)
        return drafts_out(session, warehouse_history.mails_of(session, prospect_id))
    rows = session.scalars(
        select(WarehouseDraft).order_by(
            WarehouseDraft.warehouse_name, WarehouseDraft.contact_name, WarehouseDraft.id
        )
    )
    return drafts_out(session, list(rows))


class WarehouseDraftRevision(BaseModel):
    revision: int = Field(ge=1)


class WarehouseDraftResolution(WarehouseDraftRevision):
    # What the person saw in the mailbox: the mail is in the sent items, or it is not.
    sent: bool


def locked_draft(session: SessionDep, draft_id: uuid.UUID, revision: int) -> WarehouseDraft:
    draft = session.scalar(
        select(WarehouseDraft).where(WarehouseDraft.id == draft_id).with_for_update()
    )
    if draft is None:
        raise HTTPException(404, "Brouillon introuvable.")
    if draft.revision != revision:
        raise HTTPException(409, "Ce mail a changé. Rechargez avant de continuer.")
    return draft


@router.get("/drafts/dispatch-status")
def warehouse_dispatch_status(request: Request) -> dict[str, bool]:
    dispatcher = request.app.state.contact_dispatcher
    return {"active": dispatcher is not None and dispatcher.status().active}


@router.post("/drafts/{draft_id}/unschedule")
def unschedule_draft(
    draft_id: uuid.UUID, body: WarehouseDraftRevision, session: SessionDep, actor: CurrentActor
) -> WarehouseDraftOut:
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
    return drafts_out(session, [draft])[0]


@router.post("/drafts/{draft_id}/resolve")
def resolve_draft(
    draft_id: uuid.UUID, body: WarehouseDraftResolution, session: SessionDep, actor: CurrentActor
) -> WarehouseDraftOut:
    """A person settles a mail whose send is unknown, after looking in the mailbox. Nothing is
    ever sent again: a mail that did not leave is written again from Contact."""
    draft = locked_draft(session, draft_id, body.revision)
    now = datetime.now(UTC)
    stale = (
        draft.send_state == "sending"
        and draft.scheduled_at is not None
        and now - draft.scheduled_at > STALE_SENDING
    )
    if actor.type != ActorType.HUMAN:
        raise HTTPException(403, "Une personne doit vérifier la boîte d’envoi.")
    if draft.send_state != "uncertain" and not stale:
        raise HTTPException(409, "L’état de cet envoi n’est pas à vérifier. Rechargez la liste.")
    if body.sent:
        draft.send_state = "sent"
        draft.sent_at = draft.failed_at or draft.scheduled_at or now
        draft.failure_code = draft.failed_at = None
    else:
        draft.send_state = "failed"
        draft.failure_code = "confirmed_not_sent"
        draft.failed_at = now
    draft.revision += 1
    session.flush()
    audit.record_event(
        session,
        actor,
        "warehouse_draft.resolved",
        entity_type="warehouse_draft",
        entity_id=draft.id,
        reason="sent" if body.sent else "not_sent",
    )
    if body.sent and draft.prospect_id is not None:
        warehouse_history.carry(session, actor, draft.prospect_id, now=now)
    return drafts_out(session, [draft])[0]


class CandidateOut(BaseModel):
    prospect_id: uuid.UUID
    first_name: str
    last_name: str
    company_name: str | None
    reasons: list[str]
    block: str | None


class PersonStateOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    block: str | None
    tracking: str | None
    cohort_code: str | None
    sequence_open: bool
    sent_count: int
    last_sent_at: datetime | None
    next_scheduled_at: datetime | None
    warehouse_pending: bool
    warehouse_uncounted: int


class LinkedProspectOut(BaseModel):
    id: uuid.UUID
    first_name: str
    last_name: str
    company_name: str | None


class WarehousePersonOut(BaseModel):
    contact_name: str
    kind: warehouse_people.Kind
    role: str | None
    emails: list[str]
    status: warehouse_people.Status
    first_name: str
    last_name: str
    civility: Civility | None
    candidates: list[CandidateOut]
    prospect: LinkedProspectOut | None
    state: PersonStateOut | None


class WarehousePeopleOut(BaseModel):
    company_id: uuid.UUID | None
    company_name: str | None
    people: list[WarehousePersonOut]


def person_out(row: warehouse_people.PersonRow) -> WarehousePersonOut:
    found = row.prospect
    return WarehousePersonOut(
        contact_name=row.entry.contact_name,
        kind=row.entry.kind,
        role=row.entry.role,
        emails=row.entry.addresses,
        status=row.status,
        first_name=row.suggested.first_name,
        last_name=row.suggested.last_name,
        civility=row.suggested.civility,
        candidates=[
            CandidateOut(
                prospect_id=c.person.id,
                first_name=c.person.first_name,
                last_name=c.person.last_name,
                company_name=c.person.company_name,
                reasons=list(c.reasons),
                block=block,
            )
            for c, block in row.candidates
        ],
        prospect=LinkedProspectOut(
            id=found.id,
            first_name=found.first_name,
            last_name=found.last_name,
            company_name=found.company_name,
        )
        if found
        else None,
        state=PersonStateOut.model_validate(row.state) if row.state else None,
    )


class NewPersonIn(BaseModel):
    first_name: str = Field(max_length=500)
    last_name: str = Field(max_length=500)
    civility: Civility | None = None
    company_id: uuid.UUID


class LinkPersonIn(BaseModel):
    """Exactly one of `prospect_id` (an existing record) or `create`."""

    contact_name: str = Field(min_length=1, max_length=500)
    prospect_id: uuid.UUID | None = None
    create: NewPersonIn | None = None
    # « C’est une autre personne » for the look-alikes in the base.
    distinct_confirmed: bool = False

    @model_validator(mode="after")
    def one_choice(self) -> LinkPersonIn:
        if (self.prospect_id is None) == (self.create is None):
            raise ValueError("Give either prospect_id or create.")
        return self


class LinkPersonOut(BaseModel):
    prospect_id: uuid.UUID


@router.get("/{warehouse_id}/people")
def list_people(warehouse_id: uuid.UUID, session: SessionDep) -> WarehousePeopleOut:
    """The listing's people: linked prospects with their Contact state, the others with the
    records they may be."""
    with business_errors():
        found = warehouse_people.read(session, warehouse_id)
    return WarehousePeopleOut(
        company_id=found.company_id,
        company_name=found.company_name,
        people=[person_out(row) for row in found.people],
    )


@router.post("/{warehouse_id}/people")
def link_person(
    warehouse_id: uuid.UUID, body: LinkPersonIn, session: SessionDep, actor: CurrentActor
) -> LinkPersonOut:
    with business_errors():
        if body.prospect_id is not None:
            prospect_id = warehouse_people.link(
                session, actor, warehouse_id, body.contact_name, body.prospect_id
            )
        else:
            assert body.create is not None
            prospect_id = warehouse_people.create(
                session,
                actor,
                warehouse_id,
                body.contact_name,
                warehouse_people.NewPerson(**body.create.model_dump()),
                distinct_confirmed=body.distinct_confirmed,
            )
    return LinkPersonOut(prospect_id=prospect_id)


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
