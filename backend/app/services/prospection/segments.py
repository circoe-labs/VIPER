"""Canonical Prospection semantics (Task 14): named prospect segments as SQL predicates.

The Prospection counters, the people list and Home (Task 16) all read these definitions; nothing
else may re-derive "never verified", "due" or "no response". Every predicate reads the rows joined
by `join_segment_sources` (a prospect, its company, its single contact tracking and its primary
e-mail — at most one of each, so the join never multiplies prospects). Definitions, examples and
rationale: doc/features/prospection-kpis.md (decisions I-90 … I-93).
"""

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from enum import StrEnum
from typing import Any

from sqlalchemy import ColumnElement, Label, Select, and_, case, exists, false, func, or_, true
from sqlalchemy.orm import aliased

from app.core.business_time import BUSINESS_TIMEZONE
from app.models import Company, ContactTracking, Email, Phone, Prospect
from app.models.enums import (
    ActivityStatus,
    ContactabilityStatus,
    ContactTrackingStatus,
    VerificationStatus,
)

# The prospect's primary e-mail (at most one: partial unique index; a primary is always active).
primary_email = aliased(Email, name="primary_email")


class Segment(StrEnum):
    """Named subsets of prospects; the value is the URL/API key (`?segment=due`)."""

    ALL = "all"
    # Employment verification (grill decision 6: no date = never verified).
    NEVER_VERIFIED = "never_verified"
    NEEDS_RECHECK = "needs_recheck"
    # Activity status (independent of verification).
    ACTIVE = "active"
    UNKNOWN = "unknown"
    INACTIVE = "inactive"
    # Durable opposition (contactability), independent of the tracking stage.
    DO_NOT_CONTACT = "do_not_contact"
    # Primary e-mail state.
    EMAIL_MISSING = "email_missing"
    EMAIL_INVALID = "email_invalid"
    EMAIL_UNVERIFIED = "email_unverified"
    # Contact planning and outcomes (Suivi de contact).
    TO_CONTACT = "to_contact"
    DUE = "due"
    CONTACTED = "contacted"
    NO_RESPONSE = "no_response"
    RESPONSES = "responses"
    APPOINTMENTS = "appointments"


class VerificationState(StrEnum):
    """Employment verification of one prospect, from the same predicates as the segments."""

    NEVER_VERIFIED = "never_verified"  # employment_verified_at IS NULL
    STALE = "stale"  # verified before the configured age threshold
    CHANNELS_RESET = "channels_reset"  # verified, but a verified channel was reset since
    VERIFIED = "verified"


class EmailState(StrEnum):
    MISSING = "missing"
    INVALID = "invalid"
    UNVERIFIED = "unverified"  # `unverified` or `unknown`: not known to be deliverable
    VERIFIED = "verified"


S = ContactTrackingStatus
# Stages reached only after a first contact attempt (every stage but `to_contact`).
CONTACTED_STAGES = tuple(stage for stage in S if stage is not S.TO_CONTACT)
# Contacted, followed up, still waiting for an answer.
AWAITING_STAGES = (S.CONTACTED, S.FOLLOW_UP_1, S.FOLLOW_UP_2)
# The prospect answered — positively or not (`not_interested` is an answer).
RESPONDED_STAGES = (
    S.RESPONSE_RECEIVED,
    S.APPOINTMENT_OBTAINED,
    S.QUOTE_SENT,
    S.QUOTE_FOLLOW_UP,
    S.WON,
    S.NOT_INTERESTED,
)
# An appointment was obtained (quotes and wins come after one in the stage chain).
APPOINTMENT_STAGES = (S.APPOINTMENT_OBTAINED, S.QUOTE_SENT, S.QUOTE_FOLLOW_UP, S.WON)


@dataclass(frozen=True, slots=True)
class SegmentContext:
    """What time-dependent segments compare with: the business day and the optional age threshold
    after which an employment verification is stale (`VIPER_VERIFICATION_STALE_DAYS`, open
    question #9 — unset by default: no age-based re-check)."""

    today: date
    stale_days: int | None = None

    @classmethod
    def at(cls, moment: datetime, stale_days: int | None = None) -> SegmentContext:
        return cls(today=moment.astimezone(BUSINESS_TIMEZONE).date(), stale_days=stale_days)

    @property
    def due_before(self) -> datetime:
        """Start of tomorrow (business time): a contact planned before it is due."""
        return _midnight(self.today + timedelta(days=1))

    @property
    def stale_before(self) -> datetime | None:
        """Start of the day `stale_days` ago: a verification before it is stale."""
        if self.stale_days is None:
            return None
        return _midnight(self.today - timedelta(days=self.stale_days))


def _midnight(day: date) -> datetime:
    return datetime.combine(day, time(), tzinfo=BUSINESS_TIMEZONE)


def join_segment_sources[T: tuple[Any, ...]](statement: Select[T]) -> Select[T]:
    """`statement` over every prospect with its company, contact tracking and primary e-mail."""
    return (
        statement.select_from(Prospect)
        .outerjoin(Company, Company.id == Prospect.company_id)
        .outerjoin(ContactTracking, ContactTracking.prospect_id == Prospect.id)
        .outerjoin(
            primary_email,
            and_(primary_email.prospect_id == Prospect.id, primary_email.is_primary),
        )
    )


# --- building blocks ---------------------------------------------------------------------------


