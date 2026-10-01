"""ProspectService for the Prospect editor (Task 15): the editor's view model and one atomic save.

The save composes the domain operations inside the caller's transaction (one request = one
transaction: any refusal rolls every step back), in this order:

1. the role the user created inline, through `taxonomies.create_value` (`role.created`);
2. a company change through `prospects.change_company` (I-13: employment verification cleared,
   verified active channels back to `unverified`; `prospect.company_changed`);
3. identity and employment fields, with the explicit employment-verification action;
4. e-mails and phones as full lists (`contact_channels.save_channels`);
5. contact tracking through `contact_tracking.save_contact_tracking` (status history kept, Contact
   rules applied: `ignored` terminal and reinforcing do-not-contact, « Défaillant » by a person);
6. on creation, the `manual` provenance record (`provenance.add_manual_source`).

`update_tracking` is the lighter write of the state alone (the state picker), with the same version
check and rules. The cohort, the sequence and the next due date are not part of the save: the view
shows them (`contact`, derived — sequences rework D1) and `contact_sequences.change_cohort` changes
the cohort.

Contactability never travels with the save: `set_contactability` calls the dedicated
`mark_do_not_contact` / `clear_do_not_contact` operations, with a mandatory reason. Every write
first locks the prospect and compares the aggregate version the client read (prospect, e-mails,
phones, tracking): anything changed meanwhile → `ConflictError`, nothing is overwritten.
Rules and wording: doc/features/prospect-editor.md.
"""

import hashlib
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, replace
from datetime import UTC, date, datetime, time
from enum import StrEnum

from sqlalchemy.orm import Session

from app.core.actor import ActorContext, ActorType
from app.core.business_time import BUSINESS_TIMEZONE, business_day, business_moment, start_of_day
from app.models import ContactTracking, Email, Phone, Prospect, Role
from app.models.enums import (
    ActivityStatus,
    Civility,
    ContactabilityStatus,
    ContactTrackingStatus,
    OriginType,
    PhoneType,
    ProspectSourceType,
    VerificationStatus,
)
from app.repositories import companies as company_repository
from app.repositories import prospects as repository
from app.repositories import referents as referent_repository
from app.repositories import taxonomies as taxonomy_repository
from app.services import audit, contact_channels, prospects, provenance, taxonomies
from app.services.contact_channels import EMAILS, PHONES, ChannelItem
from app.services.contact_message_cancellation import NOTHING, Cancellation
from app.services.contact_sequences import CohortRef, prospect_sequence
from app.services.contact_tracking import ContactTrackingInput, apply_contact_tracking
from app.services.contact_workflow import DEFAULT_STATE, PauseReason, state_reached_at, step_code
from app.services.errors import (
    ActorNotAllowedError,
    ConflictError,
    DoNotContactError,
    DuplicateValueError,
    InvalidFieldError,
    NotFoundError,
)
from app.services.history import HistoryActor, snapshot_actor
from app.services.prospection.query import iso_week, prospect_verification_state
from app.services.prospection.segments import SegmentContext, VerificationState
from app.services.taxonomies import Taxonomy, normalize_text

NAME_MAX_LENGTH = 100
TITLE_MAX_LENGTH = 255
TEXT_MAX_LENGTH = 2000  # reasons, collection context, provenance reference
TRACKING_FIELDS = (
    "status",
    "referent_id",
    "response_received_at",
    "appointment_at",
)


# --- values in ---------------------------------------------------------------------------------


class VerificationAction(StrEnum):
    """What the save does to the employment verification date."""

    KEEP = "keep"
    # « Vérifié aujourd'hui »: verified now.
    VERIFIED_NOW = "verified_now"
    # Verified on a given (past or current) business day.
    VERIFIED_ON = "verified_on"
    CLEAR = "clear"


@dataclass(frozen=True, slots=True)
class EmploymentVerification:
    action: VerificationAction = VerificationAction.KEEP
    day: date | None = None  # VERIFIED_ON only


