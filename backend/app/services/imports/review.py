"""Import review (Task 09): what the user must resolve, the safe defaults, and the checked plan.

Pure, like the engine: it reads a preview and the reference snapshot, nothing else.

- `build_review` groups the values to resolve **by raw value** (roles by job title, categories by
  token, referents, civilities, weeks without year, companies by company key) so one decision
  applies to every row at once, and proposes a default for each group and each row.
- Defaults are conservative: only exact matches on active values are applied; suggestions to
  confirm, unknown values, markers and notes are left out; a week without year stays without
  date; a do-not-contact match is excluded; a duplicate of an existing prospect (same e-mail, or
  same names and company) is attached to it, one of an earlier row of the file (same names and
  company) to that row; everything else is created.
- `plan_import` applies the user's overrides (`decisions.ImportDecisions`) to those defaults and
  validates the result against the preview and the reference snapshot: the commit writes only a
  plan without errors.
- `preview_digest` ties a commit to the exact preview the user reviewed (ADR-0012).
"""

import hashlib
import json
import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import date
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import Civility, ContactabilityStatus
from app.services.imports.decisions import (
    CategoryCreate,
    CategoryDecision,
    CategoryExisting,
    CategoryIgnore,
    CategorySegment,
    CompanyCreate,
    CompanyDecision,
    CompanyLink,
    ImportDecisions,
    ProspectAttach,
    ProspectAttachRow,
    ProspectCreate,
    ProspectExclude,
    ProspectResolution,
    ReferentDecision,
    ReferentExisting,
    ReferentIgnore,
    RoleCreate,
    RoleDecision,
    RoleExisting,
    RoleNone,
)
from app.services.imports.diagnostics import DiagnosticCode
from app.services.imports.fields import ImportField
from app.services.imports.models import (
    CandidateKind,
    CompanyCandidate,
    ImportPreview,
    MatchKind,
    MatchReason,
    PreviewRow,
    ReferentMatch,
    TaxonomyMatch,
)
from app.services.imports.reference import ImportReferenceData
from app.services.imports.text import fold, render

PERSON_REASONS = frozenset({MatchReason.SAME_EMAIL, MatchReason.SAME_PERSON})


def preview_digest(preview: ImportPreview) -> str:
    """SHA-256 of the canonical JSON of the preview (deterministic engine, sorted keys)."""
    canonical = json.dumps(
        preview.model_dump(mode="json"), sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode()).hexdigest()


def group_key(text: str) -> str:
    """Raw values that fold alike share one decision (`MR` and `Mr`, `S37` and `s37`)."""
    return fold(text) or " ".join(text.split())


# --- review model -------------------------------------------------------------------------------


class Frozen(BaseModel):
    model_config = ConfigDict(frozen=True)


class MatchStatus(StrEnum):
    EXACT = "exact"  # applied by default
    SUGGESTED = "suggested"  # close match, to confirm
    INACTIVE = "inactive"  # matches a deactivated value
    SEGMENT = "segment"  # a category token naming a commercial segment
    UNMATCHED = "unmatched"


class ReferentStatus(StrEnum):
    EXACT = "exact"
    PARTIAL = "partial"
    AMBIGUOUS = "ambiguous"
    INACTIVE = "inactive"
    UNKNOWN = "unknown"
    MARKER = "marker"
    EMAIL_LIKE = "email_like"
    WEEK_MARKER = "week_marker"
    NOTE = "note"


REFERENT_STATUS = {
    DiagnosticCode.REFERENT_PARTIAL_MATCH: ReferentStatus.PARTIAL,
    DiagnosticCode.REFERENT_AMBIGUOUS: ReferentStatus.AMBIGUOUS,
    DiagnosticCode.REFERENT_INACTIVE: ReferentStatus.INACTIVE,
    DiagnosticCode.REFERENT_UNKNOWN: ReferentStatus.UNKNOWN,
    DiagnosticCode.REFERENT_MARKER: ReferentStatus.MARKER,
    DiagnosticCode.REFERENT_EMAIL_LIKE: ReferentStatus.EMAIL_LIKE,
    DiagnosticCode.REFERENT_WEEK_MARKER: ReferentStatus.WEEK_MARKER,
    DiagnosticCode.REFERENT_NOTE: ReferentStatus.NOTE,
}