def _reset_channel(model: type[Email] | type[Phone]) -> ColumnElement[bool]:
    # A company change moves verified active channels back to `unverified` and keeps
    # `last_verified_at` (I-13): the combination is the trace of a verification that lapsed.
    return exists().where(
        model.prospect_id == Prospect.id,
        model.is_active,
        model.verification_status == VerificationStatus.UNVERIFIED,
        model.last_verified_at.is_not(None),
    )


def channels_reset() -> ColumnElement[bool]:
    return or_(_reset_channel(Email), _reset_channel(Phone))


def stale(context: SegmentContext) -> ColumnElement[bool]:
    before = context.stale_before
    if before is None:
        return false()
    return Prospect.employment_verified_at < before


def contactable() -> ColumnElement[bool]:
    return Prospect.contactability_status == ContactabilityStatus.CONTACTABLE


def actionable() -> ColumnElement[bool]:
    """Someone to contact or follow up now: no opposition, and not known to have left the role."""
    return and_(contactable(), Prospect.activity_status != ActivityStatus.INACTIVE)


def contacted() -> ColumnElement[bool]:
    """A contact attempt happened: a stage past `to_contact`, or a response/appointment date.
    Never NULL (a prospect without tracking is simply not contacted)."""
    return and_(
        ContactTracking.id.is_not(None),
        or_(
            ContactTracking.status.in_(CONTACTED_STAGES),
            ContactTracking.response_received_at.is_not(None),
            ContactTracking.appointment_at.is_not(None),
        ),
    )


def responded() -> ColumnElement[bool]:
    """An answer was recorded: a response date, an appointment (which implies one) or a stage
    reached only after an answer. Appointments are therefore always responses too."""
    return or_(
        ContactTracking.response_received_at.is_not(None),
        ContactTracking.appointment_at.is_not(None),
        ContactTracking.status.in_(RESPONDED_STAGES),
    )


def has_appointment() -> ColumnElement[bool]:
    return or_(
        ContactTracking.appointment_at.is_not(None),
        ContactTracking.status.in_(APPOINTMENT_STAGES),
    )


def needs_recheck(context: SegmentContext) -> ColumnElement[bool]:
    return and_(
        Prospect.employment_verified_at.is_not(None),
        or_(channels_reset(), stale(context)),
    )


def to_contact() -> ColumnElement[bool]:
    return and_(actionable(), ~contacted())


# --- segments ----------------------------------------------------------------------------------


def predicate(segment: Segment, context: SegmentContext) -> ColumnElement[bool]:
    """The SQL condition of `segment` over the rows of `join_segment_sources`."""
    match segment:
        case Segment.ALL:
            return true()
        case Segment.NEVER_VERIFIED:
            return Prospect.employment_verified_at.is_(None)
        case Segment.NEEDS_RECHECK:
            return needs_recheck(context)
        case Segment.ACTIVE | Segment.UNKNOWN | Segment.INACTIVE:
            return Prospect.activity_status == ActivityStatus(segment.value)
        case Segment.DO_NOT_CONTACT:
            return Prospect.contactability_status == ContactabilityStatus.DO_NOT_CONTACT
        case Segment.EMAIL_MISSING:
            return primary_email.id.is_(None)
        case Segment.EMAIL_INVALID:
            return primary_email.verification_status == VerificationStatus.INVALID
        case Segment.EMAIL_UNVERIFIED:
            return primary_email.verification_status.in_(
                (VerificationStatus.UNVERIFIED, VerificationStatus.UNKNOWN)
            )
        case Segment.TO_CONTACT:
            return to_contact()
        case Segment.DUE:
            return and_(to_contact(), ContactTracking.planned_contact_at < context.due_before)
        case Segment.CONTACTED:
            return contacted()
        case Segment.NO_RESPONSE:
            return and_(
                actionable(),
                ContactTracking.status.in_(AWAITING_STAGES),
                ContactTracking.response_received_at.is_(None),
                ContactTracking.appointment_at.is_(None),
            )
        case Segment.RESPONSES:
            return responded()
        case Segment.APPOINTMENTS:
            return has_appointment()


def _count(segment: Segment, context: SegmentContext) -> ColumnElement[int]:
    if segment is Segment.ALL:
        return func.count()
    return func.count().filter(predicate(segment, context))


def segment_counts(context: SegmentContext) -> list[Label[int]]:
    """One `count(*) FILTER (WHERE …)` per segment, labelled with its key, for a single aggregate
    query over `join_segment_sources`."""
    return [_count(segment, context).label(segment.value) for segment in Segment]


def verification_state(context: SegmentContext) -> ColumnElement[str]:
    return case(
        (Prospect.employment_verified_at.is_(None), VerificationState.NEVER_VERIFIED.value),
        (stale(context), VerificationState.STALE.value),
        (channels_reset(), VerificationState.CHANNELS_RESET.value),
        else_=VerificationState.VERIFIED.value,
    )


def email_state() -> ColumnElement[str]:
    return case(
        (primary_email.id.is_(None), EmailState.MISSING.value),
        (primary_email.verification_status == VerificationStatus.INVALID, EmailState.INVALID.value),
        (
            primary_email.verification_status == VerificationStatus.VERIFIED,
            EmailState.VERIFIED.value,
        ),
        else_=EmailState.UNVERIFIED.value,
    )
