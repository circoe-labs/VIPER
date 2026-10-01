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
    """Commercial state of a prospect (decision D7 of the sequences rework), chosen by a person.
    Declaration order is the display order. `neutral` is the default « en séquence » state and
    shows no badge. The level (Contact, R1…, « Relance terminée ») is never stored: it is derived
    from the messages really sent in the current sequence (`app.services.contact_sequences`).
    Durable opposition is `ContactabilityStatus`, never a state (`ignored` reinforces it)."""

    NEUTRAL = "neutral"
    RESPONSE_RECEIVED = "response_received"
    APPOINTMENT_OBTAINED = "appointment_obtained"
    IGNORED = "ignored"
    # « Défaillant »: a contact to eliminate, out of every sequence (a human decision only).
    DISQUALIFIED = "disqualified"


class TrackingHistoryStatus(StrEnum):
    """A status as recorded in `contact_tracking_status_history`: the current states plus the codes
    replaced by migrations 0008 and 0010. History rows are never rewritten, so older rows keep
    their original code (read-only compatibility; nothing writes a legacy code)."""

    NEUTRAL = "neutral"
    RESPONSE_RECEIVED = "response_received"
    APPOINTMENT_OBTAINED = "appointment_obtained"
    IGNORED = "ignored"
    DISQUALIFIED = "disqualified"
    # Contact states replaced by migration 0010 (the level is derived from real sends), readable.
    LEGACY_CONTACTED = "contacted"
    LEGACY_R1 = "r1"
    LEGACY_R2 = "r2"
    LEGACY_FAILURE = "failure"
    # Legacy codes (before migration 0008), readable only.
    LEGACY_TO_CONTACT = "to_contact"
    LEGACY_FOLLOW_UP_1 = "follow_up_1"
    LEGACY_FOLLOW_UP_2 = "follow_up_2"
    LEGACY_QUOTE_SENT = "quote_sent"
    LEGACY_QUOTE_FOLLOW_UP = "quote_follow_up"
    LEGACY_WON = "won"
    LEGACY_NOT_INTERESTED = "not_interested"


class ContactMessageStep(StrEnum):
    """The steps the message editor addresses by name (Contact, R1, R2): rank 0, 1, 2 of the
    current sequence. Messages are stored by rank (0..n, decision D6); S3 opens the ranks beyond
    R2 to the editor."""

    CONTACT = "contact"
    R1 = "r1"
    R2 = "r2"


class SequenceEndReason(StrEnum):
    """Why a contact sequence was closed (decision D6). History is kept either way."""

    # A person changed the prospect's cohort: a new sequence was opened.
    COHORT_CHANGED = "cohort_changed"
    # A person removed the prospect's cohort (no longer validated).
    COHORT_REMOVED = "cohort_removed"
    # The sequence ran its course (« Relance terminée »), e.g. the former `failure` state.
    COMPLETED = "completed"


class SendSource(StrEnum):
    """Who recorded that a message was really sent (decisions D1, D3)."""

    MANUAL = "manual"  # « Marquer comme envoyé » by a person
    IMPORT = "import"  # a past cohort date at import (S2)
    MIGRATION = "migration"  # implied by a former state (migration 0010)
    WORKER = "worker"  # the scheduled dispatcher (S7)


class QualityAlertType(StrEnum):
    """Data-quality alerts (decision D8): never a commercial state."""

    EMAIL_ERROR = "email_error"
    FUNCTION_TO_CHECK = "function_to_check"
    DATA_INCONSISTENT = "data_inconsistent"
    COMPANY_TO_CHECK = "company_to_check"
    IMPORT_CONFLICT = "import_conflict"


class QualityAlertSource(StrEnum):
    """Who raised an alert, from the actor: a person, an import or the AI (a proposal only)."""

    HUMAN = "human"
    IMPORT = "import"
    AI = "ai"


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


class ImportBatchStatus(StrEnum):
    PENDING = "pending"
    COMMITTED = "committed"
    FAILED = "failed"
    CANCELLED = "cancelled"
