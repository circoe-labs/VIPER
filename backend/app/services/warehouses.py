"""Audited warehouse directory. Source contacts are never silently validated or enrolled."""

import hashlib
import json
import uuid
from datetime import UTC

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import Text, cast, func, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models import Warehouse
from app.repositories.taxonomies import label_key, matches_words
from app.services import audit
from app.services.companies import normalize_siret
from app.services.errors import ConflictError, NotFoundError


class WarehouseContact(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    full_name: str = Field(min_length=1, max_length=500)
    role: str | None = Field(default=None, max_length=1000)
    email: str | None = Field(default=None, max_length=2000)
    linkedin: str | None = Field(default=None, max_length=2000)


class WarehouseInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=500)
    owner_name: str | None = Field(default=None, max_length=500)
    owner_role: str | None = Field(default=None, max_length=1000)
    owner_email: str | None = Field(default=None, max_length=2000)
    owner_linkedin: str | None = Field(default=None, max_length=2000)
    address: str | None = Field(default=None, max_length=2000)
    postal_code: str | None = Field(default=None, max_length=16)
    city: str | None = Field(default=None, max_length=255)
    siret: str | None = Field(default=None, max_length=32)
    notes: str | None = Field(default=None, max_length=10000)
    contacts: list[WarehouseContact] = Field(default_factory=list, max_length=200)


class WarehouseOut(WarehouseInput):
    id: uuid.UUID
    version: str
    source_reference: str | None


class WarehousePage(BaseModel):
    items: list[WarehouseOut]
    total: int


def version(row: Warehouse) -> str:
    values = {field: getattr(row, field) for field in WarehouseInput.model_fields}
    values["updated_at"] = row.updated_at.astimezone(UTC).isoformat()
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()[:32]


def present(row: Warehouse) -> WarehouseOut:
    return WarehouseOut(
        **{key: getattr(row, key) for key in WarehouseInput.model_fields},
        id=row.id,
        version=version(row),
        source_reference=row.source_reference,
    )


def list_warehouses(
    session: Session, search: str = "", limit: int = 50, offset: int = 0
) -> WarehousePage:
    text = func.concat_ws(
        " ",
        Warehouse.name,
        Warehouse.owner_name,
        Warehouse.owner_role,
        Warehouse.city,
        Warehouse.postal_code,
        Warehouse.address,
        Warehouse.siret,
        cast(Warehouse.contacts, Text),
    )
    conditions = matches_words(text, search.strip()) if search.strip() else []
    total = session.scalar(select(func.count()).select_from(Warehouse).where(*conditions)) or 0
    rows = session.scalars(
        select(Warehouse)
        .where(*conditions)
        .order_by(label_key(Warehouse.name), Warehouse.id)
        .limit(limit)
        .offset(offset)
    )
    return WarehousePage(items=[present(row) for row in rows], total=total)


def get_warehouse(session: Session, warehouse_id: uuid.UUID, *, lock: bool = False) -> Warehouse:
    statement = select(Warehouse).where(Warehouse.id == warehouse_id)
    row = session.scalar(statement.with_for_update() if lock else statement)
    if row is None:
        raise NotFoundError("Warehouse not found.")
    return row


def save_warehouse(
    session: Session,
    actor: ActorContext,
    data: WarehouseInput,
    warehouse_id: uuid.UUID | None = None,
    expected_version: str | None = None,
    *,
    source_reference: str | None = None,
    source_key: str | None = None,
) -> WarehouseOut:
    row = get_warehouse(session, warehouse_id, lock=True) if warehouse_id else Warehouse()
    if warehouse_id and version(row) != expected_version:
        raise ConflictError("The warehouse changed since it was opened.")
    values = data.model_dump()
    values["siret"] = normalize_siret(
        "siret", data.siret, current=row.siret if warehouse_id else None
    )
    for key, value in values.items():
        setattr(row, key, value if value != "" else None)
    if not warehouse_id:
        row.source_reference, row.source_key = source_reference, source_key
        session.add(row)
    audit.annotate(session, actor, row)
    session.flush()
    session.refresh(row)
    return present(row)
