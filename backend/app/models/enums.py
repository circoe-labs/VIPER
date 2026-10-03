"""Fixed technical value sets, stored as text + CHECK constraint (ADR-0002).

Business taxonomies (roles, segments, activity categories) are tables, never enums.
"""

from enum import StrEnum


class Civility(StrEnum):
    MR = "mr"
    MS = "ms"


class ActivityStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"
    UNKNOWN = "unknown"


class ContactabilityStatus(StrEnum):
    CONTACTABLE = "contactable"
    DO_NOT_CONTACT = "do_not_contact"


class VerificationStatus(StrEnum):
    UNVERIFIED = "unverified"
    VERIFIED = "verified"
    INVALID = "invalid"
    UNKNOWN = "unknown"


class OriginType(StrEnum):
    IMPORTED = "imported"
    MANUAL = "manual"
    PUBLISHED = "published"
    INFERRED = "inferred"
    OTHER = "other"


class PhoneType(StrEnum):
    MOBILE = "mobile"
    LANDLINE = "landline"
    OTHER = "other"


class ContactTrackingStatus(StrEnum):
    """Contact state of a prospect (Contact model, handoff decisions 4-10). Declaration order is the
    display order. `neutral` is the initial state and shows no badge; the next-action week is a
    separate datum (`planned_contact_at`). Durable opposition is `ContactabilityStatus`, never a
    state (`ignored` reinforces it). Labels, cadence and rules: `app.services.contact_workflow`."""

    NEUTRAL = "neutral"
    CONTACTED = "contacted"
    R1 = "r1"
    R2 = "r2"
    RESPONSE_RECEIVED = "response_received"
    APPOINTMENT_OBTAINED = "appointment_obtained"
    FAILURE = "failure"
    IGNORED = "ignored"


class TrackingHistoryStatus(StrEnum):
    """A status as recorded in `contact_tracking_status_history`: the current states plus the codes
    of the taxonomy replaced by migration 0008. History rows are never rewritten, so rows written
    before 0008 keep their original code (read-only compatibility; nothing writes a legacy code)."""

    NEUTRAL = "neutral"
    CONTACTED = "contacted"
    R1 = "r1"
    R2 = "r2"
    RESPONSE_RECEIVED = "response_received"
    APPOINTMENT_OBTAINED = "appointment_obtained"
    FAILURE = "failure"
    IGNORED = "ignored"
    # Legacy codes (before migration 0008), readable only.
    LEGACY_TO_CONTACT = "to_contact"
    LEGACY_FOLLOW_UP_1 = "follow_up_1"
    LEGACY_FOLLOW_UP_2 = "follow_up_2"
    LEGACY_QUOTE_SENT = "quote_sent"
    LEGACY_QUOTE_FOLLOW_UP = "quote_follow_up"
    LEGACY_WON = "won"
    LEGACY_NOT_INTERESTED = "not_interested"


class ContactMessageStep(StrEnum):
    """Step of the Contact mail sequence (decision 20): one durable message per prospect and step.
    Declaration order is the sequence order (tabs Contact, R1, R2)."""

    CONTACT = "contact"
    R1 = "r1"
    R2 = "r2"


class ContactMessageStatus(StrEnum):
    """Status of one Contact message, distinct from the prospect's Contact state (decisions 21-24).
    Transitions and rules: `app.services.contact_messages`."""

    DRAFT = "draft"
    VALIDATED = "validated"
    SCHEDULED = "scheduled"
    SENT = "sent"
    CANCELLED = "cancelled"


class ProspectSourceType(StrEnum):
    EXCEL_IMPORT = "excel_import"
    MANUAL = "manual"
    FUTURE_AGENT = "future_agent"
    OTHER = "other"


class NoteSourceType(StrEnum):
    """Where a prospect note's fact comes from (`prospect_notes.source_type`); optional."""

    LINKEDIN = "linkedin"
    EMAIL = "email"
    PHONE = "phone"
    MEETING = "meeting"
    WEB = "web"
    OTHER = "other"


class ImportBatchStatus(StrEnum):
    PENDING = "pending"
    COMMITTED = "committed"
    FAILED = "failed"
    CANCELLED = "cancelled"