class RoleGroup(Frozen):
    key: str
    text: str  # the first job title of the group, as imported
    rows: list[int]
    status: MatchStatus
    suggestions: list[TaxonomyMatch]
    default: RoleDecision


class CategoryGroup(Frozen):
    key: str
    text: str
    rows: list[int]
    status: MatchStatus
    suggestions: list[TaxonomyMatch]  # category matches (exact, inactive or to confirm)
    segment: TaxonomyMatch | None  # commercial-segment suggestion
    default: CategoryDecision


class ReferentGroup(Frozen):
    key: str
    text: str
    rows: list[int]
    status: ReferentStatus
    suggestions: list[ReferentMatch]
    default: ReferentDecision


class WeekGroup(Frozen):
    key: str  # the week number
    week: int
    rows: list[int]


class CivilityGroup(Frozen):
    key: str
    text: str
    rows: list[int]


class CompanyGroup(Frozen):
    key: str
    display_name: str  # spelling of the group's first row
    variants: list[str]  # every spelling found in the file
    rows: list[int]
    candidates: list[CompanyCandidate]
    default: CompanyDecision


class ProspectRef(Frozen):
    """An existing prospect named as a duplicate candidate, enough to recognise them."""

    id: uuid.UUID
    first_name: str | None
    last_name: str | None
    company_name: str | None
    emails: list[str]
    contactability: ContactabilityStatus


class RowReview(Frozen):
    row_number: int
    role_key: str | None
    category_keys: list[str]
    referent_key: str | None
    week_key: str | None
    civility_key: str | None
    company_key: str | None
    inactive_suggested: bool
    default_resolution: ProspectResolution


class ImportReview(Frozen):
    preview: ImportPreview
    digest: str
    roles: list[RoleGroup]
    categories: list[CategoryGroup]
    referents: list[ReferentGroup]
    weeks: list[WeekGroup]
    civilities: list[CivilityGroup]
    companies: list[CompanyGroup]
    prospects: list[ProspectRef]
    rows: list[RowReview] = Field(default_factory=list)


# --- grouping -----------------------------------------------------------------------------------


def column_of(preview: ImportPreview, target: ImportField) -> str | None:
    return next((c.column for c in preview.summary.columns if c.field is target), None)


def cell_text(row: PreviewRow, column: str | None) -> str | None:
    """The row's raw cell in `column`, as the user sees it."""
    cell = next((c for c in row.cells if c.column == column), None)
    if cell is None or cell.value is None:
        return None
    text = " ".join(render(cell.value).split())
    return text or None


def taxonomy_status(match: TaxonomyMatch | None) -> MatchStatus:
    if match is None:
        return MatchStatus.UNMATCHED
    if match.match is MatchKind.EXACT:
        return MatchStatus.EXACT
    return MatchStatus.INACTIVE if match.match is MatchKind.INACTIVE else MatchStatus.SUGGESTED


def row_diagnostic(row: PreviewRow, codes: Iterable[DiagnosticCode]) -> DiagnosticCode | None:
    wanted = set(codes)
    return next((d.code for d in row.diagnostics if d.code in wanted), None)


@dataclass
class Grouped[T]:
    """Rows sharing a key, the first row's text, and whatever the first row said about it."""

    text: str
    info: T
    rows: list[int] = field(default_factory=list)


def add_to[T](groups: dict[str, Grouped[T]], key: str, text: str, info: T, row: int) -> None:
    group = groups.setdefault(key, Grouped(text, info))
    if row not in group.rows:
        group.rows.append(row)


