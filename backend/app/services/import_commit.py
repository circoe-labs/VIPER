"""Excel import review and commit (Task 09, ADR-0012).

Stateless: the browser keeps the file. `review_upload` previews it (engine + review defaults +
re-import warning); `commit_import` receives the same file again with the user's decisions,
re-runs the preview on a fresh reference snapshot, refuses if the file or the preview changed
(fingerprint, digest), validates the plan, then writes everything in **one savepoint** of the
request's transaction:

    roles/categories the user chose to create (by the user, audited Settings service)
    → batch `pending` (by the user) → inside `import_batches.importing` (import actor, on behalf
    of the user): companies (+ establishment) → prospects (+ e-mails/phones `imported`,
    `unverified`) or merges into existing ones → contact tracking (history) → one
    `excel_import` source and one `import_row_metadata` per imported row → batch `committed`.

Any failure while writing rolls the savepoint back (no partial data) and records a `failed` batch
in the request's transaction instead, so the history shows the attempt. Merge rules
(`attach`): never overwrite, fill empty fields only, add missing e-mails/phones, never touch
contactability; a value the import does not apply stays in the row's legacy metadata.
"""

import logging
import uuid
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, time
from functools import partial
from zoneinfo import ZoneInfo

from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.models.enums import (
    ActivityStatus,
    ContactabilityStatus,
    ContactTrackingStatus,
    ImportBatchStatus,
    OriginType,
)
from app.models.imports import ImportBatch
from app.models.prospects import Prospect
from app.services import audit, companies, import_batches, prospects, provenance, taxonomies
from app.services.contact_tracking import ContactTrackingInput, save_contact_tracking
from app.services.errors import DomainError, DuplicateValueError, InvalidInputError
from app.services.imports.decisions import (
    ImportDecisions,
    PreviewOptions,
    ProspectAttach,
    ProspectAttachRow,
    ProspectCreate,
)
from app.services.imports.fields import ImportField
from app.services.imports.models import (
    CompanyProposal,
    ImportPreview,
    LegacyReason,
    LegacyValue,
    PreviewRow,
)
from app.services.imports.preview import ImportFile, build_preview
from app.services.imports.reference_loader import load_reference_data
from app.services.imports.review import (
    DecisionError,
    ImportPlan,
    ImportReview,
    RowPlan,
    build_review,
    plan_import,
)
from app.services.imports.rows import COMPANY_TEXT_FIELDS
from app.services.imports.text import fold
from app.services.imports.workbook import ImportLimits