@dataclass(frozen=True, slots=True)
class TrackingForm:
    """Suivi de contact as edited: days in business time, the appointment with an optional time."""

    status: ContactTrackingStatus
    response_received_on: date | None = None
    appointment_on: date | None = None
    appointment_time: time | None = None
    referent_id: uuid.UUID | None = None


@dataclass(frozen=True, slots=True)
class TrackingUpdate:
    """A change of the commercial state alone."""

    status: ContactTrackingStatus


@dataclass(frozen=True, slots=True)
class ProspectForm:
    """The whole editable state of a prospect (contactability excepted)."""

    first_name: str | None
    last_name: str | None
    company_id: uuid.UUID | None
    civility: Civility | None = None
    role_id: uuid.UUID | None = None
    # A new role created with the save (inline creation), instead of `role_id`.
    role_label: str | None = None
    exact_job_title: str | None = None
    activity_status: ActivityStatus = ActivityStatus.UNKNOWN
    employment_verification: EmploymentVerification = EmploymentVerification()
    emails: Sequence[ChannelItem] = ()
    phones: Sequence[ChannelItem] = ()
    # None leaves the current tracking as it is (the editor never deletes one).
    tracking: TrackingForm | None = None


@dataclass(frozen=True, slots=True)
class ManualSource:
    """Provenance of a prospect entered by hand."""

    legal_basis_or_collection_context: str
    source_reference: str | None = None


@dataclass(frozen=True, slots=True)
class EditorClock:
    """The moment of the save (verification dates), and the business day and stale threshold the
    view's verification states are computed with."""

    now: datetime
    stale_days: int | None = None

    @property
    def segments(self) -> SegmentContext:
        return SegmentContext.at(self.now, self.stale_days)


# --- view model --------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class CompanySummary:
    id: uuid.UUID
    display_name: str
    legal_name: str | None
    siren: str | None
    email_domain: str | None
    website_url: str | None
    commercial_segment_label: str | None
    city: str | None
    prospect_count: int


@dataclass(frozen=True, slots=True)
class ValueRef:
    """A role or a referent as a picker shows it."""

    id: uuid.UUID
    label: str
    active: bool


@dataclass(frozen=True, slots=True)
class EmailView:
    id: uuid.UUID
    address: str
    is_primary: bool
    is_active: bool
    verification_status: VerificationStatus
    last_verified_at: datetime | None
    origin_type: OriginType
    source_reference: str | None
    # Imported and never verified (nor known invalid): the "to verify" warning treatment.
    imported_unverified: bool


@dataclass(frozen=True, slots=True)
class PhoneView:
    id: uuid.UUID
    number: str
    type: PhoneType
    is_primary: bool
    is_active: bool
    verification_status: VerificationStatus
    last_verified_at: datetime | None
    origin_type: OriginType
    source_reference: str | None
    imported_unverified: bool


@dataclass(frozen=True, slots=True)
class TrackingView:
    status: ContactTrackingStatus
    response_received_on: date | None
    appointment_on: date | None
    # None when the appointment has no time (stored at midnight).
    appointment_time: time | None
    referent: ValueRef | None
    # When the current stage was reached (last status-history entry).
    status_since: datetime | None


@dataclass(frozen=True, slots=True)
class ContactProgressView:
    """Where the prospect stands in Contact, derived (D1, D2, D7, D9): the current cohort (none:
    not validated), the messages really sent in the current sequence, the step to send next
    (`contact`, `r1`… — the level), « Relance terminée », the next due day and why nothing is
    due."""

    cohort: CohortRef | None
    sequence_open: bool
    sent_count: int
    level_label: str | None
    next_step: str | None
    finished: bool
    next_due_on: date | None
    # ISO calendar week of the next due day, e.g. `2026-W41`.
    next_due_week: str | None
    pause_reason: PauseReason | None
    email_error: bool
    max_follow_ups: int