def role_groups(preview: ImportPreview) -> tuple[list[RoleGroup], dict[int, str]]:
    groups: dict[str, Grouped[list[TaxonomyMatch]]] = {}
    keys: dict[int, str] = {}
    for row in preview.rows:
        title = row.prospect.exact_job_title
        if title:
            keys[row.row_number] = key = group_key(title)
            add_to(groups, key, title, row.prospect.role_suggestions, row.row_number)
    result = []
    for key, group in groups.items():
        status = taxonomy_status(group.info[0] if group.info else None)
        default: RoleDecision = (
            RoleExisting(role_id=group.info[0].id) if status is MatchStatus.EXACT else RoleNone()
        )
        result.append(
            RoleGroup(
                key=key,
                text=group.text,
                rows=group.rows,
                status=status,
                suggestions=group.info,
                default=default,
            )
        )
    return result, keys


@dataclass(frozen=True, slots=True)
class TokenInfo:
    status: MatchStatus
    match: TaxonomyMatch | None = None


def category_groups(preview: ImportPreview) -> tuple[list[CategoryGroup], dict[int, list[str]]]:
    groups: dict[str, Grouped[TokenInfo]] = {}
    keys: dict[int, list[str]] = defaultdict(list)
    for row in preview.rows:
        company = row.company
        if company is None:
            continue
        tokens: list[tuple[str, TokenInfo]] = [
            (m.source_text, TokenInfo(taxonomy_status(m), m)) for m in company.activity_categories
        ]
        tokens += [
            (text, TokenInfo(MatchStatus.UNMATCHED)) for text in company.unmatched_categories
        ]
        if company.segment_suggestion is not None:
            segment = company.segment_suggestion
            tokens.append((segment.source_text, TokenInfo(MatchStatus.SEGMENT, segment)))
        for text, info in tokens:
            key = group_key(text)
            if key not in keys[row.row_number]:
                keys[row.row_number].append(key)
            add_to(groups, key, text, info, row.row_number)
    result = []
    for key, group in groups.items():
        info = group.info
        default: CategoryDecision = CategoryIgnore()
        if info.status is MatchStatus.EXACT and info.match is not None:
            default = CategoryExisting(category_ids=[info.match.id])
        is_segment = info.status is MatchStatus.SEGMENT
        result.append(
            CategoryGroup(
                key=key,
                text=group.text,
                rows=group.rows,
                status=info.status,
                suggestions=[info.match] if info.match is not None and not is_segment else [],
                segment=info.match if is_segment else None,
                default=default,
            )
        )
    return result, dict(keys)


def referent_groups(preview: ImportPreview) -> tuple[list[ReferentGroup], dict[int, str]]:
    column = column_of(preview, ImportField.REFERENT)
    groups: dict[str, Grouped[tuple[ReferentStatus, list[ReferentMatch]]]] = {}
    keys: dict[int, str] = {}
    for row in preview.rows:
        text = cell_text(row, column)
        if text is None:
            continue
        code = row_diagnostic(row, REFERENT_STATUS)
        status = REFERENT_STATUS[code] if code else ReferentStatus.EXACT
        suggestions = row.tracking.referent_suggestions if row.tracking else []
        keys[row.row_number] = key = group_key(text)
        add_to(groups, key, text, (status, suggestions), row.row_number)
    result = []
    for key, group in groups.items():
        status, suggestions = group.info
        default: ReferentDecision = ReferentIgnore()
        if status is ReferentStatus.EXACT and suggestions:
            default = ReferentExisting(referent_id=suggestions[0].id)
        result.append(
            ReferentGroup(
                key=key,
                text=group.text,
                rows=group.rows,
                status=status,
                suggestions=suggestions,
                default=default,
            )
        )
    return result, keys


