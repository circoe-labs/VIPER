"""Cancel a committed import: take back what it wrote, keep what has been used since.

The audit log says exactly what a batch wrote (every event of the commit carries its
`import_batch_id`), so the cancellation reads it:

- a prospect or company the import **created** is deleted, unless something else happened to it
  since — any other audit event (an edit, a send, a later import), a link from outside its own
  file (appointment, mission, relation…), an opposition, or, for a company, a remaining prospect;
- what the import **added** to a record that existed (e-mail, phone, note, site, sequence,
  tracking, alert) is deleted unless it was changed since;
- a field the import **filled** on an existing record gets its former value back, only while it
  still holds the imported one;
- Settings values it created (roles, categories, cohorts) stay.

Everything runs in the caller's transaction; the preview is the same run rolled back.
"""

import uuid
from collections import Counter
from dataclasses import dataclass
from datetime import date, datetime
from enum import Enum
from typing import Any

from sqlalchemy import exists, inspect, select
from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.db.base import Base
from app.models import (
    ActivityCategory,
    Company,
    ContactMessage,
    ContactSequence,
    ContactTracking,
    Email,
    Establishment,
    Phone,
    Prospect,
    ProspectNote,
    ProspectSource,
    QualityAlert,
)
from app.models.audit import AuditLogEntry
from app.models.enums import ContactabilityStatus, ImportBatchStatus
from app.models.imports import ImportBatch
from app.services import audit, companies
from app.services.audit import AuditAction
from app.services.audit_changes import to_json
from app.services.errors import BusinessRuleError, NotFoundError

# Rows that belong to a record and go with it: a link from any other table means it is in use.
OWN_TABLES = frozenset(
    {
        "emails",
        "phones",
        "contact_tracking",
        "contact_sequences",
        "contact_messages",
        "contact_message_versions",
        "prospect_sources",
        "prospect_notes",
        "prospect_score_assessments",
        "quality_alerts",
        "import_row_metadata",
        "establishments",
        "company_activity_categories",
    }
)
# What the import may add to a record, children before their parents.
ADDITIONS: tuple[tuple[str, type[Any]], ...] = (
    ("quality_alert", QualityAlert),
    ("prospect_note", ProspectNote),
    ("email", Email),
    ("phone", Phone),
    ("contact_sequence", ContactSequence),
    ("contact_tracking", ContactTracking),
    ("establishment", Establishment),
)
RESTORABLE: dict[str, type[Any]] = {
    "prospect": Prospect,
    "company": Company,
    "contact_tracking": ContactTracking,
}


def not_cancellable() -> BusinessRuleError:
    return BusinessRuleError(
        "import_not_cancellable", 409, "Only a committed import can be cancelled."
    )


@dataclass(frozen=True, slots=True)
class Cancellation:
    prospects_deleted: int
    prospects_kept: int
    companies_deleted: int
    companies_kept: int
    additions_removed: int
    fields_restored: int


@dataclass(frozen=True, slots=True)
class _Batch:
    events: list[AuditLogEntry]  # the commit's events, oldest first

    def created(self, entity_type: str) -> list[uuid.UUID]:
        action = f"{entity_type}.created"
        return list(
            dict.fromkeys(
                e.entity_id for e in self.events if e.action == action and e.entity_id is not None
            )
        )


def preview(session: Session, actor: ActorContext, batch_id: uuid.UUID) -> Cancellation:
    """What cancelling would do now: the cancellation itself, rolled back."""
    savepoint = session.begin_nested()
    try:
        return cancel(session, actor, batch_id)
    finally:
        savepoint.rollback()


