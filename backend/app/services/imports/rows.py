"""One source row → proposed entities, diagnostics and legacy metadata.

Losslessness: every non-empty cell ends up in a proposed field (`SourceCell.mapped`), in legacy
metadata (`preserved`), or both — raw values are kept whenever a conversion is partial,
impossible, a guess or not storable (a week without its year). A final pass preserves any cell no
rule consumed, so nothing is ever dropped silently.
"""

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field

from app.models.enums import ActivityStatus, ContactabilityStatus, ContactTrackingStatus, PhoneType
from app.services.imports.diagnostics import Diagnostic, DiagnosticCode, Severity, with_params
from app.services.imports.fields import SPECS, STAGE_FIELDS, ImportField
from app.services.imports.layout import ColumnMapping
from app.services.imports.matching import (
    CategoryOutcome,
    ReferentOutcome,
    company_key,
    match_categories,
    match_referent,
    match_role,
)
from app.services.imports.models import (
    CandidateKind,
    CompanyCandidate,
    CompanyProposal,
    DuplicateCandidate,
    EmailProposal,
    EstablishmentProposal,
    LegacyReason,
    LegacyValue,
    MatchReason,
    PhoneProposal,
    PlannedContactProposal,
    PreviewRow,
    ProspectProposal,
    RowStatus,
    SourceCell,
    TaxonomyMatch,
    TrackingProposal,
)
from app.services.imports.normalize import (
    Codes,
    ParsedPhone,
    StageState,
    email_domain,
    is_zero_placeholder,
    normalize_civility,
    normalize_name,
    parse_address,
    parse_emails,
    parse_phones,
    parse_planned_contact,
    read_stage,
)
from app.services.imports.reference import ImportReferenceData
from app.services.imports.text import CellValue, is_blank, json_value, multi_line, single_line
from app.services.imports.workbook import SheetRow

COMPANY_TEXT_FIELDS = (
    ImportField.PROJECT_DONE,
    ImportField.PROJECT_TYPE,
    ImportField.CIRCOE_REFERENCES,
    ImportField.CLIENT_APPROACH,
)
COMPANY_FIELDS = (*COMPANY_TEXT_FIELDS, ImportField.CATEGORY, ImportField.ADDRESS)
STAGE_STATUS = {
    ImportField.STAGE_FOLLOW_UP_1: ContactTrackingStatus.FOLLOW_UP_1,
    ImportField.STAGE_FOLLOW_UP_2: ContactTrackingStatus.FOLLOW_UP_2,
    ImportField.STAGE_APPOINTMENT: ContactTrackingStatus.APPOINTMENT_OBTAINED,
    ImportField.STAGE_QUOTE_SENT: ContactTrackingStatus.QUOTE_SENT,
    ImportField.STAGE_QUOTE_FOLLOW_UP: ContactTrackingStatus.QUOTE_FOLLOW_UP,
}
# Stage columns that only make sense after another one (`Relance 2` after `Relance 1`, `Suivi`
# of a quote after `Devis envoyé`).
STAGE_PREREQUISITES = {
    ImportField.STAGE_FOLLOW_UP_2: ImportField.STAGE_FOLLOW_UP_1,
    ImportField.STAGE_QUOTE_FOLLOW_UP: ImportField.STAGE_QUOTE_SENT,
}
STATUS_RANK = {status: rank for rank, status in enumerate(ContactTrackingStatus)}
REASON_CONFIDENCE = {
    MatchReason.SAME_EMAIL: 1.0,
    MatchReason.SAME_PERSON: 0.9,
    MatchReason.SAME_NAME: 0.5,
    MatchReason.SAME_COMPANY_NAME: 0.9,
    MatchReason.SAME_EMAIL_DOMAIN: 0.7,
    MatchReason.SIMILAR_COMPANY_NAME: 0.6,
}
# Free-mail providers: their domain says nothing about the employer.
WEBMAIL_DOMAINS = frozenset(
    {"gmail.com", "googlemail.com", "hotmail.com", "hotmail.fr", "outlook.com", "outlook.fr"}
    | {"live.com", "live.fr", "msn.com", "yahoo.com", "yahoo.fr", "ymail.com", "icloud.com"}
    | {"me.com", "mac.com", "aol.com", "aol.fr", "orange.fr", "wanadoo.fr", "free.fr", "sfr.fr"}
    | {"neuf.fr", "laposte.net", "bbox.fr", "numericable.fr", "club-internet.fr", "gmx.fr"}
    | {"gmx.com", "protonmail.com", "proton.me"}
)


