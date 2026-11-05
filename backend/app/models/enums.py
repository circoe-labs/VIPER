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


class CompanyKind(StrEnum):
    """Type d'entreprise: PME (< 250 salariés), grande entreprise (250 et plus, ETI comprises) ou
    institutionnel (secteur public, collectivités, établissements publics)."""

    SME = "sme"
    LARGE = "large"
    INSTITUTIONAL = "institutional"


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
    # « Non intéressé »: a negative answer, chosen by a person; closes the sequence, reversible.
    NOT_INTERESTED = "not_interested"
    IGNORED = "ignored"
    # « Défaillant »: a contact to eliminate, out of every sequence (a human decision only).
    DISQUALIFIED = "disqualified"


class TrackingHistoryStatus(StrEnum):
    """A status as recorded in `contact_tracking_status_history`: the current states plus the codes
    replaced by migrations 0008 and 0012. History rows are never rewritten, so older rows keep
    their original code (read-only compatibility; nothing writes a legacy code)."""

    NEUTRAL = "neutral"
    RESPONSE_RECEIVED = "response_received"
    APPOINTMENT_OBTAINED = "appointment_obtained"
    NOT_INTERESTED = "not_interested"
    IGNORED = "ignored"
    DISQUALIFIED = "disqualified"
    # Contact states replaced by migration 0012 (the level is derived from real sends), readable.
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
    MIGRATION = "migration"  # implied by a former state (migration 0012)
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


class AppointmentStatus(StrEnum):
    """Follow-up of a booked meeting (`appointments.status`); « décalé » is a new date."""

    SCHEDULED = "scheduled"
    COMPLETED = "completed"
    NO_SHOW = "no_show"
    CANCELLED = "cancelled"


class AppointmentSource(StrEnum):
    """Where an appointment row comes from (`appointments.source`)."""

    CALENDLY = "calendly"
    MANUAL = "manual"


class AgentThreadKind(StrEnum):
    """What an « Analyse » thread is about (`agent_threads.kind`)."""

    # One company to complete: its fields, its signals, its people.
    COMPANY_REVIEW = "company_review"
    # One prospecting brief, with no company yet (`agent_threads.brief`).
    PROSPECT_SEARCH = "prospect_search"


class AgentThreadStatus(StrEnum):
    """Lifecycle of a thread; `done` and `cancelled` are terminal for the card."""

    OPEN = "open"
    PAUSED = "paused"
    DONE = "done"
    CANCELLED = "cancelled"


class AgentTaskType(StrEnum):
    """What an agent is asked to do; the payload and the output schema follow the type
    (`app.services.agent_payloads`)."""

    UPDATE_COMPANY = "update_company"
    UPDATE_EMPLOYEE = "update_employee"
    FIND_EMPLOYEES = "find_employees"
    SURVEIL_SIGNALS = "surveil_signals"
    FIND_PROSPECTS = "find_prospects"


class AgentTaskStatus(StrEnum):
    """One task, from the queue to the person's decision. `submitted` waits for a review; a lease
    that expires is not a status (the task returns to `pending`)."""

    PENDING = "pending"
    CLAIMED = "claimed"
    SUBMITTED = "submitted"
    ACCEPTED = "accepted"
    FAILED = "failed"
    CANCELLED = "cancelled"


class AgentResultStatus(StrEnum):
    """One submission (`agent_task_results`): immutable, one row per attempt."""

    PENDING_REVIEW = "pending_review"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    # An earlier attempt of the same task, kept for the history.
    SUPERSEDED = "superseded"


class MissionType(StrEnum):
    """What a mission asks for, from the modal's « Type » (`missions.type`)."""

    PROSPECTION = "prospection"
    SIGNALS = "signals"
    ENRICHMENT = "enrichment"
    VERIFICATION = "verification"
    OTHER = "other"


class MissionStatus(StrEnum):
    """Lifecycle of a mission; `done` and `cancelled` are terminal."""

    ACTIVE = "active"
    PAUSED = "paused"
    DONE = "done"
    CANCELLED = "cancelled"


class MissionRunStatus(StrEnum):
    """One execution of a mission: `scheduled` waits, `running` waits for its tasks."""

    SCHEDULED = "scheduled"
    RUNNING = "running"
    DONE = "done"
    FAILED = "failed"
    CANCELLED = "cancelled"


class MissionRunTrigger(StrEnum):
    """Why a run exists: a person pressed « Lancer », or the recurrence created it."""

    MANUAL = "manual"
    SCHEDULE = "schedule"


class RecurrenceUnit(StrEnum):
    """The unit of « Tous les [X] … »."""

    HOURS = "hours"
    DAYS = "days"
    WEEKS = "weeks"
    MONTHS = "months"


class MissionEndKind(StrEnum):
    """How a recurrence stops."""

    NEVER = "never"
    DATE = "date"
    AFTER = "after"


class MissionResultKind(StrEnum):
    """What the mission is expected to produce (the modal's « Résultat attendu »)."""

    COMPANIES = "companies"
    PROSPECTS = "prospects"
    SIGNALS = "signals"
    ENRICHMENT = "enrichment"


class SignalKind(StrEnum):
    """What kind of dated fact a signal is (`prospect_notes.kind`)."""

    HIRING = "hiring"
    FUNDING = "funding"
    NEWS = "news"
    SOCIAL_POST = "social_post"
    EVENT = "event"
    PRODUCT_LAUNCH = "product_launch"
    PARTNERSHIP = "partnership"
    TECH_CHANGE = "tech_change"
    NEED_EXPRESSED = "need_expressed"
    OTHER = "other"


class SignalOrigin(StrEnum):
    """Who produced the signal: a person in the UI, or an agent's proposal."""

    MANUAL = "manual"
    AGENT = "agent"
