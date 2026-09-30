"""Contact workflow contract (pure): state labels, state groups, ISO weeks and the default cadence.

Single Python source for what the Contact states mean (handoff decision log, decisions 4-14):

- `neutral` is the initial state and shows no badge (UI); history and export say « Aucun état »;
- the next action is a week, separate from the state (P1: stored as `planned_contact_at`, the
  Monday of that ISO week at business midnight; the week is always derived);
- the cadence only *suggests* a next week — every state change is a human decision (decision 10);
- `ignored` is terminal and persistent (decision 7).

Nothing here reads or writes the database; `app.services.contact_tracking` applies the rules.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from app.core.actor import ActorType
from app.core.business_time import start_of_day
from app.models.contact_tracking import ContactTrackingStatusHistory
from app.models.enums import (
    ContactMessageStatus,
    ContactMessageStep,
    ContactTrackingStatus,
    TrackingHistoryStatus,
)

S = ContactTrackingStatus
H = TrackingHistoryStatus

# Alembic revision that replaced the legacy taxonomy; the `actor_id` of the `system` history rows
# it appended (the migration repeats this literal: migrations never import application code).
CONTACT_STATES_MIGRATION_ID = "0008_contact_states"

DEFAULT_STATE = S.NEUTRAL

# French labels (history, export). The UI shows no badge for `neutral` (decision 4).
STATE_LABELS: dict[ContactTrackingStatus, str] = {
    S.NEUTRAL: "Aucun état",
    S.CONTACTED: "Contacté",
    S.R1: "R1",
    S.R2: "R2",
    S.RESPONSE_RECEIVED: "Réponse reçue",
    S.APPOINTMENT_OBTAINED: "RDV pris",
    S.FAILURE: "Failure",
    S.IGNORED: "Ignoré",
}
# French labels of the mail sequence (decisions 20-24): tabs and message statuses.
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
# Labels of the codes replaced by migration 0008, still found in old history rows and audit events.
LEGACY_LABELS: dict[TrackingHistoryStatus, str] = {
    H.LEGACY_TO_CONTACT: "À contacter (ancien)",
    H.LEGACY_FOLLOW_UP_1: "Relance 1 (ancien)",
    H.LEGACY_FOLLOW_UP_2: "Relance 2 (ancien)",
    H.LEGACY_QUOTE_SENT: "Devis envoyé (ancien)",
    H.LEGACY_QUOTE_FOLLOW_UP: "Suivi du devis (ancien)",
    H.LEGACY_WON: "Gagné (ancien)",
    H.LEGACY_NOT_INTERESTED: "Pas intéressé (ancien)",
}
# What a legacy code counts as when history is read as facts (Home's monthly progress). Same
# mapping as migration 0008, except `not_interested`, which depended on the durable opposition:
# either way it was a contact attempt without appointment, like `failure`.
LEGACY_EQUIVALENTS: dict[TrackingHistoryStatus, ContactTrackingStatus] = {
    H.LEGACY_TO_CONTACT: S.NEUTRAL,
    H.LEGACY_FOLLOW_UP_1: S.R1,
    H.LEGACY_FOLLOW_UP_2: S.R2,
    H.LEGACY_QUOTE_SENT: S.APPOINTMENT_OBTAINED,
    H.LEGACY_QUOTE_FOLLOW_UP: S.APPOINTMENT_OBTAINED,
    H.LEGACY_WON: S.APPOINTMENT_OBTAINED,
    H.LEGACY_NOT_INTERESTED: S.FAILURE,
}

# States with an active next action by default: first contact, R1, R2, review after R2.
NEXT_ACTION_STATES = (S.NEUTRAL, S.CONTACTED, S.R1, S.R2)
# A human choice of one of these cancels the prospect's future unsent messages (decision 29).
SEQUENCE_CLOSING_STATES = (S.RESPONSE_RECEIVED, S.APPOINTMENT_OBTAINED, S.IGNORED)
# No way out, no next action; implies `do_not_contact` (decision 7).
TERMINAL_STATES = (S.IGNORED,)
# Weeks from the step just done to the suggested next action (decisions 11-13).
CADENCE_WEEKS: dict[ContactTrackingStatus, int] = {S.CONTACTED: 2, S.R1: 2, S.R2: 4}


def history_label(code: str | None) -> str | None:
    """Label of a status as recorded in history or an audit event (current or legacy code)."""
    if code is None:
        return None
    if code in STATE_LABELS:
        return STATE_LABELS[S(code)]
    if code in LEGACY_LABELS:
        return LEGACY_LABELS[H(code)]
    return None


def history_codes(states: tuple[ContactTrackingStatus, ...]) -> tuple[TrackingHistoryStatus, ...]:
    """`states` as history codes, with the legacy codes that mean one of them."""
    legacy = (code for code, state in LEGACY_EQUIVALENTS.items() if state in states)
    return (*(H(state.value) for state in states), *legacy)


def is_restatement(row: ContactTrackingStatusHistory) -> bool:
    """A history row appended by migration 0008: a code conversion, not a moment the prospect
    reached a state."""
    return row.actor_type is ActorType.SYSTEM and row.actor_id == CONTACT_STATES_MIGRATION_ID


def state_reached_at(history: Sequence[ContactTrackingStatusHistory]) -> datetime | None:
    """When the current state was reached (`status_since`, cadence anchor): the latest history
    row (oldest first) that is not a 0008 restatement — for a converted tracking, the legacy row
    it restates."""
    return next((row.changed_at for row in reversed(history) if not is_restatement(row)), None)


# --- ISO weeks ----------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True, order=True)
class IsoWeek:
    """An ISO 8601 week: ISO week-numbering year and week (1-52 or 53)."""

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
        """`2026-W41`, the format of `planned_contact_week`."""
        return f"{self.year}-W{self.week:02d}"

    def plus(self, weeks: int) -> IsoWeek:
        return IsoWeek.of(self.monday + timedelta(weeks=weeks))


def weeks_in_year(year: int) -> int:
    """52 or 53: December 28 always falls in the last ISO week of its year."""
    return date(year, 12, 28).isocalendar().week


def next_action_at(week: IsoWeek) -> datetime:
    """The stored next action for `week`: its Monday at business midnight (P1)."""
    return start_of_day(week.monday)


def suggest_next_action(state: ContactTrackingStatus, from_day: date) -> IsoWeek | None:
    """Default next week after reaching `state` on `from_day` (contacted/R1: +2, R2: +4 review);
    None for the other states. A proposal only: never applied without a human."""
    weeks = CADENCE_WEEKS.get(state)
    return IsoWeek.of(from_day).plus(weeks) if weeks is not None else None