def cancel(session: Session, actor: ActorContext, batch_id: uuid.UUID) -> Cancellation:
    record = session.execute(
        select(ImportBatch).where(ImportBatch.id == batch_id).with_for_update()
    ).scalar_one_or_none()
    if record is None:
        raise NotFoundError(f"Import batch {batch_id} not found.")
    if record.status is not ImportBatchStatus.COMMITTED:
        raise not_cancellable()
    mine = AuditLogEntry.context["import_batch_id"].astext == str(batch_id)
    batch = _Batch(
        list(session.scalars(select(AuditLogEntry).where(mine).order_by(AuditLogEntry.occurred_at)))
    )
    counts: Counter[str] = Counter()
    new_prospects = set(batch.created("prospect"))
    new_companies = set(batch.created("company"))

    for prospect_id in sorted(new_prospects, key=str):
        prospect = session.get(Prospect, prospect_id)
        if prospect is None:
            continue
        if (
            prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT
            or prospect.member_user_id is not None
            or _changed_since(session, batch_id, "prospect", prospect_id)
            or _linked(session, "prospects", prospect_id)
        ):
            counts["prospects_kept"] += 1
            continue
        audit.annotate(session, actor, prospect)
        session.delete(prospect)
        counts["prospects_deleted"] += 1
    session.flush()
    session.expire_all()

    for entity_type, model in ADDITIONS:
        for entity_id in batch.created(entity_type):
            row = session.get(model, entity_id)
            if row is None:
                continue  # already gone with its record
            owner_new = (
                getattr(row, "prospect_id", None) in new_prospects
                or getattr(row, "company_id", None) in new_companies
            )
            if owner_new or _touched(session, batch_id, _parts(session, row)):
                continue  # part of a kept new record, or someone worked on it
            if model is Establishment and _linked(session, "establishments", entity_id):
                continue
            audit.annotate(session, actor, row)
            session.delete(row)
            session.flush()
            counts["additions_removed"] += 1

    session.expire_all()
    added = {e.entity_id for e in batch.events if e.action.endswith(".created")}
    for event in reversed(batch.events):
        restorable = RESTORABLE.get(event.entity_type)
        if restorable is None or event.entity_id in added or event.action.endswith(".deleted"):
            continue
        row = session.get(restorable, event.entity_id)
        if row is not None:
            counts["fields_restored"] += _restore(session, actor, row, event.changes)

    for source in session.scalars(
        select(ProspectSource).where(ProspectSource.import_batch_id == batch_id)
    ).all():
        if source.prospect_id not in new_prospects:
            audit.annotate(session, actor, source)
            session.delete(source)
    session.flush()

    for company_id in sorted(new_companies, key=str):
        company = session.get(Company, company_id)
        if company is None:
            continue
        sites = [site.id for site in company.establishments]
        if (
            session.scalar(select(exists().where(Prospect.company_id == company_id)))
            or _changed_since(session, batch_id, "company", company_id)
            or _linked(session, "companies", company_id)
            or any(_linked(session, "establishments", site) for site in sites)
        ):
            counts["companies_kept"] += 1
            continue
        companies.delete_company(session, actor, company_id)
        session.flush()
        counts["companies_deleted"] += 1

    audit.annotate(session, actor, record, AuditAction.IMPORT_BATCH_CANCELLED)
    record.status = ImportBatchStatus.CANCELLED
    record.committed_at = None
    session.flush()
    return Cancellation(**{name: counts[name] for name in Cancellation.__slots__})


def _outside(batch_id: uuid.UUID) -> Any:
    return AuditLogEntry.context["import_batch_id"].astext.is_distinct_from(str(batch_id))


def _changed_since(
    session: Session, batch_id: uuid.UUID, subject_type: str, subject_id: uuid.UUID
) -> bool:
    """Anything but this import ever wrote the record or one of its rows."""
    return bool(
        session.scalar(
            select(
                exists()
                .where(AuditLogEntry.subject_type == subject_type)
                .where(AuditLogEntry.subject_id == subject_id)
                .where(_outside(batch_id))
            )
        )
    )


def _parts(session: Session, row: Any) -> list[uuid.UUID]:
    """The row and what would be deleted with it: a sequence takes its messages."""
    if not isinstance(row, ContactSequence):
        return [row.id]
    messages = select(ContactMessage.id).where(ContactMessage.sequence_id == row.id)
    return [row.id, *session.scalars(messages)]


def _touched(session: Session, batch_id: uuid.UUID, entity_ids: list[uuid.UUID]) -> bool:
    written = exists().where(AuditLogEntry.entity_id.in_(entity_ids)).where(_outside(batch_id))
    return bool(session.scalar(select(written)))


def _linked(session: Session, target: str, record_id: uuid.UUID) -> bool:
    """A row of a table that is not part of the record points to it."""
    for table in Base.metadata.sorted_tables:
        if table.name in OWN_TABLES or (target == "companies" and table.name == "prospects"):
            continue
        for key in table.foreign_keys:
            if key.column.table.name != target or key.column.name != "id":
                continue
            if session.scalar(select(exists().where(key.parent == record_id))):
                return True
    return False


def _restore(session: Session, actor: ActorContext, row: Any, changes: dict[str, Any]) -> int:
    """Give back the former value of each field still holding the imported one."""
    columns = {attr.key: attr.columns[0] for attr in inspect(type(row)).column_attrs}
    values: dict[str, Any] = {}
    for name, change in changes.items():
        before, after = change.get("before"), change.get("after")
        if name == "activity_categories_ids" and isinstance(row, Company):
            if sorted(str(c.id) for c in row.activity_categories) == after:
                wanted = [uuid.UUID(value) for value in before or []]
                found = select(ActivityCategory).where(ActivityCategory.id.in_(wanted))
                values["activity_categories"] = list(session.scalars(found))
        elif name in columns and to_json(getattr(row, name)) == after:
            values[name] = _value(columns[name].type.python_type, before)
    if not values:
        return 0
    audit.annotate(session, actor, row)
    for name, value in values.items():
        setattr(row, name, value)
    session.flush()
    return len(values)


def _value(kind: type, stored: Any) -> Any:
    """An audit event's JSON value as the column's Python type."""
    if stored is None:
        return None
    if issubclass(kind, Enum | uuid.UUID):
        return kind(stored)
    if issubclass(kind, date | datetime):
        return kind.fromisoformat(stored)
    return stored