@dataclass(frozen=True, slots=True)
class SourceView:
    id: uuid.UUID
    source_type: ProspectSourceType
    source_reference: str | None
    collected_at: datetime
    legal_basis_or_collection_context: str | None
    # Who recorded it (the source row's actor snapshot, shown like a history actor).
    recorded_by: HistoryActor | None
    import_filename: str | None


@dataclass(frozen=True, slots=True)
class ProspectView:
    id: uuid.UUID
    # Opaque aggregate version to send back with the next write (optimistic concurrency).
    version: str
    civility: Civility | None
    first_name: str | None
    last_name: str | None
    company: CompanySummary | None
    role: ValueRef | None
    exact_job_title: str | None
    activity_status: ActivityStatus
    employment_verified_at: datetime | None
    # Same reading as the Prospection card (segments.verification_state).
    verification_state: VerificationState
    # Arrived by import and the employment context was never verified since.
    employment_imported_unverified: bool
    contactability_status: ContactabilityStatus
    do_not_contact_at: datetime | None
    do_not_contact_reason: str | None
    # Primary first, then active ones, then by creation.
    emails: list[EmailView]
    phones: list[PhoneView]
    tracking: TrackingView | None
    contact: ContactProgressView
    # Oldest first.
    sources: list[SourceView]
    # Import-row traces deleted with the prospect.
    import_row_count: int
    # Business day and age threshold the verification states were computed with.
    today: date
    stale_threshold_days: int | None
    created_at: datetime
    updated_at: datetime


@dataclass(frozen=True, slots=True)
class EditorResult:
    """A save's view, and its effect on the Contact messages: unsent ones cancelled by a
    sequence-closing state or the opposition (decision 29), claimed ones left to the dispatcher."""

    view: ProspectView
    messages: Cancellation


def aggregate_version(session: Session, prospect_id: uuid.UUID) -> str:
    """Changes whenever the prospect or one of its e-mails, phones or tracking is written, added
    or removed — by any write path (the `set_updated_at` triggers bump every row)."""
    rows = sorted(
        (kind, str(row_id), stamp.astimezone(UTC).isoformat())
        for kind, row_id, stamp in repository.version_rows(session, prospect_id)
    )
    return hashlib.sha256(repr(rows).encode()).hexdigest()[:32]


def _local_parts(moment: datetime) -> tuple[date, time | None]:
    """Business day and time (minutes; None at midnight) of a stored moment."""
    local = moment.astimezone(BUSINESS_TIMEZONE)
    at = local.time().replace(second=0, microsecond=0)
    return local.date(), (None if at == time() else at)


def _imported_unverified(channel: Email | Phone) -> bool:
    return (
        channel.is_active
        and channel.origin_type is OriginType.IMPORTED
        and channel.verification_status
        in (VerificationStatus.UNVERIFIED, VerificationStatus.UNKNOWN)
        and channel.last_verified_at is None
    )


def _channel_order(channel: Email | Phone) -> tuple[bool, bool, datetime, str]:
    return (not channel.is_primary, not channel.is_active, channel.created_at, str(channel.id))


def _company_summary(session: Session, company_id: uuid.UUID | None) -> CompanySummary | None:
    found = company_repository.company_summary(session, company_id) if company_id else None
    if found is None:
        return None
    company, segment_label, prospect_count, city = found
    return CompanySummary(
        id=company.id,
        display_name=company.display_name,
        legal_name=company.legal_name,
        siren=company.siren,
        email_domain=company.email_domain,
        website_url=company.website_url,
        commercial_segment_label=segment_label,
        city=city,
        prospect_count=prospect_count,
    )


def _role_ref(session: Session, role_id: uuid.UUID | None) -> ValueRef | None:
    role = taxonomy_repository.get_value(session, Role, role_id) if role_id else None
    return ValueRef(role.id, role.label, role.active) if role else None


