"""Typed `ImportPreview`: the JSON contract handed to the import review (Task 09).

Everything is a proposal: taxonomy/referent matches that need a human decision say so
(`requires_confirmation`), duplicates are candidates with reasons and a confidence, never
decisions. `model_dump(mode="json")` is deterministic for a given input.
"""

import uuid
from datetime import date
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    ContactTrackingStatus,
    PhoneType,
)
from app.services.imports.diagnostics import Diagnostic
from app.services.imports.fields import ImportField
from app.services.imports.layout import ColumnMapping
from app.services.imports.text import JsonScalar
from app.services.imports.workbook import FileFormat


class Frozen(BaseModel):
    model_config = ConfigDict(frozen=True)


class MatchKind(StrEnum):
    EXACT = "exact"  # same label (or referent name) once folded
    CONTAINS = "contains"  # every word of the label appears in the text
    SIMILAR = "similar"  # close spelling
    PARTIAL = "partial"  # referent recognised by first name, last name or initial only
    INACTIVE = "inactive"  # exact match on a deactivated value


class TaxonomyMatch(Frozen):
    id: uuid.UUID
    label: str
    match: MatchKind
    score: float
    requires_confirmation: bool
    source_text: str  # the (normalized) text that was matched


class ReferentMatch(Frozen):
    id: uuid.UUID
    display: str
    match: MatchKind
    requires_confirmation: bool


class LegacyReason(StrEnum):
    UNMAPPED_COLUMN = "unmapped_column"  # unknown, unnamed, repeated or user-unmapped column
    OPAQUE_FIELD = "opaque_field"  # known column kept raw by design (meaning not confirmed)
    NOT_MAPPED_VALUE = "not_mapped_value"  # mapped column whose value was not (fully) converted
    CORRECTED = "corrected"  # original value replaced by the user during the review (Task 09)


class LegacyValue(Frozen):
    column: str
    header: str | None
    value: JsonScalar
    reason: LegacyReason


class SourceCell(Frozen):
    """A non-empty source cell and where it went: a proposed field, legacy metadata, or both."""

    column: str
    value: JsonScalar
    mapped: bool
    preserved: bool
    copied_from_merge: bool = False
    # Replaced by a user correction: `value` is the original, kept in legacy metadata.
    corrected: bool = False


class EstablishmentProposal(Frozen):
    model_config = ConfigDict(frozen=True, extra="forbid")  # a misnamed field must fail loudly

    address_line1: str | None = None
    address_line2: str | None = None
    postal_code: str | None = None
    city: str | None = None
    country: str | None = None


class MatchReason(StrEnum):
    SAME_EMAIL = "same_email"
    SAME_PERSON = "same_person"  # same folded first and last names and same company key
    SAME_NAME = "same_name"  # same folded first and last names, other or no company
    SAME_COMPANY_NAME = "same_company_name"  # same company key (legal forms and accents ignored)
    SIMILAR_COMPANY_NAME = "similar_company_name"
    SAME_EMAIL_DOMAIN = "same_email_domain"


class CompanyCandidate(Frozen):
    company_id: uuid.UUID
    display_name: str
    reasons: list[MatchReason]
    confidence: float


class CompanyProposal(Frozen):
    display_name: str
    match_key: str  # rows sharing it are the same company in this file
    email_domain: str | None = None  # from the first non-webmail address of the row
    project_done_with_circoe: str | None = None
    project_type: str | None = None
    circoe_references: str | None = None
    client_approach: str | None = None
    activity_categories: list[TaxonomyMatch] = Field(default_factory=list)
    unmatched_categories: list[str] = Field(default_factory=list)
    segment_suggestion: TaxonomyMatch | None = None
    establishment: EstablishmentProposal | None = None
    candidates: list[CompanyCandidate] = Field(default_factory=list)


class ProspectProposal(Frozen):
    civility: Civility | None = None
    first_name: str | None = None
    last_name: str | None = None
    exact_job_title: str | None = None
    # Ranked; an exact match comes alone and needs no confirmation. Never a new role.
    role_suggestions: list[TaxonomyMatch] = Field(default_factory=list)
    # Import never sets activity: `inactive` is only suggested (e.g. `retraité`), to confirm.
    activity_status_suggestion: ActivityStatus | None = None


class EmailProposal(Frozen):
    address: str
    is_primary: bool


class PhoneProposal(Frozen):
    number: str
    type: PhoneType
    is_primary: bool
    column: str


class PlannedContactProposal(Frozen):
    planned_date: date | None = None  # set only when the cell gives the year (or is a date)
    week: int | None = None
    year: int | None = None
    requires_year: bool = False  # week without year: the user must provide it


class TrackingProposal(Frozen):
    status: ContactTrackingStatus
    stages: list[ImportField] = Field(default_factory=list)  # positive legacy stage columns
    requires_review: bool = False  # contradictory stages
    planned_contact: PlannedContactProposal | None = None
    appointment_date: date | None = None
    referent: ReferentMatch | None = None
    referent_suggestions: list[ReferentMatch] = Field(default_factory=list)


class CandidateKind(StrEnum):
    FILE_ROW = "file_row"
    EXISTING_PROSPECT = "existing_prospect"


class DuplicateCandidate(Frozen):
    kind: CandidateKind
    row: int | None = None  # FILE_ROW: the other source row
    prospect_id: uuid.UUID | None = None  # EXISTING_PROSPECT
    reasons: list[MatchReason]
    confidence: float
    # EXISTING_PROSPECT only. `do_not_contact` must survive any merge (Task 09): a merge never
    # writes contactability, and a new prospect must not be created for that person.
    contactability: ContactabilityStatus | None = None


class RowStatus(StrEnum):
    OK = "ok"
    WARNING = "warning"
    ERROR = "error"


class PreviewRow(Frozen):
    row_number: int
    status: RowStatus
    company: CompanyProposal | None
    prospect: ProspectProposal
    emails: list[EmailProposal]
    phones: list[PhoneProposal]
    tracking: TrackingProposal | None
    legacy_metadata: dict[str, LegacyValue]
    duplicates: list[DuplicateCandidate]
    blocked_by_do_not_contact: bool
    diagnostics: list[Diagnostic]
    cells: list[SourceCell]


class SheetStatus(StrEnum):
    IMPORTED = "imported"
    SKIPPED = "skipped"


class SheetSummary(Frozen):
    name: str
    status: SheetStatus
    rows: int  # non-empty rows, header included
    merged_ranges: int


class ImportSummary(Frozen):
    file_name: str
    file_format: FileFormat
    file_fingerprint: str
    encoding: str | None
    delimiter: str | None
    sheet: str | None
    header_row: int | None
    sheets: list[SheetSummary]
    columns: list[ColumnMapping]
    rows_total: int
    rows_empty: int  # blank rows between the header and the last data row (skipped)
    rows_by_status: dict[str, int]
    counts_by_severity: dict[str, int]
    counts_by_code: dict[str, int]
    duplicate_email_groups: int
    notices: list[Diagnostic]


class ImportPreview(Frozen):
    summary: ImportSummary
    rows: list[PreviewRow]