@dataclass
class RowDraft:
    """A row being assembled; duplicate detection adds its findings before `finish()`."""

    number: int
    columns: dict[ImportField, ColumnMapping]
    company: CompanyProposal | None
    prospect: ProspectProposal
    emails: list[EmailProposal]
    phones: list[PhoneProposal]
    tracking: TrackingProposal | None
    legacy: dict[str, LegacyValue]
    diagnostics: list[Diagnostic]
    cells: list[SourceCell]
    file_matches: dict[int, set[MatchReason]] = field(default_factory=dict)
    existing_matches: dict[uuid.UUID, set[MatchReason]] = field(default_factory=dict)
    contactability: dict[uuid.UUID, ContactabilityStatus] = field(default_factory=dict)
    company_candidates: dict[uuid.UUID, tuple[str, set[MatchReason], float]] = field(
        default_factory=dict
    )
    blocked: bool = False

    def flag(
        self, code: DiagnosticCode, field: ImportField | None = None, **params: object
    ) -> None:
        column = self.columns.get(field) if field else None
        self.diagnostics.append(
            with_params(
                code, params, row=self.number, column=column.column if column else None, field=field
            )
        )

    def finish(self) -> PreviewRow:
        severities = {diagnostic.severity for diagnostic in self.diagnostics}
        status = (
            RowStatus.ERROR
            if Severity.ERROR in severities
            else RowStatus.WARNING
            if Severity.WARNING in severities
            else RowStatus.OK
        )
        duplicates = [
            DuplicateCandidate(
                kind=CandidateKind.FILE_ROW,
                row=row,
                reasons=sorted(reasons),
                confidence=max(REASON_CONFIDENCE[reason] for reason in reasons),
            )
            for row, reasons in sorted(self.file_matches.items())
        ] + sorted(
            (
                DuplicateCandidate(
                    kind=CandidateKind.EXISTING_PROSPECT,
                    prospect_id=prospect_id,
                    reasons=sorted(reasons),
                    confidence=max(REASON_CONFIDENCE[reason] for reason in reasons),
                    contactability=self.contactability[prospect_id],
                )
                for prospect_id, reasons in self.existing_matches.items()
            ),
            key=lambda candidate: (-candidate.confidence, str(candidate.prospect_id)),
        )
        company = self.company
        if company is not None and self.company_candidates:
            candidates = sorted(
                (
                    CompanyCandidate(
                        company_id=company_id,
                        display_name=name,
                        reasons=sorted(reasons),
                        confidence=confidence,
                    )
                    for company_id, (name, reasons, confidence) in self.company_candidates.items()
                ),
                key=lambda c: (-c.confidence, c.display_name.casefold(), str(c.company_id)),
            )
            company = company.model_copy(update={"candidates": candidates})
        return PreviewRow(
            row_number=self.number,
            status=status,
            company=company,
            prospect=self.prospect,
            emails=self.emails,
            phones=self.phones,
            tracking=self.tracking,
            legacy_metadata=self.legacy,
            duplicates=duplicates,
            blocked_by_do_not_contact=self.blocked,
            diagnostics=self.diagnostics,
            cells=self.cells,
        )


