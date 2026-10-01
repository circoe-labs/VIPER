"""Contact workflow contract (pure): states, labels, calendar weeks and the level and next due date
derived from the real sends (sequences rework D1, D2, D7, D9)."""

from datetime import UTC, date, datetime

import pytest

from app.core.business_time import BUSINESS_TIMEZONE
from app.models.enums import ContactTrackingStatus, TrackingHistoryStatus
from app.services import history
from app.services.contact_workflow import (
    APPOINTMENT_CODES,
    CONTACT_ATTEMPT_CODES,
    DEFAULT_MAX_FOLLOW_UPS,
    DEFAULT_STATE,
    FINISHED_LABEL,
    HUMAN_ONLY_STATES,
    SEQUENCE_CLOSING_STATES,
    STATE_LABELS,
    TERMINAL_STATES,
    IsoWeek,
    PauseReason,
    SequenceFacts,
    history_label,
    monday_after,
    progress,
    step_code,
    step_label,
)
from app.services.exports import spec

S = ContactTrackingStatus
H = TrackingHistoryStatus
COHORT_DAY = date(2026, 9, 28)  # a Monday (S39 of the handoff example)


def test_the_commercial_states_in_display_order() -> None:
    assert [state.value for state in S] == [
        "neutral",
        "response_received",
        "appointment_obtained",
        "ignored",
        "disqualified",
    ]
    assert DEFAULT_STATE is S.NEUTRAL
    assert STATE_LABELS == {
        S.NEUTRAL: "En séquence",
        S.RESPONSE_RECEIVED: "Réponse reçue",
        S.APPOINTMENT_OBTAINED: "RDV pris",
        S.IGNORED: "Ignoré",
        S.DISQUALIFIED: "Défaillant",
    }


def test_former_states_are_history_only() -> None:
    legacy = {"contacted", "r1", "r2", "failure"}
    legacy |= {"to_contact", "follow_up_1", "follow_up_2", "quote_sent", "quote_follow_up", "won"}
    legacy |= {"not_interested"}
    assert {code.value for code in H} == {state.value for state in S} | legacy
    for code in legacy:
        with pytest.raises(ValueError):
            S(code)
    assert H.LEGACY_CONTACTED in CONTACT_ATTEMPT_CODES
    assert H.NEUTRAL not in CONTACT_ATTEMPT_CODES and H.IGNORED not in CONTACT_ATTEMPT_CODES
    assert H.DISQUALIFIED not in CONTACT_ATTEMPT_CODES
    assert set(APPOINTMENT_CODES) == {
        H.APPOINTMENT_OBTAINED,
        H.LEGACY_QUOTE_SENT,
        H.LEGACY_QUOTE_FOLLOW_UP,
        H.LEGACY_WON,
    }


def test_history_labels_read_current_and_legacy_codes() -> None:
    assert history_label("r1") == "R1 (ancien)"
    assert history_label("contacted") == "Contacté (ancien)"
    assert history_label("disqualified") == "Défaillant"
    assert history_label("neutral") == "En séquence"
    assert history_label("follow_up_1") == "Relance 1 (ancien)"
    assert history_label(None) is None
    assert history_label("pending_review") is None


def test_state_groups() -> None:
    assert SEQUENCE_CLOSING_STATES == (
        S.RESPONSE_RECEIVED,
        S.APPOINTMENT_OBTAINED,
        S.IGNORED,
        S.DISQUALIFIED,
    )
    assert TERMINAL_STATES == (S.IGNORED,)
    assert HUMAN_ONLY_STATES == (S.DISQUALIFIED,)
    assert DEFAULT_MAX_FOLLOW_UPS == 4


def test_steps_are_named_from_their_rank() -> None:
    assert [step_code(rank) for rank in range(4)] == ["contact", "r1", "r2", "r3"]
    assert [step_label(rank) for rank in range(4)] == ["Contact", "R1", "R2", "R3"]


# --- level and next due date ------------------------------------------------------------------


def facts(**changes: object) -> SequenceFacts:
    values: dict[str, object] = {
        "has_sequence": True,
        "sequence_open": True,
        "cohort_starts_on": COHORT_DAY,
        "state": S.NEUTRAL,
    }
    return SequenceFacts(**(values | changes))  # type: ignore[arg-type]


def test_without_cohort_nothing_is_due() -> None:
    result = progress(SequenceFacts(has_sequence=False), DEFAULT_MAX_FOLLOW_UPS)

    assert (result.level_label, result.next_rank, result.next_due_at) == (None, None, None)
    assert result.pause is PauseReason.NO_COHORT


def test_the_contact_is_due_on_the_cohort_date() -> None:
    result = progress(facts(), DEFAULT_MAX_FOLLOW_UPS)

    assert (result.sent_count, result.next_rank, result.level_label) == (0, 0, "Contact")
    assert result.next_due_at == datetime(2026, 9, 28, tzinfo=BUSINESS_TIMEZONE)
    assert result.pause is None


def test_a_follow_up_is_due_the_monday_of_the_week_after_the_last_send() -> None:
    # Sent on Wednesday 30 September (business time): R1 is due on Monday 5 October.
    sent = datetime(2026, 9, 30, 14, 0, tzinfo=UTC)

    result = progress(facts(sent_count=1, last_sent_at=sent), DEFAULT_MAX_FOLLOW_UPS)

    assert (result.next_rank, result.level_label) == (1, "R1")
    assert result.next_due_at == datetime(2026, 10, 5, tzinfo=BUSINESS_TIMEZONE)