def _tracking_view(session: Session, tracking: ContactTracking | None) -> TrackingView | None:
    if tracking is None:
        return None
    referent = (
        referent_repository.get_referent(session, tracking.referent_id)
        if tracking.referent_id
        else None
    )
    appointment = _local_parts(tracking.appointment_at) if tracking.appointment_at else None
    since = state_reached_at(tracking.status_history)
    return TrackingView(
        status=tracking.status,
        response_received_on=(
            business_day(tracking.response_received_at) if tracking.response_received_at else None
        ),
        appointment_on=appointment[0] if appointment else None,
        appointment_time=appointment[1] if appointment else None,
        referent=(
            ValueRef(referent.id, f"{referent.first_name} {referent.last_name}", referent.active)
            if referent
            else None
        ),
        status_since=since,
    )


def contact_progress_view(session: Session, prospect_id: uuid.UUID) -> ContactProgressView:
    place = prospect_sequence(session, prospect_id)
    progress = place.progress
    due = progress.next_due_at
    return ContactProgressView(
        cohort=place.cohort,
        sequence_open=place.sequence_open,
        sent_count=progress.sent_count,
        level_label=progress.level_label,
        next_step=step_code(progress.next_rank) if progress.next_rank is not None else None,
        finished=progress.finished,
        next_due_on=business_day(due) if due else None,
        next_due_week=iso_week(due),
        pause_reason=progress.pause,
        email_error=place.email_error,
        max_follow_ups=place.max_follow_ups,
    )


def get_view(session: Session, prospect_id: uuid.UUID, clock: EditorClock) -> ProspectView:
    prospect = repository.get_prospect(session, prospect_id)
    state = prospect_verification_state(session, prospect_id, clock.segments)
    if prospect is None or state is None:
        raise NotFoundError(f"Prospect {prospect_id} not found.")
    sources = [
        SourceView(
            id=source.id,
            source_type=source.source_type,
            source_reference=source.source_reference,
            collected_at=source.collected_at,
            legal_basis_or_collection_context=source.legal_basis_or_collection_context,
            recorded_by=(
                snapshot_actor(source.actor_type, source.actor_id, source.actor_display)
                if source.actor_type and source.actor_display
                else None
            ),
            import_filename=filename,
        )
        for source, filename in repository.sources_with_batches(session, prospect.id)
    ]
    imported = any(source.source_type is ProspectSourceType.EXCEL_IMPORT for source in sources)
    return ProspectView(
        id=prospect.id,
        version=aggregate_version(session, prospect.id),
        civility=prospect.civility,
        first_name=prospect.first_name,
        last_name=prospect.last_name,
        company=_company_summary(session, prospect.company_id),
        role=_role_ref(session, prospect.role_id),
        exact_job_title=prospect.exact_job_title,
        activity_status=prospect.activity_status,
        employment_verified_at=prospect.employment_verified_at,
        verification_state=state,
        employment_imported_unverified=imported and prospect.employment_verified_at is None,
        contactability_status=prospect.contactability_status,
        do_not_contact_at=prospect.do_not_contact_at,
        do_not_contact_reason=prospect.do_not_contact_reason,
        emails=[
            EmailView(
                id=email.id,
                address=email.address,
                is_primary=email.is_primary,
                is_active=email.is_active,
                verification_status=email.verification_status,
                last_verified_at=email.last_verified_at,
                origin_type=email.origin_type,
                source_reference=email.source_reference,
                imported_unverified=_imported_unverified(email),
            )
            for email in sorted(prospect.emails, key=_channel_order)
        ],
        phones=[
            PhoneView(
                id=phone.id,
                number=phone.number,
                type=phone.type,
                is_primary=phone.is_primary,
                is_active=phone.is_active,
                verification_status=phone.verification_status,
                last_verified_at=phone.last_verified_at,
                origin_type=phone.origin_type,
                source_reference=phone.source_reference,
                imported_unverified=_imported_unverified(phone),
            )
            for phone in sorted(prospect.phones, key=_channel_order)
        ],
        tracking=_tracking_view(session, prospect.contact_tracking),
        contact=contact_progress_view(session, prospect.id),
        sources=sources,
        import_row_count=repository.count_import_rows(session, prospect.id),
        today=clock.segments.today,
        stale_threshold_days=clock.stale_days,
        created_at=prospect.created_at,
        updated_at=prospect.updated_at,
    )