logger = logging.getLogger(__name__)
# Dates without time (planned contact, appointment) are stored at midnight, Circoe's time zone.
BUSINESS_TIMEZONE = ZoneInfo("Europe/Paris")
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
        self.actor = actor
        self.importer = actor  # replaced by the import actor while importing
        self.preview = preview
        self.plan = plan
        self.decisions = decisions
        self.sheet = preview.summary.sheet or ""
        self.columns = {c.field: c for c in preview.summary.columns if c.field is not None}
        self.counts: Counter[str] = Counter()
        self.role_ids: dict[str, uuid.UUID] = {}
        self.category_ids: dict[str, uuid.UUID] = {}
        self.companies: dict[str, CompanyValues] = {}
        self.receivers: dict[int, Prospect] = {}  # row → the prospect it created or merged into
        self.extra: dict[int, dict[str, LegacyValue]] = {}
        self.attached: set[uuid.UUID] = set()

    def run(self) -> CommitResult:
        self.create_taxonomies()
        batch = start(self.session, self.actor, self.preview, self.decisions)
        with import_batches.importing(self.session, batch, self.actor) as importer:
            self.importer = importer
            for company in self.plan.companies.values():
                self.guarded(company.rows[0], partial(self.company, company.key))
            # Rows creating or attaching first, so that merges into another row find its prospect.
            direct = (ProspectCreate, ProspectAttach)
            ordered = sorted(self.plan.rows, key=lambda p: not isinstance(p.resolution, direct))
            for plan in ordered:
                if plan.imported:
                    self.guarded(plan.row.row_number, partial(self.prospect, plan))
            for plan in self.plan.rows:
                if plan.imported:
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

    # --- taxonomies the user chose to create ---

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
            before = companies.get_company(self.session, plan.link_id)
            detail = companies.complete_company(
                self.session,
                self.importer,
                plan.link_id,
                companies.CompanyCompletion(
                    email_domain=domain,
                    commercial_segment_id=plan.segment_id,
                    activity_category_ids=category_ids,
                    establishment=establishment,
                    **texts,
                ),
            )
            if before.establishments:
                site_row = None
            self.counts["companies_linked"] += 1
        values = CompanyValues(
            id=detail.id,
            display_name=detail.display_name,
            texts={name.value: getattr(detail, name.value) for name in COMPANY_TEXT_FIELDS},
            establishment_row=site_row,
        )
        self.companies[key] = values
        for plan_row in rows:
            self.keep_company_values(plan_row, values)

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
                activity_status=ActivityStatus.INACTIVE
                if plan.inactive
                else ActivityStatus.UNKNOWN,
                emails=emails,
                phones=phones,
            ),
        )
        self.receivers[row.row_number] = prospect
        self.counts["prospects_created"] += 1
        self.counts["emails_added"] += len(emails)
        self.counts["phones_added"] += len(phones)

    def merge(self, plan: RowPlan, prospect: Prospect) -> None:
        """Fill the prospect's empty fields from the row; never replace a value, never touch its
        contactability. Values that differ stay in the row's legacy metadata."""
        row = plan.row
        wanted = {
            "civility": (plan.civility, ImportField.CIVILITY),
            "first_name": (row.prospect.first_name, ImportField.FIRST_NAME),
            "last_name": (row.prospect.last_name, ImportField.LAST_NAME),
            "exact_job_title": (row.prospect.exact_job_title, ImportField.JOB_TITLE),
            "role_id": (self.role_id(plan), None),
        }
        fills = {}
        for name, (value, source) in wanted.items():
            current = getattr(prospect, name)
            if value is None or value == current:
                continue
            if current is None:
                fills[name] = value
            elif source is not None:
                self.keep(row, source)
        if plan.inactive and prospect.activity_status is ActivityStatus.UNKNOWN:
            fills["activity_status"] = ActivityStatus.INACTIVE
        if fills:
            audit.annotate(self.session, self.importer, prospect)
            for name, value in fills.items():
                setattr(prospect, name, value)
            self.session.flush()
        company_id = self.company_id(plan)
        if company_id is not None and prospect.company_id is None:
            prospects.change_company(self.session, self.importer, prospect.id, company_id)
        emails, phones = self.channels(row)
        added_emails, added_phones = prospects.add_channels(
            self.session, self.importer, prospect, emails=emails, phones=phones
        )
        self.receivers[row.row_number] = prospect
        self.counts["emails_added"] += len(added_emails)
        self.counts["phones_added"] += len(added_phones)

    # --- contact tracking ---

    def tracking(self, plan: RowPlan, prospect: Prospect) -> None:
        """Create the tracking (status history included) or fill its empty dates/referent; the
        stage of an existing tracking is never changed, and a do-not-contact prospect gets no
        tracking from an import."""
        row = plan.row
        proposal = row.tracking
        # A stage only when a legacy stage column said so; a suggestion alone creates nothing.
        status = proposal.status if proposal and proposal.stages else None
        planned = at_midnight(plan.planned_date)
        appointment = at_midnight(proposal.appointment_date if proposal else None)
        referent = plan.referent_id
        if status is None and planned is None and referent is None:
            return
        current = prospect.contact_tracking
        if prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT:
            self.keep_tracking(row, stages=True, planned=True, referent=True)
            return
        if current is None:
            save_contact_tracking(
                self.session,
                self.importer,
                prospect.id,
                ContactTrackingInput(
                    status=status or ContactTrackingStatus.TO_CONTACT,
                    planned_contact_at=planned,
                    referent_id=referent,
                    appointment_at=appointment,
                ),
            )
            self.counts["trackings_created"] += 1
            return
        filled = ContactTrackingInput(
            status=current.status,
            planned_contact_at=current.planned_contact_at or planned,
            referent_id=current.referent_id or referent,
            response_received_at=current.response_received_at,
            appointment_at=current.appointment_at or appointment,
        )
        self.keep_tracking(
            row,
            stages=status is not None and status != current.status,
            planned=planned is not None and filled.planned_contact_at != planned,
            referent=referent is not None and filled.referent_id != referent,
        )
        if (filled.planned_contact_at, filled.referent_id, filled.appointment_at) != (
            current.planned_contact_at,
            current.referent_id,
            current.appointment_at,
        ):
            save_contact_tracking(self.session, self.importer, prospect.id, filled)

    def keep_tracking(
        self, row: PreviewRow, *, stages: bool, planned: bool, referent: bool
    ) -> None:
        if stages:
            for stage in TRACKING_FIELDS:
                self.keep(row, stage)
        if planned:
            self.keep(row, ImportField.PLANNED_CONTACT)
        if referent:
            self.keep(row, ImportField.REFERENT)

    # --- provenance and row trace ---

    def trace(self, plan: RowPlan, batch: ImportBatch) -> None:
        row = plan.row
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


def fitting(text: str | None) -> str | None:
    """A company context text the editor can store (longer ones stay raw in legacy metadata)."""
    return text if text is not None and len(text) <= companies.CONTEXT_MAX_LENGTH else None