def week_groups(preview: ImportPreview) -> tuple[list[WeekGroup], dict[int, str]]:
    groups: dict[int, list[int]] = {}
    keys: dict[int, str] = {}
    for row in preview.rows:
        planned = row.tracking.planned_contact if row.tracking else None
        if planned is not None and planned.requires_year and planned.week is not None:
            groups.setdefault(planned.week, []).append(row.row_number)
            keys[row.row_number] = str(planned.week)
    result = [
        WeekGroup(key=str(week), week=week, rows=rows) for week, rows in sorted(groups.items())
    ]
    return result, keys


def civility_groups(preview: ImportPreview) -> tuple[list[CivilityGroup], dict[int, str]]:
    groups: dict[str, Grouped[None]] = {}
    keys: dict[int, str] = {}
    for row in preview.rows:
        invalid = next(
            (d for d in row.diagnostics if d.code is DiagnosticCode.CIVILITY_INVALID), None
        )
        if invalid is None:
            continue
        text = " ".join(render(invalid.value).split())
        keys[row.row_number] = key = group_key(text)
        add_to(groups, key, text, None, row.row_number)
    result = [CivilityGroup(key=k, text=g.text, rows=g.rows) for k, g in groups.items()]
    return result, keys


def default_company(candidates: list[CompanyCandidate]) -> CompanyDecision:
    """Link to the existing company with the same name key when exactly one is the best match;
    a likely match (e-mail domain, close spelling) or a tie is left to the user."""
    same = [c for c in candidates if MatchReason.SAME_COMPANY_NAME in c.reasons]
    if not same or (len(same) > 1 and same[0].confidence == same[1].confidence):
        return CompanyCreate()
    return CompanyLink(company_id=same[0].company_id)


def company_groups(preview: ImportPreview) -> tuple[list[CompanyGroup], dict[int, str]]:
    groups: dict[str, Grouped[dict[uuid.UUID, CompanyCandidate]]] = {}
    variants: dict[str, list[str]] = defaultdict(list)
    keys: dict[int, str] = {}
    for row in preview.rows:
        company = row.company
        if company is None:
            continue
        keys[row.row_number] = key = company.match_key
        add_to(groups, key, company.display_name, {}, row.row_number)
        if company.display_name not in variants[key]:
            variants[key].append(company.display_name)
        merged = groups[key].info
        for candidate in company.candidates:
            known = merged.get(candidate.company_id)
            if known is not None:
                reasons = sorted(set(known.reasons) | set(candidate.reasons))
                confidence = max(known.confidence, candidate.confidence)
                candidate = known.model_copy(update={"reasons": reasons, "confidence": confidence})
            merged[candidate.company_id] = candidate
    result = []
    for key, group in groups.items():
        candidates = sorted(
            group.info.values(),
            key=lambda c: (-c.confidence, c.display_name.casefold(), str(c.company_id)),
        )
        result.append(
            CompanyGroup(
                key=key,
                display_name=group.text,
                variants=variants[key],
                rows=group.rows,
                candidates=candidates,
                default=default_company(candidates),
            )
        )
    return result, keys


def default_resolution(row: PreviewRow) -> ProspectResolution:
    if row.blocked_by_do_not_contact:
        return ProspectExclude()
    existing = [
        candidate
        for candidate in row.duplicates
        if candidate.kind is CandidateKind.EXISTING_PROSPECT
        and PERSON_REASONS & set(candidate.reasons)
        and candidate.prospect_id is not None
    ]
    if existing:
        return ProspectAttach(prospect_id=existing[0].prospect_id)
    earlier = [
        candidate.row
        for candidate in row.duplicates
        if candidate.kind is CandidateKind.FILE_ROW
        and MatchReason.SAME_PERSON in candidate.reasons
        and candidate.row is not None
        and candidate.row < row.row_number
    ]
    return ProspectAttachRow(row=min(earlier)) if earlier else ProspectCreate()