# --- validation --------------------------------------------------------------------------------


def _text(field: str, value: str | None, max_length: int) -> str | None:
    text = normalize_text(value or "") or None
    if text is not None and len(text) > max_length:
        raise InvalidFieldError(field, f"{field} is longer than {max_length} characters.", "length")
    return text


def _required(field: str, value: str | None, max_length: int) -> str:
    text = _text(field, value, max_length)
    if text is None:
        raise InvalidFieldError(field, f"{field} must not be blank.", "blank")
    return text


def _cleaned(session: Session, form: ProspectForm) -> ProspectForm:
    first_name = _text("first_name", form.first_name, NAME_MAX_LENGTH)
    last_name = _text("last_name", form.last_name, NAME_MAX_LENGTH)
    if first_name is None and last_name is None:
        raise InvalidFieldError("last_name", "A prospect needs a first or a last name.", "blank")
    if form.company_id is None:
        raise InvalidFieldError("company_id", "A prospect belongs to a company.", "blank")
    if company_repository.get_company(session, form.company_id) is None:
        raise InvalidFieldError("company_id", "Unknown company.", "unknown")
    role_label = _text("role_label", form.role_label, taxonomies.LABEL_MAX_LENGTH)
    if role_label is not None and form.role_id is not None:
        raise InvalidFieldError("role_label", "Either an existing role or a new one.", "both")
    if form.role_id is not None and not taxonomy_repository.get_value(session, Role, form.role_id):
        raise InvalidFieldError("role_id", "Unknown role.", "unknown")
    verification = form.employment_verification
    if verification.action is VerificationAction.VERIFIED_ON and verification.day is None:
        raise InvalidFieldError("employment_verification.day", "A date is required.", "blank")
    tracking = form.tracking
    if tracking is not None:
        referent = tracking.referent_id
        if referent is not None and referent_repository.get_referent(session, referent) is None:
            raise InvalidFieldError("tracking.referent_id", "Unknown referent.", "unknown")
        if tracking.appointment_time is not None and tracking.appointment_on is None:
            raise InvalidFieldError(
                "tracking.appointment_time", "An appointment time needs its day.", "without_day"
            )
        at = tracking.appointment_time
        tracking = replace(
            tracking, appointment_time=at.replace(second=0, microsecond=0) if at else None
        )
    return replace(
        form,
        first_name=first_name,
        last_name=last_name,
        role_label=role_label,
        exact_job_title=_text("exact_job_title", form.exact_job_title, TITLE_MAX_LENGTH),
        tracking=tracking,
    )


def _role_id(session: Session, actor: ActorContext, form: ProspectForm) -> uuid.UUID | None:
    """The chosen role, or the one created now from `role_label` (same rules and audit as
    Settings: `role.created` by the user)."""
    if form.role_label is None:
        return form.role_id
    try:
        return taxonomies.create_value(session, actor, Taxonomy.ROLE, form.role_label).id
    except DuplicateValueError as error:
        raise DuplicateValueError("role_label", error.existing) from error


def _employment_verified_at(
    current: datetime | None, verification: EmploymentVerification, clock: EditorClock
) -> datetime | None:
    match verification.action:
        case VerificationAction.KEEP:
            return current
        case VerificationAction.CLEAR:
            return None
        case VerificationAction.VERIFIED_NOW:
            return clock.now
        case VerificationAction.VERIFIED_ON:
            day = verification.day
            assert day is not None  # checked by _cleaned
            today = clock.segments.today
            if day > today:
                raise InvalidFieldError(
                    "employment_verification.day",
                    "A verification cannot be in the future.",
                    "future",
                )
            return clock.now if day == today else start_of_day(day)


