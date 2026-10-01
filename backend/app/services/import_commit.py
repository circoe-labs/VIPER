"""Excel import review and commit (Task 09, ADR-0012).

Stateless: the browser keeps the file. `review_upload` previews it (engine + review defaults +
re-import warning); `commit_import` receives the same file again with the user's decisions,
re-runs the preview on a fresh reference snapshot, refuses if the file or the preview changed
(fingerprint, digest), validates the plan, then writes everything in **one savepoint** of the
request's transaction:

    roles/categories and new cohorts (with their real dates) the user chose to create (by the
    user, audited Settings services) → batch `pending` (by the user) → inside
    `import_batches.importing` (import actor, on behalf of the user): companies (+ establishment)
    → prospects (+ e-mails/phones `imported`, `unverified`) or merges into existing ones →
    contact tracking (history) → cohorts, sequences, imported sends and « Défaillant »
    (`operational_import`) → one `import_row_metadata` per source row (raw snapshot of every
    non-empty cell, excluded rows included) and one `excel_import` source per imported row →
    batch `committed`.

Any failure while writing rolls the savepoint back (no partial data) and records a `failed` batch
in the request's transaction instead, so the history shows the attempt. Merge rules: human
precedence (D11, `import_precedence`) — an empty field is filled unless a person set or emptied
it, a different value is never written and raises an `import_conflict` alert on the prospect or
the company; contactability is never touched; a value the import does not apply stays in the
row's legacy metadata.
"""

import logging
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, time
from functools import partial

from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.core.business_time import BUSINESS_TIMEZONE
from app.models.companies import Company
from app.models.enums import (
    ActivityStatus,
    ContactabilityStatus,
    ContactTrackingStatus,
    ImportBatchStatus,
    OriginType,
)
from app.models.imports import ImportBatch
from app.models.prospects import Prospect
from app.services import (
    audit,
    cohorts,
    companies,
    import_batches,
    operational_import,
    prospects,
    provenance,
    taxonomies,
)
from app.services import import_precedence as precedence
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from app.services.errors import DomainError, DuplicateValueError, InvalidInputError
from app.services.import_precedence import AlertRecorder, Reason, RowRef
from app.services.imports.decisions import (
    ImportDecisions,
    PreviewOptions,
    ProspectAttach,
    ProspectAttachRow,
    ProspectCreate,
)
from app.services.imports.fields import ImportField
from app.services.imports.models import (
    CandidateKind,
    CompanyProposal,
    ImportPreview,
    LegacyReason,
    LegacyValue,
    PreviewRow,
)
from app.services.imports.preview import ImportFile, build_preview
from app.services.imports.reference_loader import load_reference_data
from app.services.imports.review import (
    PERSON_REASONS,
    DecisionError,
    ImportPlan,
    ImportReview,
    RowPlan,
    build_review,
    plan_import,
)
from app.services.imports.rows import COMPANY_TEXT_FIELDS
from app.services.imports.text import fold
from app.services.imports.verification import row_activity
from app.services.imports.workbook import ImportLimits

logger = logging.getLogger(__name__)
# Follow-up stage columns: sends without a known date (never a state, D1/D7): kept raw.
SEND_STAGES = (ImportField.STAGE_FOLLOW_UP_1, ImportField.STAGE_FOLLOW_UP_2)
TRACKING_FIELDS = (
    ImportField.STAGE_APPOINTMENT,
    ImportField.STAGE_QUOTE_SENT,
    ImportField.STAGE_QUOTE_FOLLOW_UP,
    ImportField.STAGE_FOLLOW_UP_1,
    ImportField.STAGE_FOLLOW_UP_2,
)


# --- refusals ---------------------------------------------------------------------------------


class StalePreviewError(DomainError):
    """The file sent with the decisions is not the reviewed one (`file_changed`), or the database
    changed since the review in a way that changes the preview (`preview_outdated`)."""

    def __init__(self, code: str) -> None:
        super().__init__(f"Import preview is stale: {code}.")
        self.code = code


class ReimportNotAcknowledgedError(DomainError):
    """The same file was already committed; the user must acknowledge the warning."""

    def __init__(self, previous: list[ImportBatch]) -> None:
        super().__init__("This file was already imported.")
        self.previous = previous


class InvalidDecisionsError(InvalidInputError):
    def __init__(self, errors: tuple[DecisionError, ...]) -> None:
        super().__init__("The import decisions cannot be applied.")
        self.errors = errors


