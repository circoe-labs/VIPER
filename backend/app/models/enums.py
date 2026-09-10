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
    """Current tracking stage. Durable opposition is `ContactabilityStatus`, never a stage."""

    TO_CONTACT = "to_contact"
    CONTACTED = "contacted"
    FOLLOW_UP_1 = "follow_up_1"
    FOLLOW_UP_2 = "follow_up_2"
    RESPONSE_RECEIVED = "response_received"
    APPOINTMENT_OBTAINED = "appointment_obtained"
    QUOTE_SENT = "quote_sent"
    QUOTE_FOLLOW_UP = "quote_follow_up"
    WON = "won"
    NOT_INTERESTED = "not_interested"


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
