"""Read-only projection of the normalized database for the Excel export (Task 10).

Loads every exported entity once (SELECTs only, through `app.repositories.exports`) and resolves
references — company, role, segment, referent, channels, provenance, import traces — into records
the column specification reads. Nothing here knows a sheet or a column name.

Ordering is deterministic and independent of the database collation or insertion order: texts are
compared folded (the import's `fold`: case, accents and punctuation ignored) and the id is always
the last tie-breaker.
"""

import json
import uuid
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from sqlalchemy.orm import Session

from app.models.companies import Company, Establishment
from app.models.contact_tracking import ContactTracking
from app.models.imports import ImportBatch, ImportRowMetadata
from app.models.prospects import Email, Phone, Prospect, ProspectSource
from app.models.taxonomies import ActivityCategory, CommercialSegment, InternalReferent, Role
from app.repositories import exports as repository
from app.services.imports.text import fold

type LegacyScalar = str | int | float | bool | None


@dataclass(frozen=True, slots=True)
class CompanyRecord:
    company: Company
    segment: CommercialSegment | None
    categories: tuple[ActivityCategory, ...]  # by label
    establishments: tuple[Establishment, ...]  # primary first, then oldest
    prospect_count: int

    @property
    def primary_establishment(self) -> Establishment | None:
        return next((row for row in self.establishments if row.is_primary), None)


@dataclass(frozen=True, slots=True)
class ProspectRecord:
    prospect: Prospect
    company: CompanyRecord | None
    role: Role | None
    tracking: ContactTracking | None
    referent: InternalReferent | None
    emails: tuple[Email, ...]  # primary first, then active ones, then by address
    phones: tuple[Phone, ...]  # primary first, then active ones, then by number
    sources: tuple[ProspectSource, ...]  # oldest first

    @property
    def primary_email(self) -> Email | None:
        return next((email for email in self.emails if email.is_primary), None)

    @property
    def primary_phone(self) -> Phone | None:
        return next((phone for phone in self.phones if phone.is_primary), None)

    @property
    def status_since(self) -> datetime | None:
        """When the current contact-tracking status was reached (its latest history row)."""
        if self.tracking is None:
            return None
        return next(
            (
                row.changed_at
                for row in reversed(self.tracking.status_history)
                if row.to_status == self.tracking.status
            ),
            None,
        )


@dataclass(frozen=True, slots=True)
class EstablishmentRecord:
    company: CompanyRecord
    establishment: Establishment


@dataclass(frozen=True, slots=True)
class EmailRecord:
    owner: ProspectRecord
    email: Email


@dataclass(frozen=True, slots=True)
class PhoneRecord:
    owner: ProspectRecord
    phone: Phone


@dataclass(frozen=True, slots=True)
class SourceRecord:
    owner: ProspectRecord
    source: ProspectSource
    batch: ImportBatch | None


@dataclass(frozen=True, slots=True)
class LegacyRecord:
    """One preserved legacy value of an imported row (`import_row_metadata.legacy_metadata`)."""

    owner: ProspectRecord | None  # None once the row's prospect no longer exists
    trace: ImportRowMetadata
    batch: ImportBatch
    key: str
    column: str | None
    header: str | None
    value: LegacyScalar
    reason: str | None


@dataclass(frozen=True, slots=True)
class ExportData:
    prospects: tuple[ProspectRecord, ...]  # by company, last name, first name
    companies: tuple[CompanyRecord, ...]  # by name
    legacy: tuple[LegacyRecord, ...]  # by import, sheet, row, column
    batches: dict[uuid.UUID, ImportBatch]

    def establishments(self) -> list[EstablishmentRecord]:
        return [
            EstablishmentRecord(company, row)
            for company in self.companies
            for row in company.establishments
        ]

    def emails(self) -> list[EmailRecord]:
        return [EmailRecord(owner, email) for owner in self.prospects for email in owner.emails]

    def phones(self) -> list[PhoneRecord]:
        return [PhoneRecord(owner, phone) for owner in self.prospects for phone in owner.phones]

    def sources(self) -> list[SourceRecord]:
        return [
            SourceRecord(
                owner,
                source,
                self.batches.get(source.import_batch_id) if source.import_batch_id else None,
            )
            for owner in self.prospects
            for source in owner.sources
        ]