def prospect_refs(preview: ImportPreview, reference: ImportReferenceData) -> list[ProspectRef]:
    wanted = {
        candidate.prospect_id
        for row in preview.rows
        for candidate in row.duplicates
        if candidate.prospect_id is not None
    }
    companies = {company.id: company.display_name for company in reference.companies}
    return [
        ProspectRef(
            id=prospect.id,
            first_name=prospect.first_name,
            last_name=prospect.last_name,
            company_name=companies.get(prospect.company_id) if prospect.company_id else None,
            emails=list(prospect.emails),
            contactability=prospect.contactability_status,
        )
        for prospect in sorted(reference.prospects, key=lambda p: str(p.id))
        if prospect.id in wanted
    ]


def build_review(preview: ImportPreview, reference: ImportReferenceData) -> ImportReview:
    roles, role_keys = role_groups(preview)
    categories, category_keys = category_groups(preview)
    referents, referent_keys = referent_groups(preview)
    weeks, week_keys = week_groups(preview)
    civilities, civility_keys = civility_groups(preview)
    companies, company_keys = company_groups(preview)
    rows = [
        RowReview(
            row_number=row.row_number,
            role_key=role_keys.get(row.row_number),
            category_keys=category_keys.get(row.row_number, []),
            referent_key=referent_keys.get(row.row_number),
            week_key=week_keys.get(row.row_number),
            civility_key=civility_keys.get(row.row_number),
            company_key=company_keys.get(row.row_number),
            inactive_suggested=row.prospect.activity_status_suggestion is not None,
            default_resolution=default_resolution(row),
        )
        for row in preview.rows
    ]
    return ImportReview(
        preview=preview,
        digest=preview_digest(preview),
        roles=roles,
        categories=categories,
        referents=referents,
        weeks=weeks,
        civilities=civilities,
        companies=companies,
        prospects=prospect_refs(preview, reference),
        rows=rows,
    )


# --- plan ---------------------------------------------------------------------------------------


class DecisionErrorCode(StrEnum):
    UNKNOWN_ROW = "unknown_row"
    UNKNOWN_KEY = "unknown_key"  # a grouped decision for a value the preview does not contain
    UNKNOWN_VALUE = "unknown_value"  # role, category, segment, referent or company id not found
    INVALID_WEEK_YEAR = "invalid_week_year"  # week 53 in a year that has only 52
    INACTIVE_NOT_SUGGESTED = "inactive_not_suggested"
    MISSING_NAME = "missing_name"  # a prospect cannot be created without any name
    BLOCKED_BY_DO_NOT_CONTACT = "blocked_by_do_not_contact"  # only exclude or attach to them
    NOT_A_CANDIDATE = "not_a_candidate"  # attach target is not a duplicate candidate of the row
    ATTACHED_TO_EXCLUDED = "attached_to_excluded"
    ATTACH_CYCLE = "attach_cycle"
    NOTHING_TO_IMPORT = "nothing_to_import"


class DecisionError(Frozen):
    code: DecisionErrorCode
    row: int | None = None
    group: str | None = None  # roles, categories, referents, civilities, weeks, companies
    key: str | None = None


@dataclass(frozen=True, slots=True)
class RoleChoice:
    role_id: uuid.UUID | None = None
    create_label: str | None = None  # a role the user creates at commit time


@dataclass(frozen=True, slots=True)
class RowPlan:
    row: PreviewRow
    resolution: ProspectResolution
    root_row: int | None = None  # attach_row: the created/attached row that receives this one
    company_key: str | None = None
    role: RoleChoice = RoleChoice()
    civility: Civility | None = None
    referent_id: uuid.UUID | None = None
    planned_date: date | None = None
    inactive: bool = False
    categories_ignored: bool = False  # a category token of the row is left out by decision
    referent_ignored: bool = False  # the row's `Référent` value is left out by decision

    @property
    def imported(self) -> bool:
        return not isinstance(self.resolution, ProspectExclude)


@dataclass(frozen=True, slots=True)
class CompanyPlan:
    key: str
    rows: tuple[int, ...]  # imported rows, in source order
    link_id: uuid.UUID | None  # None: create the company
    category_ids: tuple[uuid.UUID, ...] = ()
    category_labels: tuple[str, ...] = ()  # categories the user creates at commit time
    segment_id: uuid.UUID | None = None