class ImportCommitFailedError(DomainError):
    """Writing failed: nothing was imported and a `failed` batch records the attempt."""

    def __init__(self, batch_id: uuid.UUID, row: int | None, reason: str) -> None:
        super().__init__("The import failed; nothing was imported.")
        self.batch_id = batch_id
        self.row = row
        self.reason = reason


class _RowFailure(Exception):
    def __init__(self, row: int | None, error: Exception) -> None:
        super().__init__(type(error).__name__)
        self.row = row
        self.error = error


# --- preview ----------------------------------------------------------------------------------


def review_upload(
    session: Session, file: ImportFile, options: PreviewOptions, limits: ImportLimits
) -> tuple[ImportReview, list[ImportBatch]]:
    """The review of an uploaded file and the committed imports of the same file, if any."""
    reference = load_reference_data(session)
    preview = build_preview(file, reference, options.mapping, options.corrections, limits=limits)
    previous = import_batches.committed_with_fingerprint(session, preview.summary.file_fingerprint)
    return build_review(preview, reference), previous


# --- commit -----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CommitResult:
    batch: ImportBatch
    counts: dict[str, int]


def commit_import(
    session: Session,
    actor: ActorContext,
    file: ImportFile,
    decisions: ImportDecisions,
    limits: ImportLimits,
) -> CommitResult:
    """Apply `decisions` to `file` in one savepoint (see the module docstring).

    Refusals before any write: `ImportRejectedError` (file), `StalePreviewError`,
    `ReimportNotAcknowledgedError`, `InvalidDecisionsError`, `DuplicateValueError` (a role or
    category to create already exists). A failure while writing raises `ImportCommitFailedError`
    after recording the failed batch — the caller must commit its transaction to keep that record.
    """
    reference = load_reference_data(session)
    preview = build_preview(
        file, reference, decisions.mapping, decisions.corrections, limits=limits
    )
    if preview.summary.file_fingerprint != decisions.file_fingerprint:
        raise StalePreviewError("file_changed")
    review = build_review(preview, reference)
    if review.digest != decisions.preview_digest:
        raise StalePreviewError("preview_outdated")
    previous = import_batches.committed_with_fingerprint(session, preview.summary.file_fingerprint)
    if previous and not decisions.acknowledge_reimport:
        raise ReimportNotAcknowledgedError(previous)
    plan = plan_import(review, reference, decisions)
    if plan.errors:
        raise InvalidDecisionsError(plan.errors)
    try:
        with session.begin_nested():
            return Committer(session, actor, preview, plan, decisions).run()
    except DuplicateValueError:
        raise
    except Exception as error:  # any failure: nothing of the import is kept
        failure = error if isinstance(error, _RowFailure) else _RowFailure(None, error)
        # Class names only: database and library messages may quote imported values.
        logger.error(
            "Import commit failed on row %s: %s", failure.row, type(failure.error).__name__
        )
        batch = record_failure(session, actor, preview, decisions)
        raise ImportCommitFailedError(batch.id, failure.row, reason_of(failure.error)) from None


def reason_of(error: Exception) -> str:
    return "invalid" if isinstance(error, DomainError) else "unexpected"


def record_failure(
    session: Session, actor: ActorContext, preview: ImportPreview, decisions: ImportDecisions
) -> ImportBatch:
    batch = start(session, actor, preview, decisions)
    return import_batches.finish_batch(
        session,
        actor,
        batch,
        ImportBatchStatus.FAILED,
        rows_total=preview.summary.rows_total,
        rows_imported=0,
        rows_skipped=0,
    )


def start(
    session: Session, actor: ActorContext, preview: ImportPreview, decisions: ImportDecisions
) -> ImportBatch:
    summary = preview.summary
    return import_batches.start_batch(
        session,
        actor,
        filename=summary.file_name,
        sheet_names=[summary.sheet] if summary.sheet else [],
        file_fingerprint=summary.file_fingerprint,
        legal_basis_or_collection_context=decisions.legal_basis_or_collection_context,
        source_reference=decisions.source_reference,
    )


def at_midnight(day: date | None) -> datetime | None:
    return datetime.combine(day, time(), tzinfo=BUSINESS_TIMEZONE) if day else None


@dataclass(frozen=True, slots=True)
class CompanyValues:
    """What a company holds after the import, to tell which row values were not applied."""

    id: uuid.UUID
    display_name: str
    texts: dict[str, str | None]
    establishment_row: int | None  # the row whose address became the establishment