class RowBuilder:
    def __init__(
        self,
        row: SheetRow,
        columns: Sequence[ColumnMapping],
        reference: ImportReferenceData,
        corrections: Mapping[ImportField, str | None] | None = None,
    ) -> None:
        self.row = row
        self.columns = columns
        self.by_field = {column.field: column for column in columns if column.field is not None}
        self.reference = reference
        # User corrections (Task 09 review): the typed text replaces the cell, the original value
        # is kept in legacy metadata, and every rule below runs on the corrected value.
        self.corrections = corrections or {}
        self.diagnostics: list[Diagnostic] = []
        self.legacy: dict[str, LegacyValue] = {}
        self.mapped: set[str] = set()
        self.preserved: set[str] = set()
        self.activity_suggestion: ActivityStatus | None = None

    # --- bookkeeping ---

    def value(self, column: ColumnMapping) -> CellValue:
        if column.field is not None and column.field in self.corrections:
            return self.corrections[column.field]
        return self.row.value(column.index)

    def cell(self, field: ImportField) -> tuple[ColumnMapping, CellValue] | None:
        column = self.by_field.get(field)
        if column is None:
            return None
        value = self.value(column)
        return None if is_blank(value) else (column, value)

    def flag(
        self,
        code: DiagnosticCode,
        column: ColumnMapping | None = None,
        value: CellValue = None,
        **params: object,
    ) -> None:
        self.diagnostics.append(
            with_params(
                code,
                params,
                row=self.row.number,
                column=column.column if column else None,
                field=column.field if column else None,
                value=json_value(value),
            )
        )

    def keep(
        self,
        column: ColumnMapping,
        value: CellValue,
        reason: LegacyReason = LegacyReason.NOT_MAPPED_VALUE,
    ) -> None:
        key = column.field.value if column.field is not None else f"column_{column.column}"
        self.legacy[key] = LegacyValue(
            column=column.column, header=column.header, value=json_value(value), reason=reason
        )
        self.preserved.add(column.column)

    def settle(
        self, column: ColumnMapping, value: CellValue, codes: Codes, *, keep: bool, mapped: bool
    ) -> None:
        for code in codes:
            self.flag(code, column, value)
        if keep:
            self.keep(column, value)
        if mapped:
            self.mapped.add(column.column)

    def suggest_inactive(self, column: ColumnMapping, value: CellValue) -> None:
        if self.activity_suggestion is None:
            self.activity_suggestion = ActivityStatus.INACTIVE
            self.flag(DiagnosticCode.ACTIVITY_INACTIVE_SUGGESTED, column, value)

    def text(self, field: ImportField, *, multiline: bool = False) -> str | None:
        found = self.cell(field)
        if found is None:
            return None
        column, value = found
        if is_zero_placeholder(value):
            self.settle(
                column, value, (DiagnosticCode.VALUE_ZERO_PLACEHOLDER,), keep=True, mapped=False
            )
            return None
        text = (multi_line if multiline else single_line)(value) or ""
        limit = SPECS[field].max_length
        if limit is not None and len(text) > limit:
            self.flag(
                DiagnosticCode.VALUE_TOO_LONG, column, value, label=SPECS[field].label, limit=limit
            )
            self.keep(column, value)
            return None
        self.mapped.add(column.column)
        return text

    # --- entities ---

    def build(self) -> RowDraft:
        self.corrected_originals()
        self.unmapped_and_opaque()
        company = self.company()
        prospect = self.prospect()
        emails = self.emails()
        phones = self.phones()
        tracking = self.tracking()
        prospect = prospect.model_copy(
            update={"activity_status_suggestion": self.activity_suggestion}
        )
        if company is None:
            self.flag(DiagnosticCode.COMPANY_MISSING)
        else:
            domains = [email_domain(email.address) for email in emails]
            domain = next((d for d in domains if d not in WEBMAIL_DOMAINS), None)
            company = company.model_copy(update={"email_domain": domain})
        for index in sorted(self.row.copied):
            column = self.columns[index]
            self.flag(DiagnosticCode.CELL_MERGED_VALUE_COPIED, column, self.row.value(index))
        return RowDraft(
            number=self.row.number,
            columns=self.by_field,
            company=company,
            prospect=prospect,
            emails=emails,
            phones=phones,
            tracking=tracking,
            legacy=self.legacy,
            diagnostics=self.diagnostics,
            cells=self.source_cells(),
        )

    def corrected_originals(self) -> None:
        """A corrected cell's original value stays in legacy metadata (`<field>_original`)."""
        for corrected in self.corrections:
            column = self.by_field[corrected]
            original = self.row.value(column.index)
            if is_blank(original):
                continue
            self.legacy[f"{corrected.value}_original"] = LegacyValue(
                column=column.column,
                header=column.header,
                value=json_value(original),
                reason=LegacyReason.CORRECTED,
            )
            self.preserved.add(column.column)

    def unmapped_and_opaque(self) -> None:
        for column in self.columns:
            value = self.row.value(column.index)
            if is_blank(value):
                continue
            if column.field is None:
                self.keep(column, value, LegacyReason.UNMAPPED_COLUMN)
            elif SPECS[column.field].opaque:
                self.keep(column, value, LegacyReason.OPAQUE_FIELD)

    def source_cells(self) -> list[SourceCell]:
        cells = []
        for column in self.columns:
            value = self.row.value(column.index)
            if is_blank(value):
                continue
            if column.column not in self.mapped | self.preserved:
                self.keep(column, value)  # safety net: nothing is dropped silently
            cells.append(
                SourceCell(
                    column=column.column,
                    value=json_value(value),
                    mapped=column.column in self.mapped,
                    preserved=column.column in self.preserved,
                    copied_from_merge=column.index in self.row.copied,
                    corrected=column.field in self.corrections,
                )
            )
        return cells

    def company(self) -> CompanyProposal | None:
        name = self.text(ImportField.COMPANY_NAME)
        if name is None:
            # Nothing to attach company-level values to: keep them raw, still diagnosed.
            for company_field in COMPANY_FIELDS:
                if found := self.cell(company_field):
                    column, value = found
                    codes: Codes = ()
                    if company_field is ImportField.ADDRESS:
                        codes = (DiagnosticCode.ADDRESS_WITHOUT_COMPANY,)
                    elif company_field is ImportField.CATEGORY:
                        codes = self.match_categories(value).codes
                    self.settle(column, value, codes, keep=True, mapped=False)
            return None
        texts = {
            company_field.value: self.text(company_field, multiline=True)
            for company_field in COMPANY_TEXT_FIELDS
        }
        categories = self.categories()
        return CompanyProposal(
            display_name=name,
            match_key=company_key(name),
            activity_categories=list(categories.matches),
            unmatched_categories=list(categories.unmatched),
            segment_suggestion=categories.segment,
            establishment=self.establishment(),
            **texts,
        )

    def categories(self) -> CategoryOutcome:
        found = self.cell(ImportField.CATEGORY)
        if found is None:
            return CategoryOutcome()
        column, value = found
        outcome = self.match_categories(value)
        proposed = bool(outcome.matches or outcome.unmatched or outcome.segment)
        self.settle(column, value, outcome.codes, keep=outcome.keep_raw, mapped=proposed)
        return outcome

    def match_categories(self, value: CellValue) -> CategoryOutcome:
        return match_categories(
            value, self.reference.activity_categories, self.reference.commercial_segments
        )

    def establishment(self) -> EstablishmentProposal | None:
        found = self.cell(ImportField.ADDRESS)
        if found is None:
            return None
        column, value = found
        if is_zero_placeholder(value):
            self.settle(
                column, value, (DiagnosticCode.VALUE_ZERO_PLACEHOLDER,), keep=True, mapped=False
            )
            return None
        outcome = parse_address(multi_line(value) or "")
        codes = tuple(code for code in outcome.codes if code is not DiagnosticCode.VALUE_TOO_LONG)
        if DiagnosticCode.VALUE_TOO_LONG in outcome.codes:
            self.flag(DiagnosticCode.VALUE_TOO_LONG, column, value, label="Adresse", limit=255)
        self.settle(column, value, codes, keep=outcome.keep_raw, mapped=outcome.value is not None)
        if outcome.value is None:
            return None
        address = outcome.value
        return EstablishmentProposal(
            address_line1=address.line1,
            address_line2=address.line2,
            postal_code=address.postal_code,
            city=address.city,
            country=address.country,
        )

    def prospect(self) -> ProspectProposal:
        civility = None
        if found := self.cell(ImportField.CIVILITY):
            column, value = found
            outcome = normalize_civility(value)
            civility = outcome.value
            self.settle(column, value, outcome.codes, keep=outcome.keep_raw, mapped=bool(civility))
        first_name = self.text(ImportField.FIRST_NAME)
        last_name = self.text(ImportField.LAST_NAME)
        if first_name is None and last_name is None:
            self.flag(DiagnosticCode.PROSPECT_MISSING_NAME)
        elif first_name is None or last_name is None:
            self.flag(DiagnosticCode.PROSPECT_PARTIAL_NAME)
        title = self.text(ImportField.JOB_TITLE)
        roles: list[TaxonomyMatch] = []
        if title is not None:
            column = self.by_field[ImportField.JOB_TITLE]
            roles, codes = match_role(title, self.reference.roles)
            for code in codes:
                self.flag(code, column, self.value(column))
        return ProspectProposal(
            civility=civility,
            first_name=normalize_name(first_name) if first_name else None,
            last_name=normalize_name(last_name) if last_name else None,
            exact_job_title=title,
            role_suggestions=roles,
        )

    def emails(self) -> list[EmailProposal]:
        found = self.cell(ImportField.EMAIL)
        if found is None:
            return []
        column, value = found
        outcome = parse_emails(value)
        addresses = outcome.value or ()
        self.settle(column, value, outcome.codes, keep=outcome.keep_raw, mapped=bool(addresses))
        return [
            EmailProposal(address=address, is_primary=index == 0)
            for index, address in enumerate(addresses)
        ]

    def phones(self) -> list[PhoneProposal]:
        """Numbers of `Téléphone` then `Mobile`, duplicates dropped; the primary is the first
        mobile number (direct line), else the first number."""
        found: list[tuple[ParsedPhone, str]] = []
        for phone_field in (ImportField.PHONE, ImportField.MOBILE):
            if cell := self.cell(phone_field):
                column, value = cell
                outcome = parse_phones(value, mobile_column=phone_field is ImportField.MOBILE)
                parsed = outcome.value or ()
                self.settle(
                    column, value, outcome.codes, keep=outcome.keep_raw, mapped=bool(parsed)
                )
                found.extend(
                    (phone, column.column)
                    for phone in parsed
                    if all(phone.number != known.number for known, _ in found)
                )
        primary = next(
            (index for index, (phone, _) in enumerate(found) if phone.type is PhoneType.MOBILE), 0
        )
        return [
            PhoneProposal(
                number=phone.number, type=phone.type, is_primary=index == primary, column=column
            )
            for index, (phone, column) in enumerate(found)
        ]

    def tracking(self) -> TrackingProposal | None:
        """Legacy stage columns collapse into one status: the most advanced positive stage wins.
        A negative stage below a positive one, or a stage without its prerequisite, is a
        conflict to review."""
        positive: list[ImportField] = []
        negative: list[ImportField] = []
        appointment = None
        for stage in STAGE_FIELDS:
            found = self.cell(stage)
            if found is None:
                continue
            column, value = found
            reading = read_stage(value)
            if reading.state is StageState.UNRECOGNIZED:
                codes = (DiagnosticCode.TRACKING_STAGE_UNRECOGNIZED,)
                self.settle(column, value, codes, keep=True, mapped=False)
                continue
            if stage is ImportField.STAGE_APPOINTMENT and reading.when is not None:
                appointment = reading.when
                self.mapped.add(column.column)
            else:
                self.settle(column, value, (), keep=not reading.plain, mapped=True)
            (positive if reading.state is StageState.POSITIVE else negative).append(stage)
        planned = self.planned_contact()
        referent = self.referent()
        if not positive and planned is None and not referent.suggestions:
            return None
        best = max(
            (STAGE_STATUS[stage] for stage in positive), key=STATUS_RANK.__getitem__, default=None
        )
        conflict = any(
            STATUS_RANK[STAGE_STATUS[stage]] < STATUS_RANK[best] for stage in negative if best
        ) or any(
            stage in positive and prerequisite not in positive
            for stage, prerequisite in STAGE_PREREQUISITES.items()
        )
        if conflict:
            self.flag(DiagnosticCode.TRACKING_STAGE_CONFLICT)
        return TrackingProposal(
            status=best or ContactTrackingStatus.TO_CONTACT,
            stages=positive,
            requires_review=conflict,
            planned_contact=planned,
            appointment_date=appointment,
            referent=referent.match,
            referent_suggestions=list(referent.suggestions),
        )

    def planned_contact(self) -> PlannedContactProposal | None:
        found = self.cell(ImportField.PLANNED_CONTACT)
        if found is None:
            return None
        column, value = found
        outcome = parse_planned_contact(value)
        planned = outcome.value
        self.settle(column, value, outcome.codes, keep=outcome.keep_raw, mapped=planned is not None)
        if outcome.suggests_inactive:
            self.suggest_inactive(column, value)
        if planned is None:
            return None
        return PlannedContactProposal(
            planned_date=planned.date,
            week=planned.week,
            year=planned.year,
            requires_year=planned.date is None,
        )

    def referent(self) -> ReferentOutcome:
        found = self.cell(ImportField.REFERENT)
        if found is None:
            return ReferentOutcome()
        column, value = found
        outcome = match_referent(value, self.reference.referents)
        self.settle(
            column, value, outcome.codes, keep=outcome.keep_raw, mapped=bool(outcome.suggestions)
        )
        if outcome.suggests_inactive:
            self.suggest_inactive(column, value)
        return outcome