@dataclass(frozen=True, slots=True)
class ImportPlan:
    rows: tuple[RowPlan, ...]
    companies: dict[str, CompanyPlan]
    role_labels: tuple[str, ...]  # distinct (folded) role labels to create
    category_labels: tuple[str, ...]
    errors: tuple[DecisionError, ...]

    def row(self, number: int) -> RowPlan:
        return next(plan for plan in self.rows if plan.row.row_number == number)


class Planner:
    def __init__(
        self, review: ImportReview, reference: ImportReferenceData, decisions: ImportDecisions
    ) -> None:
        self.review = review
        self.reference = reference
        self.decisions = decisions
        self.errors: list[DecisionError] = []
        self.previews = {row.row_number: row for row in review.preview.rows}
        self.reviews = {row.row_number: row for row in review.rows}

    def error(self, code: DecisionErrorCode, **where: object) -> None:
        self.errors.append(DecisionError(code=code, **where))

    def check_keys(self, group: str, given: Mapping[str, object], known: Iterable[str]) -> None:
        for key in sorted(set(given) - set(known)):
            self.error(DecisionErrorCode.UNKNOWN_KEY, group=group, key=key)

    def check_value(self, found: bool, group: str, key: str) -> None:
        if not found:
            self.error(DecisionErrorCode.UNKNOWN_VALUE, group=group, key=key)

    # -- grouped decisions --

    def roles(self) -> dict[str, RoleChoice]:
        known = {value.id for value in self.reference.roles}
        choices: dict[str, RoleChoice] = {}
        self.check_keys("roles", self.decisions.roles, (g.key for g in self.review.roles))
        for group in self.review.roles:
            decision = self.decisions.roles.get(group.key, group.default)
            match decision:
                case RoleExisting(role_id=role_id):
                    self.check_value(role_id in known, "roles", group.key)
                    choices[group.key] = RoleChoice(role_id=role_id)
                case RoleCreate(label=label):
                    choices[group.key] = RoleChoice(create_label=label)
                case _:
                    choices[group.key] = RoleChoice()
        return choices

    def categories(self) -> dict[str, CategoryDecision]:
        categories = {value.id for value in self.reference.activity_categories}
        segments = {value.id for value in self.reference.commercial_segments}
        groups = self.review.categories
        self.check_keys("categories", self.decisions.categories, (g.key for g in groups))
        chosen: dict[str, CategoryDecision] = {}
        for group in groups:
            decision = self.decisions.categories.get(group.key, group.default)
            match decision:
                case CategoryExisting(category_ids=ids):
                    self.check_value(set(ids) <= categories, "categories", group.key)
                case CategorySegment(segment_id=segment_id):
                    self.check_value(segment_id in segments, "categories", group.key)
            chosen[group.key] = decision
        return chosen

    def referents(self) -> dict[str, uuid.UUID | None]:
        known = {value.id for value in self.reference.referents}
        groups = self.review.referents
        self.check_keys("referents", self.decisions.referents, (g.key for g in groups))
        chosen: dict[str, uuid.UUID | None] = {}
        for group in groups:
            decision = self.decisions.referents.get(group.key, group.default)
            if isinstance(decision, ReferentExisting):
                self.check_value(decision.referent_id in known, "referents", group.key)
                chosen[group.key] = decision.referent_id
            else:
                chosen[group.key] = None
        return chosen

    def weeks(self) -> dict[str, date | None]:
        self.check_keys("weeks", self.decisions.weeks, (g.key for g in self.review.weeks))
        dates: dict[str, date | None] = {}
        for group in self.review.weeks:
            # An explicit `None` for this week leaves it without date whatever the batch year.
            year = self.decisions.weeks.get(group.key, self.decisions.week_year)
            dates[group.key] = None
            if year is not None:
                try:
                    dates[group.key] = date.fromisocalendar(year, group.week, 1)
                except ValueError:
                    self.error(DecisionErrorCode.INVALID_WEEK_YEAR, group="weeks", key=group.key)
        return dates

    def companies(self) -> dict[str, CompanyDecision]:
        known = {company.id for company in self.reference.companies}
        groups = self.review.companies
        self.check_keys("companies", self.decisions.companies, (g.key for g in groups))
        chosen: dict[str, CompanyDecision] = {}
        for group in groups:
            decision = self.decisions.companies.get(group.key, group.default)
            if isinstance(decision, CompanyLink):
                self.check_value(decision.company_id in known, "companies", group.key)
            chosen[group.key] = decision
        return chosen

    # -- rows --

    def resolution(self, number: int) -> ProspectResolution:
        decision = self.decisions.rows.get(number)
        if decision is not None and decision.resolution is not None:
            return decision.resolution
        return self.reviews[number].default_resolution

    def check_resolution(self, row: PreviewRow, resolution: ProspectResolution) -> bool:
        """Whether the resolution is allowed for the row (errors are recorded otherwise)."""
        number = row.row_number
        before = len(self.errors)
        match resolution:
            case ProspectCreate():
                if row.blocked_by_do_not_contact:
                    self.error(DecisionErrorCode.BLOCKED_BY_DO_NOT_CONTACT, row=number)
                if row_diagnostic(row, [DiagnosticCode.PROSPECT_MISSING_NAME]):
                    self.error(DecisionErrorCode.MISSING_NAME, row=number)
            case ProspectAttach(prospect_id=prospect_id):
                candidate = next(
                    (
                        c
                        for c in row.duplicates
                        if c.kind is CandidateKind.EXISTING_PROSPECT
                        and c.prospect_id == prospect_id
                    ),
                    None,
                )
                if candidate is None:
                    self.error(DecisionErrorCode.NOT_A_CANDIDATE, row=number)
                elif row.blocked_by_do_not_contact and not (
                    candidate.contactability is ContactabilityStatus.DO_NOT_CONTACT
                    and PERSON_REASONS & set(candidate.reasons)
                ):
                    self.error(DecisionErrorCode.BLOCKED_BY_DO_NOT_CONTACT, row=number)
            case ProspectAttachRow(row=target):
                if row.blocked_by_do_not_contact:
                    self.error(DecisionErrorCode.BLOCKED_BY_DO_NOT_CONTACT, row=number)
                elif not any(
                    c.kind is CandidateKind.FILE_ROW and c.row == target for c in row.duplicates
                ):
                    self.error(DecisionErrorCode.NOT_A_CANDIDATE, row=number)
        return len(self.errors) == before

    def roots(self, resolutions: dict[int, ProspectResolution], valid: set[int]) -> dict[int, int]:
        """attach_row → the row whose prospect finally receives it (following chains)."""
        roots: dict[int, int] = {}
        for number, resolution in resolutions.items():
            if not isinstance(resolution, ProspectAttachRow) or number not in valid:
                continue
            seen = [number]
            target = resolution.row
            while isinstance(resolutions.get(target), ProspectAttachRow) and target not in seen:
                seen.append(target)
                target = resolutions[target].row  # type: ignore[union-attr]
            if target in seen:
                self.error(DecisionErrorCode.ATTACH_CYCLE, row=number)
            elif isinstance(resolutions.get(target), ProspectExclude | None):
                self.error(DecisionErrorCode.ATTACHED_TO_EXCLUDED, row=number)
            else:
                roots[number] = target
        return roots

    def plan(self) -> ImportPlan:
        for number in sorted(set(self.decisions.rows) - set(self.previews)):
            self.error(DecisionErrorCode.UNKNOWN_ROW, row=number)
        roles = self.roles()
        categories = self.categories()
        referents = self.referents()
        weeks = self.weeks()
        companies = self.companies()
        civilities = self.decisions.civilities
        self.check_keys("civilities", civilities, (g.key for g in self.review.civilities))
        resolutions = {number: self.resolution(number) for number in self.previews}
        valid = {
            number
            for number, resolution in resolutions.items()
            if self.check_resolution(self.previews[number], resolution)
        }
        roots = self.roots(resolutions, valid)
        rows = []
        for number, row in self.previews.items():
            review = self.reviews[number]
            decision = self.decisions.rows.get(number)
            inactive = bool(decision and decision.inactive)
            if inactive and not review.inactive_suggested:
                self.error(DecisionErrorCode.INACTIVE_NOT_SUGGESTED, row=number)
            planned = row.tracking.planned_contact if row.tracking else None
            planned_date = planned.planned_date if planned else None
            if review.week_key is not None:
                planned_date = weeks.get(review.week_key)
            civility = row.prospect.civility
            if review.civility_key is not None:
                civility = civilities.get(review.civility_key)
            rows.append(
                RowPlan(
                    row=row,
                    resolution=resolutions[number],
                    root_row=roots.get(number),
                    company_key=review.company_key,
                    role=roles[review.role_key] if review.role_key else RoleChoice(),
                    civility=civility,
                    referent_id=referents.get(review.referent_key) if review.referent_key else None,
                    planned_date=planned_date,
                    inactive=inactive and review.inactive_suggested,
                    categories_ignored=any(
                        isinstance(categories[key], CategoryIgnore) for key in review.category_keys
                    ),
                    referent_ignored=review.referent_key is not None
                    and referents[review.referent_key] is None,
                )
            )
        if not any(plan.imported for plan in rows):
            self.error(DecisionErrorCode.NOTHING_TO_IMPORT)
        company_plans = self.company_plans(rows, companies, categories)
        return ImportPlan(
            rows=tuple(rows),
            companies=company_plans,
            role_labels=distinct(c.create_label for c in roles.values() if c.create_label),
            category_labels=distinct(
                label for plan in company_plans.values() for label in plan.category_labels
            ),
            errors=tuple(self.errors),
        )

    def company_plans(
        self,
        rows: list[RowPlan],
        companies: dict[str, CompanyDecision],
        categories: dict[str, CategoryDecision],
    ) -> dict[str, CompanyPlan]:
        members: dict[str, list[RowPlan]] = defaultdict(list)
        for plan in rows:
            if plan.imported and plan.company_key is not None:
                members[plan.company_key].append(plan)
        result = {}
        for key, plans in members.items():
            ids: list[uuid.UUID] = []
            labels: list[str] = []
            segment: uuid.UUID | None = None
            for plan in plans:
                for token in self.reviews[plan.row.row_number].category_keys:
                    match categories[token]:
                        case CategoryExisting(category_ids=chosen):
                            ids += [id_ for id_ in chosen if id_ not in ids]
                        case CategoryCreate(label=label):
                            labels.append(label)
                        case CategorySegment(segment_id=segment_id) if segment is None:
                            segment = segment_id
            decision = companies[key]
            result[key] = CompanyPlan(
                key=key,
                rows=tuple(plan.row.row_number for plan in plans),
                link_id=decision.company_id if isinstance(decision, CompanyLink) else None,
                category_ids=tuple(ids),
                category_labels=distinct(labels),
                segment_id=segment,
            )
        return result


def distinct(labels: Iterable[str]) -> tuple[str, ...]:
    """Labels in first-seen order, one per folded form (the Settings uniqueness rule)."""
    seen: dict[str, str] = {}
    for label in labels:
        seen.setdefault(fold(label) or label, label)
    return tuple(seen.values())


def plan_import(
    review: ImportReview, reference: ImportReferenceData, decisions: ImportDecisions
) -> ImportPlan:
    """The user's decisions over the review's defaults, validated. `errors` empty = committable."""
    return Planner(review, reference, decisions).plan()