class Committer:
    def __init__(
        self,
        session: Session,
        actor: ActorContext,
        preview: ImportPreview,
        plan: ImportPlan,
        decisions: ImportDecisions,
    ) -> None:
        self.session = session
        self.actor = actor  # the person who validates the import
        self.importer = actor  # replaced by the import actor while importing
        self.preview = preview
        self.plan = plan
        self.decisions = decisions
        self.sheet = preview.summary.sheet or ""
        self.columns = {c.field: c for c in preview.summary.columns if c.field is not None}
        self.headers = {c.column: c.header for c in preview.summary.columns}
        self.counts: Counter[str] = Counter()
        self.role_ids: dict[str, uuid.UUID] = {}
        self.category_ids: dict[str, uuid.UUID] = {}
        self.companies: dict[str, CompanyValues] = {}
        self.receivers: dict[int, Prospect] = {}  # row → the prospect it created or merged into
        self.extra: dict[int, dict[str, LegacyValue]] = {}
        self.attached: set[uuid.UUID] = set()
        self.created: set[uuid.UUID] = set()  # prospects created by this import
        self.batch: ImportBatch | None = None
        self.alerts: AlertRecorder | None = None

    def run(self) -> CommitResult:
        self.create_taxonomies()
        self.create_cohorts()
        batch = self.batch = start(self.session, self.actor, self.preview, self.decisions)
        with import_batches.importing(self.session, batch, self.actor) as importer:
            self.importer = importer
            self.alerts = AlertRecorder(self.session, importer)
            for company in self.plan.companies.values():
                self.guarded(company.rows[0], partial(self.company, company.key))
            # Rows creating or attaching first, so that merges into another row find its prospect.
            direct = (ProspectCreate, ProspectAttach)
            ordered = sorted(self.plan.rows, key=lambda p: not isinstance(p.resolution, direct))
            for plan in ordered:
                if plan.imported:
                    self.guarded(plan.row.row_number, partial(self.prospect, plan))
            self.reconcile_operations()
            for plan in self.plan.rows:
                self.guarded(plan.row.row_number, partial(self.trace, plan, batch))
        imported = sum(1 for plan in self.plan.rows if plan.imported)
        finished = import_batches.finish_batch(
            self.session,
            self.actor,
            batch,
            ImportBatchStatus.COMMITTED,
            rows_total=len(self.plan.rows),
            rows_imported=imported,
            rows_skipped=len(self.plan.rows) - imported,
        )
        self.counts["rows_total"] = len(self.plan.rows)
        self.counts["rows_imported"] = imported
        self.counts["rows_excluded"] = len(self.plan.rows) - imported
        self.counts["prospects_attached"] = len(self.attached)
        self.counts["alerts_raised"] = self.alerts.raised if self.alerts else 0
        return CommitResult(finished, dict(self.counts))

    @staticmethod
    def guarded(row: int, step: Callable[[], None]) -> None:
        """Run one step; a failure is reported with the source row it concerns."""
        try:
            step()
        except DuplicateValueError:
            raise
        except Exception as error:
            raise _RowFailure(row, error) from None

    def ref(self, row: int) -> RowRef:
        assert self.batch is not None
        return RowRef(self.batch.id, self.preview.summary.file_name, self.sheet, row)

    @property
    def recorder(self) -> AlertRecorder:
        assert self.alerts is not None
        return self.alerts

    # --- Settings values the user chose to create ---

    def create_taxonomies(self) -> None:
        for label in self.plan.role_labels:
            value = taxonomies.create_value(
                self.session, self.actor, taxonomies.Taxonomy.ROLE, label
            )
            self.role_ids[fold(label) or label] = value.id
            self.counts["roles_created"] += 1
        for label in self.plan.category_labels:
            value = taxonomies.create_value(
                self.session, self.actor, taxonomies.Taxonomy.ACTIVITY_CATEGORY, label
            )
            self.category_ids[fold(label) or label] = value.id
            self.counts["categories_created"] += 1

    def create_cohorts(self) -> None:
        """New cohort codes of the file, with the real date the user gave (D5), by the user."""
        for code, starts_on in self.plan.new_cohorts.items():
            cohorts.create_cohort(self.session, self.actor, code, starts_on)
            self.counts["cohorts_created"] += 1

    # --- companies ---

    def company(self, key: str) -> None:
        plan = self.plan.companies[key]
        rows = [self.plan.row(number) for number in plan.rows]
        proposals = [(p.row.row_number, p.row.company) for p in rows if p.row.company is not None]
        first = proposals[0][1]
        texts = {
            name.value: next(
                (value for _, c in proposals if (value := fitting(getattr(c, name.value)))), None
            )
            for name in COMPANY_TEXT_FIELDS
        }
        domain = next((c.email_domain for _, c in proposals if c.email_domain), None)
        site_row, site = next(
            ((number, c.establishment) for number, c in proposals if c.establishment), (None, None)
        )
        created = [self.category_ids[fold(label) or label] for label in plan.category_labels]
        category_ids = [*plan.category_ids, *created]
        establishment = (
            companies.EstablishmentInput(**site.model_dump(), is_primary=True) if site else None
        )
        if plan.link_id is None:
            detail = companies.create_company(
                self.session,
                self.importer,
                companies.CompanyInput(
                    display_name=first.display_name,
                    email_domain=domain,
                    commercial_segment_id=plan.segment_id,
                    activity_category_ids=category_ids,
                    establishments=[establishment] if establishment else [],
                    **texts,
                ),
            )
            self.counts["companies_created"] += 1
        else:
            completion = self.company_completion(
                plan.link_id,
                self.ref(plan.rows[0]),
                companies.CompanyCompletion(
                    email_domain=domain,
                    commercial_segment_id=plan.segment_id,
                    activity_category_ids=category_ids,
                    establishment=establishment,
                    **texts,
                ),
            )
            if completion.establishment is None:
                site_row = None
            detail = companies.complete_company(
                self.session, self.importer, plan.link_id, completion
            )
            self.counts["companies_linked"] += 1
            linked = self.session.get(Company, plan.link_id)
            held = {category.id for category in linked.activity_categories} if linked else set()
            refused = set(category_ids) - held or (
                plan.segment_id is not None
                and (linked is None or linked.commercial_segment_id != plan.segment_id)
            )
            if refused:  # categories or segment the company did not take: kept raw
                for plan_row in rows:
                    self.keep(plan_row.row, ImportField.CATEGORY)
        values = CompanyValues(
            id=detail.id,
            display_name=detail.display_name,
            texts={name.value: getattr(detail, name.value) for name in COMPANY_TEXT_FIELDS},
            establishment_row=site_row,
        )
        self.companies[key] = values
        for plan_row in rows:
            self.keep_company_values(plan_row, values)

    def company_completion(
        self, company_id: uuid.UUID, ref: RowRef, wanted: companies.CompanyCompletion
    ) -> companies.CompanyCompletion:
        """What the file may fill on an existing company (D11, handoff §16): empty fields a person
        did not empty; a different value stays and raises an `import_conflict` on the company."""
        company = self.session.get(Company, company_id)
        assert company is not None
        human = precedence.human_fields(self.session, "company", company_id)
        sites_by_person = bool(
            precedence.human_children(self.session, "company", company_id, ("establishment",))
        )

        def check(name: str, current: object, incoming: object) -> bool:
            return self.applies(
                name, current, incoming, human, ref, company_id=company_id, alert=True
            )

        texts = {
            name.value: getattr(wanted, name.value)
            if check(name.value, getattr(company, name.value), getattr(wanted, name.value))
            else None
            for name in COMPANY_TEXT_FIELDS
        }
        segment = wanted.commercial_segment_id
        if not check("commercial_segment_id", company.commercial_segment_id, segment):
            segment = None
        current_ids = {category.id for category in company.activity_categories}
        category_ids: list[uuid.UUID] = list(wanted.activity_category_ids)
        if category_ids and not set(category_ids) <= current_ids:
            name = "activity_categories_ids"
            if current_ids:
                self.recorder.conflict(
                    ref,
                    "activity_category_ids",
                    sorted(current_ids, key=str),
                    category_ids,
                    company_id=company_id,
                )
                category_ids = []
            elif name in human:
                self.recorder.conflict(
                    ref,
                    "activity_category_ids",
                    None,
                    category_ids,
                    company_id=company_id,
                    reason=Reason.HUMAN_CLEARED,
                )
                category_ids = []
        else:
            category_ids = []
        domain = wanted.email_domain if "email_domain" not in human else None
        site = wanted.establishment
        if site is not None:
            known = [
                _address(s.address_line1, s.postal_code, s.city) for s in company.establishments
            ]
            incoming = _address(site.address_line1, site.postal_code, site.city)
            if any(precedence.same_text(incoming, other) for other in known):
                site = None
            elif known:
                self.recorder.conflict(ref, "address", known[0], incoming, company_id=company_id)
                site = None
            elif sites_by_person:
                self.recorder.conflict(
                    ref,
                    "address",
                    None,
                    incoming,
                    company_id=company_id,
                    reason=Reason.HUMAN_CLEARED,
                )
                site = None
        return companies.CompanyCompletion(
            email_domain=domain,
            commercial_segment_id=segment,
            activity_category_ids=category_ids,
            establishment=site,
            **texts,
        )

    def keep_company_values(self, plan: RowPlan, values: CompanyValues) -> None:
        """Row values the company does not hold (another spelling, a conflicting text, a second
        address, an ignored category) stay in the row's legacy metadata."""
        proposal: CompanyProposal | None = plan.row.company
        if proposal is None:
            return
        if proposal.display_name != values.display_name:
            self.keep(plan.row, ImportField.COMPANY_NAME)
        for name in COMPANY_TEXT_FIELDS:
            value = getattr(proposal, name.value)
            if value is not None and value != values.texts[name.value]:
                self.keep(plan.row, name)
        if proposal.establishment is not None and values.establishment_row != plan.row.row_number:
            self.keep(plan.row, ImportField.ADDRESS)
        if plan.categories_ignored:
            self.keep(plan.row, ImportField.CATEGORY)

    # --- human precedence (D11) ---

    def applies(
        self,
        name: str,
        current: object,
        incoming: object,
        human: frozenset[str],
        ref: RowRef,
        *,
        prospect_id: uuid.UUID | None = None,
        company_id: uuid.UUID | None = None,
        alert: bool,
        viper_label: object = None,
        file_label: object = None,
    ) -> bool:
        """Whether the file's value fills the field. Empty → fill unless a person set/emptied it;
        same → nothing; different → kept, with an `import_conflict` alert when `alert` (an
        existing record; two rows of the same new prospect only keep the raw value)."""
        if precedence.is_empty(name, incoming) or precedence.same_text(current, incoming):
            return False
        if precedence.is_empty(name, current) and name not in human:
            return True
        if alert:
            self.recorder.conflict(
                ref,
                name,
                None if precedence.is_empty(name, current) else (viper_label or current),
                file_label or incoming,
                prospect_id=prospect_id,
                company_id=company_id,
                reason=Reason.HUMAN_CLEARED
                if precedence.is_empty(name, current)
                else Reason.DIFFERENT,
            )
        return False

    # --- prospects ---

    def prospect(self, plan: RowPlan) -> None:
        row = plan.row
        match plan.resolution:
            case ProspectCreate():
                self.create(plan)
            case ProspectAttach(prospect_id=prospect_id):
                self.merge(plan, prospects.get_prospect(self.session, prospect_id))
                self.attached.add(prospect_id)
            case ProspectAttachRow():
                assert plan.root_row is not None
                self.merge(plan, self.receivers[plan.root_row])
                self.counts["rows_merged"] += 1
        if plan.referent_ignored:
            self.keep(row, ImportField.REFERENT)
        self.tracking(plan, self.receivers[row.row_number])

    def channels(
        self, row: PreviewRow
    ) -> tuple[list[prospects.ChannelInput], list[prospects.ChannelInput]]:
        reference = provenance.import_row_reference(
            self.preview.summary.file_name, self.sheet, row.row_number
        )
        emails = [
            prospects.ChannelInput(
                value=email.address,
                is_primary=email.is_primary,
                origin_type=OriginType.IMPORTED,
                source_reference=reference,
            )
            for email in row.emails
        ]
        phones = [
            prospects.ChannelInput(
                value=phone.number,
                is_primary=phone.is_primary,
                phone_type=phone.type,
                origin_type=OriginType.IMPORTED,
                source_reference=reference,
            )
            for phone in row.phones
        ]
        return emails, phones

    def role_id(self, plan: RowPlan) -> uuid.UUID | None:
        if plan.role.create_label is not None:
            return self.role_ids[fold(plan.role.create_label) or plan.role.create_label]
        return plan.role.role_id

    def company_id(self, plan: RowPlan) -> uuid.UUID | None:
        company = self.companies.get(plan.company_key) if plan.company_key else None
        return company.id if company else None

    @staticmethod
    def activity(plan: RowPlan) -> ActivityStatus | None:
        """The activity the row claims: a confirmed `inactive` suggestion (a person's choice in
        the review), else the `Statut_verification` cell (D10); None when nothing is known."""
        return ActivityStatus.INACTIVE if plan.inactive else row_activity(plan.row)

    def create(self, plan: RowPlan) -> None:
        row = plan.row
        emails, phones = self.channels(row)
        prospect = prospects.create_prospect(
            self.session,
            self.importer,
            prospects.ProspectInput(
                first_name=row.prospect.first_name,
                last_name=row.prospect.last_name,
                civility=plan.civility,
                company_id=self.company_id(plan),
                role_id=self.role_id(plan),
                exact_job_title=row.prospect.exact_job_title,
                activity_status=self.activity(plan) or ActivityStatus.UNKNOWN,
                emails=emails,
                phones=phones,
            ),
        )
        self.receivers[row.row_number] = prospect
        self.created.add(prospect.id)
        self.counts["prospects_created"] += 1
        self.counts["emails_added"] += len(emails)
        self.counts["phones_added"] += len(phones)

    def merge(self, plan: RowPlan, prospect: Prospect) -> None:
        """Complete the prospect with the row (D11): an empty field is filled unless a person
        set or emptied it; a different value is kept, with an `import_conflict` alert on an
        existing prospect (another row of the same new prospect only keeps its raw value);
        contactability is never touched. Unapplied values stay in the row's legacy metadata."""
        row = plan.row
        existing = prospect.id not in self.created
        ref = self.ref(row.row_number)
        human = (
            precedence.human_fields(self.session, "prospect", prospect.id)
            if existing
            else frozenset()
        )
        wanted = {
            "civility": (plan.civility, ImportField.CIVILITY),
            "first_name": (row.prospect.first_name, ImportField.FIRST_NAME),
            "last_name": (row.prospect.last_name, ImportField.LAST_NAME),
            "exact_job_title": (row.prospect.exact_job_title, ImportField.JOB_TITLE),
            "activity_status": (self.activity(plan), ImportField.VERIFICATION_STATUS),
        }
        fills: dict[str, object] = {}
        for name, (value, source) in wanted.items():
            current = getattr(prospect, name)
            if self.applies(
                name, current, value, human, ref, prospect_id=prospect.id, alert=existing
            ):
                fills[name] = value
            elif value is not None and not precedence.same_text(current, value):
                self.keep(row, source)
        role_id = self.role_id(plan)
        if role_id is not None and prospect.role_id is None and "role_id" not in human:
            fills["role_id"] = role_id  # the job title's conflict, if any, says the rest
        if fills:
            audit.annotate(self.session, self.importer, prospect)
            for attribute, filled in fills.items():
                setattr(prospect, attribute, filled)
            self.session.flush()
        self.merge_company(plan, prospect, human, ref, existing=existing)
        self.merge_channels(plan, prospect, ref, existing=existing)
        self.receivers[row.row_number] = prospect

    def merge_company(
        self,
        plan: RowPlan,
        prospect: Prospect,
        human: frozenset[str],
        ref: RowRef,
        *,
        existing: bool,
    ) -> None:
        company_id = self.company_id(plan)
        if company_id is None or company_id == prospect.company_id:
            return
        proposal = plan.row.company
        current = self.session.get(Company, prospect.company_id) if prospect.company_id else None
        if self.applies(
            "company_id",
            prospect.company_id,
            company_id,
            human,
            ref,
            prospect_id=prospect.id,
            alert=existing,
            viper_label=current.display_name if current else None,
            file_label=proposal.display_name if proposal else None,
        ):
            prospects.change_company(self.session, self.importer, prospect.id, company_id)
        else:
            self.keep(plan.row, ImportField.COMPANY_NAME)

    def merge_channels(
        self, plan: RowPlan, prospect: Prospect, ref: RowRef, *, existing: bool
    ) -> None:
        """E-mails and phones of an existing prospect are filled when it has none (and a person
        did not remove them); other addresses/numbers are a conflict, never silently added — the
        address may be the new one of a person who changed job (handoff §8)."""
        row = plan.row
        emails, phones = self.channels(row)
        by_person = (
            precedence.human_children(self.session, "prospect", prospect.id, ("email", "phone"))
            if existing
            else frozenset()
        )
        kept_emails = self.channels_to_add(
            "emails",
            [email.address for email in prospect.emails],
            emails,
            "email" in by_person,
            ref,
            prospect.id,
            existing=existing,
        )
        kept_phones = self.channels_to_add(
            "phones",
            [phone.number for phone in prospect.phones],
            phones,
            "phone" in by_person,
            ref,
            prospect.id,
            existing=existing,
        )
        known_emails = {email.address for email in prospect.emails}
        if any(e.value not in known_emails and e not in kept_emails for e in emails):
            self.keep(row, ImportField.EMAIL)
        known_phones = {phone.number for phone in prospect.phones}
        if any(p.value not in known_phones and p not in kept_phones for p in phones):
            self.keep(row, ImportField.PHONE)
            self.keep(row, ImportField.MOBILE)
        added_emails, added_phones = prospects.add_channels(
            self.session, self.importer, prospect, emails=kept_emails, phones=kept_phones
        )
        self.counts["emails_added"] += len(added_emails)
        self.counts["phones_added"] += len(added_phones)

    def channels_to_add(
        self,
        name: str,
        current: list[str],
        incoming: list[prospects.ChannelInput],
        cleared_by_person: bool,
        ref: RowRef,
        prospect_id: uuid.UUID,
        *,
        existing: bool,
    ) -> list[prospects.ChannelInput]:
        new = [channel for channel in incoming if channel.value not in current]
        if not new or not existing:
            return new  # nothing new, or another row of a prospect this import created
        if not current and not cleared_by_person:
            return new
        self.recorder.conflict(
            ref,
            name,
            sorted(current) or None,
            [channel.value for channel in incoming],
            prospect_id=prospect_id,
            reason=Reason.DIFFERENT if current else Reason.HUMAN_CLEARED,
        )
        return []

    # --- contact tracking ---

    def tracking(self, plan: RowPlan, prospect: Prospect) -> None:
        """Create the tracking (status history included) or complete it (D11): its referent and
        appointment date are filled when empty, an appointment stage of the file sets
        `appointment_obtained` only on a `neutral` state no person chose; anything else that
        differs is kept (an `import_conflict` alert on an existing prospect). A do-not-contact
        prospect (hence every `ignored` one) gets no tracking change from an import. Follow-up
        stage columns are not sends of a known date: they stay raw (legacy metadata)."""
        row = plan.row
        proposal = row.tracking
        # A stage only when a legacy stage column said so; a suggestion alone creates nothing.
        status = proposal.status if proposal and proposal.stages else None
        appointment = at_midnight(proposal.appointment_date if proposal else None)
        referent = plan.referent_id
        if proposal and any(stage in SEND_STAGES for stage in proposal.stages):
            self.keep_tracking(row, stages=True, referent=False)
        if status is ContactTrackingStatus.NEUTRAL:
            status = None
        if status is None and referent is None and appointment is None:
            return
        current = prospect.contact_tracking
        if prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT:
            self.keep_tracking(row, stages=True, referent=True)
            return
        if current is None:
            save_contact_tracking(
                self.session,
                self.importer,
                prospect.id,
                ContactTrackingInput(
                    status=status or ContactTrackingStatus.NEUTRAL,
                    referent_id=referent,
                    appointment_at=appointment,
                ),
            )
            self.counts["trackings_created"] += 1
            return
        existing = prospect.id not in self.created
        ref = self.ref(row.row_number)
        human = (
            precedence.human_fields(self.session, "contact_tracking", current.id)
            if existing
            else frozenset()
        )
        state_by_person = existing and precedence.human_state(self.session, prospect.id)
        new_status = current.status
        if status is not None and status is not current.status:
            neutral = current.status is ContactTrackingStatus.NEUTRAL
            if neutral and not state_by_person:
                new_status = status
            else:
                self.keep_tracking(row, stages=True, referent=False)
                if existing:
                    self.recorder.conflict(
                        ref, "contact_state", current.status, status, prospect_id=prospect.id
                    )

        def fill(name: str, value: object, current_value: object) -> bool:
            return self.applies(
                name, current_value, value, human, ref, prospect_id=prospect.id, alert=existing
            )

        referent_id = referent if fill("referent_id", referent, current.referent_id) else None
        if referent is not None and referent_id is None and referent != current.referent_id:
            self.keep_tracking(row, stages=False, referent=True)
        appointment_at = (
            appointment if fill("appointment_at", appointment, current.appointment_at) else None
        )
        filled = ContactTrackingInput(
            status=new_status,
            referent_id=referent_id or current.referent_id,
            response_received_at=current.response_received_at,
            appointment_at=appointment_at or current.appointment_at,
        )
        kept = ("status", "referent_id", "appointment_at")
        if any(getattr(filled, name) != getattr(current, name) for name in kept):
            save_contact_tracking(self.session, self.importer, prospect.id, filled)

    def keep_tracking(self, row: PreviewRow, *, stages: bool, referent: bool) -> None:
        if stages:
            for stage in TRACKING_FIELDS:
                self.keep(row, stage)
        if referent:
            self.keep(row, ImportField.REFERENT)

    # --- cohorts, sequences, imported sends, « Défaillant » (operational meaning) ---

    def reconcile_operations(self) -> None:
        """Per prospect the import created or completed, in source order of its rows."""
        targets: dict[uuid.UUID, list[RowPlan]] = {}
        for plan in self.plan.rows:
            if plan.imported:
                targets.setdefault(self.receivers[plan.row.row_number].id, []).append(plan)
        reconciler = operational_import.OperationalReconciler(
            self.session,
            person=self.actor,
            importer=self.importer,
            alerts=self.recorder,
            human_verified=self.plan.human_verified,
            ref=self.ref,
        )
        for prospect_id, plans in targets.items():
            rows = tuple(
                operational_import.RowClaim(
                    row=plan.row.row_number,
                    cohort_code=plan.cohort_code,
                    not_cohort=plan.not_cohort,
                )
                for plan in plans
            )
            target = operational_import.ProspectClaims(
                prospect_id=prospect_id, created=prospect_id in self.created, rows=rows
            )
            self.guarded(rows[0].row, partial(reconciler.apply, target))
            for plan in plans:
                if plan.cohort_code is not None and plan.row.row_number in reconciler.unapplied:
                    self.keep(plan.row, ImportField.PLANNED_CONTACT)
        self.counts.update(reconciler.counts)

    # --- provenance and row trace ---

    def trace(self, plan: RowPlan, batch: ImportBatch) -> None:
        """Every source row is traced with the raw snapshot of its non-empty cells (D10); an
        imported row also gets its `excel_import` source and its unapplied legacy values."""
        row = plan.row
        raw = {
            cell.column: {"header": self.headers.get(cell.column), "value": cell.value}
            | ({"merged": True} if cell.copied_from_merge else {})
            for cell in row.cells
        }
        if not plan.imported:
            import_batches.record_row(
                self.session,
                batch,
                sheet=self.sheet,
                row_number=row.row_number,
                legacy_metadata={},
                raw_cells=raw,
                prospect_id=opposed_match(row),
                excluded=True,
            )
            return
        prospect = self.receivers[row.row_number]
        provenance.add_import_source(
            self.session,
            self.importer,
            prospect.id,
            batch,
            sheet=self.sheet,
            row_number=row.row_number,
            legal_basis_or_collection_context=self.decisions.legal_basis_or_collection_context,
        )
        legacy = {**row.legacy_metadata, **self.extra.get(row.row_number, {})}
        import_batches.record_row(
            self.session,
            batch,
            sheet=self.sheet,
            row_number=row.row_number,
            legacy_metadata={key: value.model_dump(mode="json") for key, value in legacy.items()},
            raw_cells=raw,
            prospect_id=prospect.id,
            company_id=self.company_id(plan),
        )

    def keep(self, row: PreviewRow, target: ImportField) -> None:
        """Keep the row's raw cell of `target` (not applied by the import) in its metadata."""
        column = self.columns.get(target)
        if column is None or target.value in row.legacy_metadata:
            return
        cell = next((c for c in row.cells if c.column == column.column), None)
        if cell is None:
            return
        self.extra.setdefault(row.row_number, {})[target.value] = LegacyValue(
            column=column.column,
            header=column.header,
            value=cell.value,
            reason=LegacyReason.NOT_MAPPED_VALUE,
        )


def opposed_match(row: PreviewRow) -> uuid.UUID | None:
    """The do-not-contact prospect an excluded row matched (its trace goes with that prospect)."""
    if not row.blocked_by_do_not_contact:
        return None
    return next(
        (
            candidate.prospect_id
            for candidate in row.duplicates
            if candidate.kind is CandidateKind.EXISTING_PROSPECT
            and candidate.contactability is ContactabilityStatus.DO_NOT_CONTACT
            and PERSON_REASONS & set(candidate.reasons)
        ),
        None,
    )


def _address(line1: str | None, postal_code: str | None, city: str | None) -> str:
    return ", ".join(part for part in (line1, postal_code, city) if part)


def fitting(text: str | None) -> str | None:
    """A company context text the editor can store (longer ones stay raw in legacy metadata)."""
    return text if text is not None and len(text) <= companies.CONTEXT_MAX_LENGTH else None
