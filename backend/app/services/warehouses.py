"""Audited warehouse directory. Source contacts are never silently validated or enrolled: a
person becomes a prospect through `services/warehouse_people`."""

import hashlib
import json
import uuid
from collections.abc import Sequence
from datetime import UTC, date, datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import ColumnElement, Text, and_, cast, func, or_, select, true
from sqlalchemy.dialects.postgresql import JSONPATH
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.core.creation_period import created_between
from app.models import Company, Establishment, Warehouse, WarehouseDraft
from app.repositories.filter_conditions import department_of
from app.repositories.list_sort import EntitySort, entity_order_by
from app.repositories.taxonomies import matches_words
from app.services import audit
from app.services.companies import normalize_siret
from app.services.contact_message_cancellation import stop_warehouse_drafts
from app.services.errors import ConflictError, InvalidFieldError, NotFoundError
from app.services.file_status import (
    FileStatus,
    missing_of,
    reading_context,
    status_of,
    warehouse_missing,
    warehouse_status_condition,
)

# `failure_code` of a programmed mail whose listing facts changed.
LISTING_CHANGED = "warehouse_changed"


class WarehouseContact(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    full_name: str = Field(min_length=1, max_length=500)
    role: str | None = Field(default=None, max_length=1000)
    email: str | None = Field(default=None, max_length=2000)
    linkedin: str | None = Field(default=None, max_length=2000)
    to_contact: bool = False


class WarehouseInput(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=500)
    prospecting_category: Literal['sme', 'other'] | None = None
    owner_name: str | None = Field(default=None, max_length=500)
    owner_role: str | None = Field(default=None, max_length=1000)
    owner_email: str | None = Field(default=None, max_length=2000)
    owner_linkedin: str | None = Field(default=None, max_length=2000)
    address: str | None = Field(default=None, max_length=2000)
    postal_code: str | None = Field(default=None, max_length=16)
    city: str | None = Field(default=None, max_length=255)
    siret: str | None = Field(default=None, max_length=32)
    # The building of a company this warehouse is (the company follows from it).
    establishment_id: uuid.UUID | None = None
    notes: str | None = Field(default=None, max_length=10000)
    contacts: list[WarehouseContact] = Field(default_factory=list, max_length=200)


class WarehouseOut(WarehouseInput):
    id: uuid.UUID
    version: str
    source_reference: str | None
    # Computed (`app.services.file_status`): verified / usable / incomplete, and what is missing for
    # the next level, plus the company and building the warehouse is linked to.
    status: FileStatus = "incomplete"
    missing: list[str] = Field(default_factory=list)
    company_id: uuid.UUID | None = None
    company_name: str | None = None
    building_name: str | None = None


class WarehousePage(BaseModel):
    items: list[WarehouseOut]
    total: int


class WarehouseCounts(BaseModel):
    warehouses: int
    contacts: int
    to_contact: int
    sme: int
    other: int
    unclassified: int


def count_warehouses(session: Session) -> WarehouseCounts:
    warehouses, contacts, to_contact, sme, other, unclassified = session.execute(
        select(
            func.count(),
            func.coalesce(func.sum(func.jsonb_array_length(Warehouse.contacts)), 0),
            func.coalesce(
                func.sum(
                    func.jsonb_array_length(
                        func.jsonb_path_query_array(
                            Warehouse.contacts, cast("$[*] ? (@.to_contact == true)", JSONPATH)
                        )
                    )
                ),
                0,
            ),
            func.count().filter(Warehouse.prospecting_category == 'sme'),
            func.count().filter(Warehouse.prospecting_category == 'other'),
            func.count().filter(Warehouse.prospecting_category.is_(None)),
        ).select_from(Warehouse)
    ).one()
    return WarehouseCounts(
        warehouses=warehouses, contacts=contacts, to_contact=to_contact,
        sme=sme, other=other, unclassified=unclassified,
    )


def version(row: Warehouse) -> str:
    values = {field: getattr(row, field) for field in WarehouseInput.model_fields}
    values["updated_at"] = row.updated_at.astimezone(UTC).isoformat()
    return hashlib.sha256(json.dumps(values, sort_keys=True, default=str).encode()).hexdigest()[:32]


def present(session: Session, row: Warehouse) -> WarehouseOut:
    return present_many(session, [row])[0]


def present_many(session: Session, rows: Sequence[Warehouse]) -> list[WarehouseOut]:
    """The rows with their computed status and company, in one query."""
    usable, verified = warehouse_missing(reading_context(session))
    extras = {
        found[0]: found
        for found in session.execute(
            select(
                Warehouse.id,
                usable,
                verified,
                Company.id,
                Company.display_name,
                func.coalesce(Establishment.name, Establishment.city),
            )
            .select_from(Warehouse)
            .outerjoin(Establishment, Establishment.id == Warehouse.establishment_id)
            .outerjoin(Company, Company.id == Establishment.company_id)
            .where(Warehouse.id.in_([row.id for row in rows]))
        ).all()
    }
    items = []
    for row in rows:
        _, usable_missing, verified_missing, company_id, company_name, building = extras[row.id]
        items.append(
            WarehouseOut(
                **{key: getattr(row, key) for key in WarehouseInput.model_fields},
                id=row.id,
                version=version(row),
                source_reference=row.source_reference,
                status=status_of(usable_missing, verified_missing),
                missing=missing_of(usable_missing, verified_missing),
                company_id=company_id,
                company_name=company_name,
                building_name=building,
            )
        )
    return items


def list_warehouses(
    session: Session, search: str = "", limit: int = 50, offset: int = 0, to_contact: bool = False,
    categories: Sequence[Literal['sme', 'other', 'unclassified']] = (),
    sort: EntitySort = EntitySort.NAME,
    statuses: Sequence[FileStatus] = (),
    departments: Sequence[str] = (),
    created_from: date | None = None,
    created_to: date | None = None,
) -> WarehousePage:
    """Within one filter the values are alternatives (OR); the filters combine with AND."""
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
    if to_contact:
        conditions.append(Warehouse.contacts.contains([{"to_contact": True}]))
    if categories:
        choices: list[ColumnElement[bool]] = [Warehouse.prospecting_category.in_(categories)]
        if 'unclassified' in categories:
            choices.append(Warehouse.prospecting_category.is_(None))
        conditions.append(or_(*choices))
    if statuses:
        context = reading_context(session)
        conditions.append(
            or_(*(warehouse_status_condition(status, context) for status in statuses))
        )
    if departments:
        conditions.append(department_of(Warehouse.postal_code).in_(departments))
    conditions.extend(created_between(Warehouse.created_at, created_from, created_to))
    total = session.scalar(select(func.count()).select_from(Warehouse).where(*conditions)) or 0
    rows = session.scalars(
        select(Warehouse)
        .where(*conditions)
        .order_by(
            *entity_order_by(
                sort, Warehouse.name, Warehouse.created_at, Warehouse.updated_at, Warehouse.id
            )
        )
        .limit(limit)
        .offset(offset)
    )
    return WarehousePage(items=present_many(session, list(rows)), total=total)


def get_warehouse(session: Session, warehouse_id: uuid.UUID, *, lock: bool = False) -> Warehouse:
    statement = select(Warehouse).where(Warehouse.id == warehouse_id)
    row = session.scalar(statement.with_for_update() if lock else statement)
    if row is None:
        raise NotFoundError("Warehouse not found.")
    return row


def _roles(contacts: Sequence[dict[str, Any]]) -> dict[str, str | None]:
    return {str(c.get("full_name")): c.get("role") for c in contacts}


def _stop_changed_mails(
    session: Session,
    actor: ActorContext,
    row: Warehouse,
    previous_roles: dict[str, str | None],
    previous_category: str | None,
) -> None:
    """A programmed mail was approved for the facts of the listing: when its category or the
    person's role changes, it does not leave."""
    roles = _roles(row.contacts)
    changed = [name for name, role in roles.items() if previous_roles.get(name, role) != role]
    which: ColumnElement[bool] = WarehouseDraft.contact_name.in_(changed)
    if row.prospecting_category != previous_category:
        which = true()
    stop_warehouse_drafts(
        session,
        actor,
        and_(
            WarehouseDraft.warehouse_id == row.id,
            WarehouseDraft.send_state == "scheduled",
            which,
        ),
        LISTING_CHANGED,
        datetime.now(UTC),
    )


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
    previous_category = row.prospecting_category if warehouse_id else None
    previous_roles = _roles(row.contacts) if warehouse_id else {}
    values = data.model_dump()
    if data.establishment_id is not None and session.get(Establishment, data.establishment_id) is None:
        raise InvalidFieldError("establishment_id", "Unknown building.", "unknown")
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
    if warehouse_id:
        _stop_changed_mails(session, actor, row, previous_roles, previous_category)
    session.refresh(row)
    return present(session, row)