def load_export_data(session: Session) -> ExportData:
    prospects = repository.prospects(session)
    counts: dict[uuid.UUID, int] = defaultdict(int)
    for prospect in prospects:
        if prospect.company_id is not None:
            counts[prospect.company_id] += 1
    segments = {row.id: row for row in repository.segments(session)}
    companies = sorted(
        (_company(row, segments, counts[row.id]) for row in repository.companies(session)),
        key=lambda record: (fold(record.company.display_name), str(record.company.id)),
    )
    by_company = {record.company.id: record for record in companies}
    roles = {row.id: row for row in repository.roles(session)}
    referents = {row.id: row for row in repository.referents(session)}
    sources: dict[uuid.UUID, list[ProspectSource]] = defaultdict(list)
    for source in repository.sources(session):
        sources[source.prospect_id].append(source)
    records = sorted(
        (
            _prospect(prospect, by_company, roles, referents, sources[prospect.id])
            for prospect in prospects
        ),
        key=_prospect_order,
    )
    batches = {row.id: row for row in repository.import_batches(session)}
    by_prospect = {record.prospect.id: record for record in records}
    return ExportData(
        prospects=tuple(records),
        companies=tuple(companies),
        legacy=tuple(_legacy(repository.row_metadata(session), batches, by_prospect)),
        batches=batches,
    )


def _company(
    company: Company, segments: dict[uuid.UUID, CommercialSegment], prospect_count: int
) -> CompanyRecord:
    return CompanyRecord(
        company=company,
        segment=segments.get(company.commercial_segment_id)
        if company.commercial_segment_id
        else None,
        categories=tuple(
            sorted(company.activity_categories, key=lambda row: (fold(row.label), str(row.id)))
        ),
        establishments=tuple(
            sorted(
                company.establishments,
                key=lambda row: (not row.is_primary, row.created_at, str(row.id)),
            )
        ),
        prospect_count=prospect_count,
    )


def _prospect(
    prospect: Prospect,
    companies: dict[uuid.UUID, CompanyRecord],
    roles: dict[uuid.UUID, Role],
    referents: dict[uuid.UUID, InternalReferent],
    sources: list[ProspectSource],
) -> ProspectRecord:
    tracking = prospect.contact_tracking
    return ProspectRecord(
        prospect=prospect,
        company=companies.get(prospect.company_id) if prospect.company_id else None,
        role=roles.get(prospect.role_id) if prospect.role_id else None,
        tracking=tracking,
        referent=referents.get(tracking.referent_id)
        if tracking is not None and tracking.referent_id
        else None,
        emails=tuple(
            sorted(
                prospect.emails,
                key=lambda row: (not row.is_primary, not row.is_active, row.address, str(row.id)),
            )
        ),
        phones=tuple(
            sorted(
                prospect.phones,
                key=lambda row: (not row.is_primary, not row.is_active, row.number, str(row.id)),
            )
        ),
        sources=tuple(sorted(sources, key=lambda row: (row.collected_at, str(row.id)))),
    )


def _prospect_order(record: ProspectRecord) -> tuple[Any, ...]:
    company = record.company.company if record.company else None
    person = record.prospect
    return (
        company is None,  # prospects without a company last
        fold(company.display_name) if company else "",
        str(company.id) if company else "",
        fold(person.last_name or ""),
        fold(person.first_name or ""),
        str(person.id),
    )


def _legacy(
    traces: Sequence[ImportRowMetadata],
    batches: dict[uuid.UUID, ImportBatch],
    prospects: dict[uuid.UUID, ProspectRecord],
) -> list[LegacyRecord]:
    ordered = sorted(
        traces,
        key=lambda row: (
            batches[row.import_batch_id].created_at,
            str(row.import_batch_id),
            row.source_sheet,
            row.source_row_number,
        ),
    )
    records: list[LegacyRecord] = []
    for trace in ordered:
        owner = prospects.get(trace.prospect_id) if trace.prospect_id else None
        entries = [
            _legacy_record(owner, trace, batches[trace.import_batch_id], key, raw)
            for key, raw in trace.legacy_metadata.items()
        ]
        records.extend(sorted(entries, key=_legacy_order))
    return records


def _legacy_record(
    owner: ProspectRecord | None,
    trace: ImportRowMetadata,
    batch: ImportBatch,
    key: str,
    raw: Any,
) -> LegacyRecord:
    """An entry as written by the import (`{column, header, value, reason}`); anything else is
    kept whole as its JSON text, so no stored value is dropped."""
    entry = raw if isinstance(raw, dict) else {"value": raw}
    value = entry.get("value")
    return LegacyRecord(
        owner=owner,
        trace=trace,
        batch=batch,
        key=key,
        column=_text(entry.get("column")),
        header=_text(entry.get("header")),
        value=value
        if value is None or isinstance(value, str | int | float | bool)
        else json.dumps(value, ensure_ascii=False, sort_keys=True),
        reason=_text(entry.get("reason")),
    )


def _text(value: Any) -> str | None:
    return None if value is None else str(value)


def _legacy_order(record: LegacyRecord) -> tuple[int, str, str]:
    """Source column order (`B` < `Z` < `AA`), then key; entries without a column last."""
    column = record.column or ""
    return (len(column) if column else 99, column, record.key)