def test_a_send_late_on_sunday_counts_in_its_business_week() -> None:
    # Sunday 4 October 23:30 in Paris is still that week: due on Monday 5 October.
    sent = datetime(2026, 10, 4, 21, 30, tzinfo=UTC)

    assert monday_after(sent) == date(2026, 10, 5)


def test_a_planned_but_unsent_follow_up_moves_nothing() -> None:
    # The level only reads real sends: two sends, whatever is drafted or scheduled.
    sent = datetime(2026, 10, 6, 9, 0, tzinfo=UTC)

    result = progress(facts(sent_count=2, last_sent_at=sent), DEFAULT_MAX_FOLLOW_UPS)

    assert (result.next_rank, result.level_label) == (2, "R2")


def test_after_the_last_follow_up_the_sequence_is_finished_and_nothing_is_due() -> None:
    sent = datetime(2026, 10, 26, 9, 0, tzinfo=UTC)

    at_max = progress(facts(sent_count=4, last_sent_at=sent), 4)
    finished = progress(facts(sent_count=5, last_sent_at=sent), 4)

    assert (at_max.level_label, at_max.finished) == ("R4", False)
    assert (finished.level_label, finished.finished, finished.next_rank) == (
        FINISHED_LABEL,
        True,
        None,
    )
    assert (finished.next_due_at, finished.pause) == (None, PauseReason.FINISHED)


def test_the_maximum_is_a_parameter() -> None:
    sent = datetime(2026, 10, 6, 9, 0, tzinfo=UTC)

    assert progress(facts(sent_count=2, last_sent_at=sent), 1).finished
    assert not progress(facts(sent_count=2, last_sent_at=sent), 2).finished


def test_a_completed_sequence_is_finished() -> None:
    result = progress(facts(sequence_open=False), DEFAULT_MAX_FOLLOW_UPS)

    assert (result.finished, result.level_label, result.next_due_at) == (
        True,
        FINISHED_LABEL,
        None,
    )
    assert result.pause is PauseReason.SEQUENCE_CLOSED


@pytest.mark.parametrize(
    ("changes", "pause"),
    [
        ({"out_of_campaign": True, "cohort_starts_on": None}, PauseReason.OUT_OF_CAMPAIGN),
        ({"state": S.RESPONSE_RECEIVED}, PauseReason.STATE),
        ({"state": S.APPOINTMENT_OBTAINED}, PauseReason.STATE),
        ({"state": S.IGNORED}, PauseReason.STATE),
        ({"state": S.DISQUALIFIED}, PauseReason.STATE),
        ({"do_not_contact": True}, PauseReason.DO_NOT_CONTACT),
        ({"email_error": True}, PauseReason.EMAIL_ERROR),
    ],
)
def test_nothing_is_due_when_paused(changes: dict[str, object], pause: PauseReason) -> None:
    result = progress(facts(**changes), DEFAULT_MAX_FOLLOW_UPS)

    assert (result.next_due_at, result.pause) == (None, pause)


def test_an_email_error_keeps_the_level() -> None:
    sent = datetime(2026, 10, 6, 9, 0, tzinfo=UTC)

    result = progress(facts(sent_count=1, last_sent_at=sent, email_error=True), 4)

    assert (result.level_label, result.next_rank, result.next_due_at) == ("R1", 1, None)


# --- ISO calendar weeks ------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("day", "year", "week"),
    [
        (date(2026, 1, 1), 2026, 1),
        (date(2025, 12, 29), 2026, 1),
        (date(2026, 12, 31), 2026, 53),
        (date(2027, 1, 3), 2026, 53),
        (date(2027, 1, 4), 2027, 1),
        (date(2021, 1, 3), 2020, 53),
        (date(2024, 12, 30), 2025, 1),
    ],
)
def test_iso_week_of_a_day(day: date, year: int, week: int) -> None:
    assert IsoWeek.of(day) == IsoWeek(year, week)


def test_weeks_per_iso_year_and_validation() -> None:
    assert IsoWeek(2026, 53).label == "2026-W53"
    for year, week in ((2025, 53), (2026, 0), (2026, 54)):
        with pytest.raises(ValueError):
            IsoWeek(year, week)


def test_weeks_cross_year_boundaries() -> None:
    assert IsoWeek(2026, 1).monday == date(2025, 12, 29)
    assert IsoWeek(2026, 1).label == "2026-W01"


def test_a_cohort_code_is_not_an_iso_week() -> None:
    # S39 of the handoff starts on 28 September 2026, which is in ISO week 40.
    assert IsoWeek.of(COHORT_DAY) == IsoWeek(2026, 40)


def test_history_and_export_read_the_same_labels() -> None:
    assert spec.TRACKING_STATUS is STATE_LABELS
    assert history.STAGES["disqualified"] == "Défaillant"
    assert history.STAGES["r1"] == "R1 (ancien)"
    assert history.STAGES["follow_up_1"] == "Relance 1 (ancien)"
    assert set(history.STAGES) == {code.value for code in H}