def _kept_day(stored: datetime | None, day: date | None) -> datetime | None:
    """`day` at midnight, or the stored moment when it already falls on that day."""
    if day is None:
        return None
    if stored is not None and business_day(stored) == day:
        return stored
    return start_of_day(day)


def _kept_moment(stored: datetime | None, day: date | None, at: time | None) -> datetime | None:
    if day is None:
        return None
    if stored is not None and _local_parts(stored) == (day, at):
        return stored
    return start_of_day(day) if at is None else business_moment(day, at)


# --- writes ------------------------------------------------------------------------------------


def _apply_fields(
    session: Session,
    actor: ActorContext,
    prospect: Prospect,
    form: ProspectForm,
    role_id: uuid.UUID | None,
    verified_at: datetime | None,
) -> None:
    values = {
        "civility": form.civility,
        "first_name": form.first_name,
        "last_name": form.last_name,
        "role_id": role_id,
        "exact_job_title": form.exact_job_title,
        "activity_status": form.activity_status,
        "employment_verified_at": verified_at,
    }
    changed = {name: value for name, value in values.items() if getattr(prospect, name) != value}
    if not changed:
        return
    labels = {}
    if "role_id" in changed:
        before, after = _role_ref(session, prospect.role_id), _role_ref(session, role_id)
        labels["role_id"] = (before.label if before else None, after.label if after else None)
    audit.annotate(session, actor, prospect, labels=labels)
    for name, value in changed.items():
        setattr(prospect, name, value)
    session.flush()


def _save_tracking(
    session: Session,
    actor: ActorContext,
    prospect: Prospect,
    form: TrackingForm | None,
    now: datetime,
) -> Cancellation:
    if form is None:
        return NOTHING
    current = prospect.contact_tracking
    data = ContactTrackingInput(
        status=form.status,
        referent_id=form.referent_id,
        response_received_at=_kept_day(
            current.response_received_at if current else None, form.response_received_on
        ),
        appointment_at=_kept_moment(
            current.appointment_at if current else None, form.appointment_on, form.appointment_time
        ),
    )
    if current is not None and all(
        getattr(current, name) == getattr(data, name) for name in TRACKING_FIELDS
    ):
        return NOTHING
    return apply_contact_tracking(session, actor, prospect.id, data, now=now).messages


def _save_details(
    session: Session,
    actor: ActorContext,
    prospect: Prospect,
    form: ProspectForm,
    clock: EditorClock,
) -> Cancellation:
    contact_channels.save_channels(session, actor, prospect, EMAILS, form.emails, now=clock.now)
    contact_channels.save_channels(session, actor, prospect, PHONES, form.phones, now=clock.now)
    return _save_tracking(session, actor, prospect, form.tracking, clock.now)


def _locked(session: Session, prospect_id: uuid.UUID, version: str) -> Prospect:
    prospect = repository.lock_prospect(session, prospect_id)
    if prospect is None:
        raise NotFoundError(f"Prospect {prospect_id} not found.")
    if aggregate_version(session, prospect.id) != version:
        raise ConflictError("The prospect changed since it was read.")
    return prospect


def create_prospect(
    session: Session,
    actor: ActorContext,
    form: ProspectForm,
    source: ManualSource,
    clock: EditorClock,
) -> ProspectView:
    """A prospect entered by hand, with its aliases, tracking and `manual` provenance."""
    form = _cleaned(session, form)
    context = _required(
        "provenance.legal_basis_or_collection_context",
        source.legal_basis_or_collection_context,
        TEXT_MAX_LENGTH,
    )
    reference = _text("provenance.source_reference", source.source_reference, TEXT_MAX_LENGTH)
    prospect = prospects.create_prospect(
        session,
        actor,
        prospects.ProspectInput(
            first_name=form.first_name,
            last_name=form.last_name,
            civility=form.civility,
            company_id=form.company_id,
            role_id=_role_id(session, actor, form),
            exact_job_title=form.exact_job_title,
            activity_status=form.activity_status,
            employment_verified_at=_employment_verified_at(
                None, form.employment_verification, clock
            ),
        ),
    )
    _save_details(session, actor, prospect, form, clock)
    provenance.add_manual_source(
        session,
        actor,
        prospect.id,
        legal_basis_or_collection_context=context,
        source_reference=reference,
    )
    return get_view(session, prospect.id, clock)


