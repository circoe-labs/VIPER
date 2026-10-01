"""Contact workflow contract (pure): state labels, the level derived from real sends and the next
due date (sequences rework, decisions D1, D2, D6, D7, D9).

Single Python source for what the Contact data means:

- the **commercial state** (`ContactTrackingStatus`) is chosen by a person: `neutral` (« en
  séquence », the default, no badge), `response_received`, `appointment_obtained`, `ignored`
  (terminal, implies do-not-contact) and `disqualified` (« Défaillant », a person only);
- the **cohort** (`Sxx`, real start date) and the **sequence** say where the prospect stands; `S0`
  is validated but out of campaign;
- the **level** is never stored: it is the number of messages really sent in the current
  sequence — 0 sent: the Contact is the step to send; n sent: Rn is the step to send; after the
  send of R<max> (« max relances », 4 by default) the sequence is « Relance terminée » (still
  contactable, out of the automatic actions). A planned but unsent message moves nothing;
- the **next due date** is the cohort's date for the Contact, then the Monday (business midnight)
  of the calendar week after the last send — nothing is due when the sequence is finished or
  closed, the cohort is S0, the state is not `neutral`, or an « Erreur sur le mail » alert raised
  by a person (or an import) is open.

Nothing here reads or writes the database: `app.services.contact_sequences` applies the rules (in
Python for one prospect, in SQL for lists — both follow `next_due`).
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from enum import StrEnum

from app.core.actor import ActorType
from app.core.business_time import business_day, start_of_day
from app.models.contact_tracking import ContactTrackingStatusHistory
from app.models.enums import (
    ContactMessageStatus,
    ContactMessageStep,
    ContactTrackingStatus,
    TrackingHistoryStatus,
)

S = ContactTrackingStatus
H = TrackingHistoryStatus

# Alembic revisions that converted states; the `actor_id` of the `system` history rows they
# appended (the migrations repeat these literals: migrations never import application code).
CONTACT_STATES_MIGRATION_ID = "0008_contact_states"
CONTACT_SEQUENCES_MIGRATION_ID = "0010_contact_sequences"
RESTATEMENT_ACTOR_IDS = (CONTACT_STATES_MIGRATION_ID, CONTACT_SEQUENCES_MIGRATION_ID)

DEFAULT_STATE = S.NEUTRAL
# « Max relances » when Paramètres has no value (D2).
DEFAULT_MAX_FOLLOW_UPS = 4
MAX_FOLLOW_UPS_LIMIT = 20

# French labels (history, export). The UI shows no badge for `neutral`.
STATE_LABELS: dict[ContactTrackingStatus, str] = {
    S.NEUTRAL: "En séquence",
    S.RESPONSE_RECEIVED: "Réponse reçue",
    S.APPOINTMENT_OBTAINED: "RDV pris",
    S.IGNORED: "Ignoré",
    S.DISQUALIFIED: "Défaillant",
}
# French labels of the mail steps the editor names and of message statuses.
MESSAGE_STEP_LABELS: dict[ContactMessageStep, str] = {
    ContactMessageStep.CONTACT: "Contact",
    ContactMessageStep.R1: "R1",
    ContactMessageStep.R2: "R2",
}
MESSAGE_STATUS_LABELS: dict[ContactMessageStatus, str] = {
    ContactMessageStatus.DRAFT: "Brouillon",
    ContactMessageStatus.VALIDATED: "Validé",
    ContactMessageStatus.SCHEDULED: "Programmé",
    ContactMessageStatus.SENT: "Envoyé",
    ContactMessageStatus.CANCELLED: "Annulé",
}
# Labels of the codes replaced by migrations 0008 and 0010, still found in old history rows and
# audit events.
LEGACY_LABELS: dict[TrackingHistoryStatus, str] = {
    H.LEGACY_CONTACTED: "Contacté (ancien)",
    H.LEGACY_R1: "R1 (ancien)",
    H.LEGACY_R2: "R2 (ancien)",
    H.LEGACY_FAILURE: "Failure (ancien)",
    H.LEGACY_TO_CONTACT: "À contacter (ancien)",
    H.LEGACY_FOLLOW_UP_1: "Relance 1 (ancien)",
    H.LEGACY_FOLLOW_UP_2: "Relance 2 (ancien)",
    H.LEGACY_QUOTE_SENT: "Devis envoyé (ancien)",
    H.LEGACY_QUOTE_FOLLOW_UP: "Suivi du devis (ancien)",
    H.LEGACY_WON: "Gagné (ancien)",
    H.LEGACY_NOT_INTERESTED: "Pas intéressé (ancien)",
}
# History codes that prove a contact attempt (Home's monthly progress reads history written
# before the sends existed): every code but `neutral`/`to_contact` and the states that may be
# chosen without any contact (`ignored`, `disqualified`).
CONTACT_ATTEMPT_CODES: tuple[TrackingHistoryStatus, ...] = (
    H.LEGACY_CONTACTED,
    H.LEGACY_R1,
    H.LEGACY_R2,
    H.LEGACY_FAILURE,
    H.RESPONSE_RECEIVED,
    H.APPOINTMENT_OBTAINED,
    H.LEGACY_FOLLOW_UP_1,
    H.LEGACY_FOLLOW_UP_2,
    H.LEGACY_QUOTE_SENT,
    H.LEGACY_QUOTE_FOLLOW_UP,
    H.LEGACY_WON,
    H.LEGACY_NOT_INTERESTED,
)
# History codes of an appointment obtained (the 0008 post-appointment codes included).
APPOINTMENT_CODES: tuple[TrackingHistoryStatus, ...] = (
    H.APPOINTMENT_OBTAINED,
    H.LEGACY_QUOTE_SENT,
    H.LEGACY_QUOTE_FOLLOW_UP,
    H.LEGACY_WON,
)

# A human choice of one of these cancels the prospect's future unsent messages (decision 29) and
# takes it out of the automatic actions.
SEQUENCE_CLOSING_STATES = (
    S.RESPONSE_RECEIVED,
    S.APPOINTMENT_OBTAINED,
    S.IGNORED,
    S.DISQUALIFIED,
)
# No way out; implies `do_not_contact` (decision 7).
TERMINAL_STATES = (S.IGNORED,)
# States only a person may choose (D4/D7: never an import, a job or the AI).
HUMAN_ONLY_STATES = (S.DISQUALIFIED,)


def history_label(code: str | None) -> str | None:
    """Label of a status as recorded in history or an audit event (current or legacy code)."""
    if code is None:
        return None
    if code in STATE_LABELS:
        return STATE_LABELS[S(code)]
    if code in LEGACY_LABELS:
        return LEGACY_LABELS[H(code)]
    return None


def is_restatement(row: ContactTrackingStatusHistory) -> bool:
    """A history row appended by migration 0008 or 0010: a code conversion, not a moment the
    prospect reached a state."""
    return row.actor_type is ActorType.SYSTEM and row.actor_id in RESTATEMENT_ACTOR_IDS


def state_reached_at(history: Sequence[ContactTrackingStatusHistory]) -> datetime | None:
    """When the current state was reached (`status_since`): the latest history row (oldest first)
    that is not a migration restatement."""
    return next((row.changed_at for row in reversed(history) if not is_restatement(row)), None)


# --- steps and level ----------------------------------------------------------------------------


def step_code(rank: int) -> str:
    """`contact`, `r1`, `r2`…: the stable code of a rank."""
    return "contact" if rank == 0 else f"r{rank}"


def step_label(rank: int) -> str:
    """« Contact », « R1 », « R2 »…"""
    return "Contact" if rank == 0 else f"R{rank}"


FINISHED_LABEL = "Relance terminée"


class PauseReason(StrEnum):
    """Why nothing is due for a prospect (first reason that applies, in this order)."""

    NO_COHORT = "no_cohort"  # not validated: no current sequence
    OUT_OF_CAMPAIGN = "out_of_campaign"  # S0
    STATE = "state"  # response, appointment, ignored, Défaillant
    SEQUENCE_CLOSED = "sequence_closed"  # closed `completed` (« Relance terminée »)
    FINISHED = "finished"  # R<max> sent (« Relance terminée »)
    EMAIL_ERROR = "email_error"  # an open « Erreur sur le mail » (D9)


@dataclass(frozen=True, slots=True)
class SequenceFacts:
    """What the level and the next due date depend on, for one prospect."""

    has_sequence: bool
    sequence_open: bool = False
    out_of_campaign: bool = False
    cohort_starts_on: date | None = None
    sent_count: int = 0
    last_sent_at: datetime | None = None
    state: ContactTrackingStatus | None = None
    email_error: bool = False


@dataclass(frozen=True, slots=True)
class Progress:
    # Messages really sent in the current sequence.
    sent_count: int
    # « Relance terminée »: R<max> sent, or the sequence closed `completed`.
    finished: bool
    # The rank to send next (0 = Contact); None when finished or without a sequence.
    next_rank: int | None
    # « Contact », « R2 », « Relance terminée »; None without a sequence.
    level_label: str | None
    # Business midnight of the day the next step is due; None when nothing is due.
    next_due_at: datetime | None
    pause: PauseReason | None


def monday_after(moment: datetime) -> date:
    """Monday of the calendar week after the business day of `moment`."""
    day = business_day(moment)
    return day - timedelta(days=day.weekday()) + timedelta(weeks=1)


def progress(facts: SequenceFacts, max_follow_ups: int) -> Progress:
    """The level and the next due date (D1, D2, D9); the SQL twin is
    `contact_sequences.next_due_at_sql`."""
    if not facts.has_sequence:
        return Progress(0, False, None, None, None, PauseReason.NO_COHORT)
    finished = not facts.sequence_open or facts.sent_count > max_follow_ups
    next_rank = None if finished else facts.sent_count
    label = FINISHED_LABEL if finished else step_label(facts.sent_count)
    pause: PauseReason | None = None
    if facts.out_of_campaign:
        pause = PauseReason.OUT_OF_CAMPAIGN
    elif facts.state is not None and facts.state is not S.NEUTRAL:
        pause = PauseReason.STATE
    elif not facts.sequence_open:
        pause = PauseReason.SEQUENCE_CLOSED
    elif finished:
        pause = PauseReason.FINISHED
    elif facts.email_error:
        pause = PauseReason.EMAIL_ERROR
    due: datetime | None = None
    if pause is None:
        if facts.sent_count == 0:
            due = start_of_day(facts.cohort_starts_on) if facts.cohort_starts_on else None
        elif facts.last_sent_at is not None:
            due = start_of_day(monday_after(facts.last_sent_at))
    return Progress(facts.sent_count, finished, next_rank, label, due, pause)


# --- ISO (calendar) weeks -----------------------------------------------------------------------


@dataclass(frozen=True, slots=True, order=True)
class IsoWeek:
    """An ISO 8601 calendar week (Monday-Sunday): ISO week-numbering year and week (1-52 or 53).
    Used for the calendar planning of due dates; a cohort code `Sxx` is never an ISO week (D5)."""

    year: int
    week: int

    def __post_init__(self) -> None:
        # Raises ValueError for a week that does not exist (week 53 of a 52-week year…).
        date.fromisocalendar(self.year, self.week, 1)

    @classmethod
    def of(cls, day: date) -> IsoWeek:
        year, week, _ = day.isocalendar()
        return cls(year, week)

    @property
    def monday(self) -> date:
        return date.fromisocalendar(self.year, self.week, 1)

    @property
    def label(self) -> str:
        """`2026-W41`."""
        return f"{self.year}-W{self.week:02d}"

    def plus(self, weeks: int) -> IsoWeek:
        return IsoWeek.of(self.monday + timedelta(weeks=weeks))


def weeks_in_year(year: int) -> int:
    """52 or 53: December 28 always falls in the last ISO week of its year."""
    return date(year, 12, 28).isocalendar().week