def update_prospect(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    version: str,
    form: ProspectForm,
    clock: EditorClock,
) -> EditorResult:
    """Replace the prospect's editable state (see the module steps)."""
    prospect = _locked(session, prospect_id, version)
    form = _cleaned(session, form)
    role_id = _role_id(session, actor, form)
    assert form.company_id is not None  # checked by _cleaned
    if form.company_id != prospect.company_id:
        prospects.change_company(session, actor, prospect.id, form.company_id)
    verified_at = _employment_verified_at(
        prospect.employment_verified_at, form.employment_verification, clock
    )
    _apply_fields(session, actor, prospect, form, role_id, verified_at)
    messages = _save_details(session, actor, prospect, form, clock)
    return EditorResult(get_view(session, prospect.id, clock), messages)


def set_contactability(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    version: str,
    *,
    do_not_contact: bool,
    reason: str,
    clock: EditorClock,
) -> EditorResult:
    """Record or lift the durable opposition through its dedicated operations; a reason is
    required both ways (setting: on the row and in the event; lifting: in the event, I-28)."""
    _locked(session, prospect_id, version)
    text = _required("reason", reason, TEXT_MAX_LENGTH)
    messages = NOTHING
    if do_not_contact:
        messages = prospects.record_do_not_contact(
            session, actor, prospect_id, reason=text
        ).messages
    else:
        prospects.clear_do_not_contact(session, actor, prospect_id, reason=text)
    return EditorResult(get_view(session, prospect_id, clock), messages)


def update_tracking(
    session: Session,
    actor: ActorContext,
    prospect_id: uuid.UUID,
    version: str,
    update: TrackingUpdate,
    clock: EditorClock,
) -> EditorResult:
    """Choose the commercial state (« Défaillant » included). Only a person may do it (D7); dates
    and referent are kept. A new tracking starts `neutral`. Refusals: `ActorNotAllowedError`,
    `TrackingRuleError` (`ignored_is_terminal`), `ConflictError`. Answers the view and the number
    of unsent messages a sequence-closing state cancelled."""
    if actor.type is not ActorType.HUMAN:
        raise ActorNotAllowedError("Only a person changes a contact state.")
    prospect = _locked(session, prospect_id, version)
    current = prospect.contact_tracking
    saved = apply_contact_tracking(
        session,
        actor,
        prospect.id,
        ContactTrackingInput(
            status=update.status or (current.status if current else DEFAULT_STATE),
            referent_id=current.referent_id if current else None,
            response_received_at=current.response_received_at if current else None,
            appointment_at=current.appointment_at if current else None,
        ),
        now=clock.now,
    )
    return EditorResult(get_view(session, prospect.id, clock), saved.messages)


def delete_prospect(
    session: Session, actor: ActorContext, prospect_id: uuid.UUID, version: str
) -> None:
    """Delete the prospect and what belongs to it (e-mails, phones, tracking and its history,
    sources, import-row traces — database cascades, recorded by the one `prospect.deleted` event).
    A do-not-contact prospect cannot be deleted: lift the opposition first (with its reason)."""
    prospect = _locked(session, prospect_id, version)
    if prospect.contactability_status is ContactabilityStatus.DO_NOT_CONTACT:
        raise DoNotContactError("A do-not-contact prospect cannot be deleted.")
    audit.annotate(session, actor, prospect)
    session.delete(prospect)
    session.flush()
