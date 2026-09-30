"""Contact workflow contract (pure): states, labels, ISO weeks and the default cadence.

Ported from the reference `tests/contactWorkflow.test.ts` (handoff decisions 4-14).
"""

from datetime import date, datetime

import pytest

from app.core.business_time import BUSINESS_TIMEZONE
from app.models.enums import ContactTrackingStatus, TrackingHistoryStatus
from app.services import history
from app.services.contact_workflow import (
    DEFAULT_STATE,
    LEGACY_EQUIVALENTS,
    NEXT_ACTION_STATES,
    SEQUENCE_CLOSING_STATES,
    STATE_LABELS,
    TERMINAL_STATES,
    IsoWeek,
    history_codes,
    history_label,
    next_action_at,
    suggest_next_action,
    weeks_in_year,
)
from app.services.exports import spec

S = ContactTrackingStatus
H = TrackingHistoryStatus


def test_the_taxonomy_is_exactly_the_eight_states_in_display_order() -> None:
    assert [state.value for state in S] == [
        "neutral",
        "contacted",
        "r1",
        "r2",
        "response_received",
        "appointment_obtained",
        "failure",
        "ignored",
    ]
    assert DEFAULT_STATE is S.NEUTRAL
    assert STATE_LABELS == {
        S.NEUTRAL: "Aucun état",
        S.CONTACTED: "Contacté",
        S.R1: "R1",
        S.R2: "R2",
        S.RESPONSE_RECEIVED: "Réponse reçue",
        S.APPOINTMENT_OBTAINED: "RDV pris",
        S.FAILURE: "Failure",
        S.IGNORED: "Ignoré",
    }


def test_legacy_codes_are_history_only() -> None:
    legacy = {"to_contact", "follow_up_1", "follow_up_2", "quote_sent", "quote_follow_up", "won"}
    legacy |= {"not_interested"}
    assert {code.value for code in H} == {state.value for state in S} | legacy
    assert not legacy & {state.value for state in S}
    for code in legacy:
        with pytest.raises(ValueError):
            S(code)
    assert set(LEGACY_EQUIVALENTS) == {H(code) for code in legacy}


def test_history_labels_read_current_and_legacy_codes() -> None:
    assert history_label("r1") == "R1"
    assert history_label("neutral") == "Aucun état"
    assert history_label("follow_up_1") == "Relance 1 (ancien)"
    assert history_label("won") == "Gagné (ancien)"
    assert history_label(None) is None
    assert history_label("pending_review") is None


def test_history_codes_add_the_legacy_codes_of_the_same_meaning() -> None:
    assert set(history_codes((S.APPOINTMENT_OBTAINED,))) == {
        H.APPOINTMENT_OBTAINED,
        H.LEGACY_QUOTE_SENT,
        H.LEGACY_QUOTE_FOLLOW_UP,
        H.LEGACY_WON,
    }
    assert set(history_codes((S.R1, S.FAILURE))) == {
        H.R1,
        H.LEGACY_FOLLOW_UP_1,
        H.FAILURE,
        H.LEGACY_NOT_INTERESTED,
    }


def test_state_groups() -> None:
    assert NEXT_ACTION_STATES == (S.NEUTRAL, S.CONTACTED, S.R1, S.R2)
    assert SEQUENCE_CLOSING_STATES == (S.RESPONSE_RECEIVED, S.APPOINTMENT_OBTAINED, S.IGNORED)
    assert TERMINAL_STATES == (S.IGNORED,)


# --- ISO weeks ----------------------------------------------------------------------------------


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
    assert (weeks_in_year(2026), weeks_in_year(2025), weeks_in_year(2020)) == (53, 52, 53)
    assert IsoWeek(2026, 53).label == "2026-W53"
    for year, week in ((2025, 53), (2026, 0), (2026, 54)):
        with pytest.raises(ValueError):
            IsoWeek(year, week)


def test_weeks_cross_year_boundaries() -> None:
    assert IsoWeek(2025, 52).plus(1) == IsoWeek(2026, 1)
    assert IsoWeek(2026, 52).plus(1) == IsoWeek(2026, 53)
    assert IsoWeek(2026, 53).plus(1) == IsoWeek(2027, 1)
    assert IsoWeek(2026, 1).plus(-1) == IsoWeek(2025, 52)
    assert IsoWeek(2026, 1).monday == date(2025, 12, 29)
    assert IsoWeek(2025, 52) < IsoWeek(2026, 1)
    assert IsoWeek(2026, 1).label == "2026-W01"


def test_the_next_action_is_the_monday_at_business_midnight() -> None:
    at = next_action_at(IsoWeek(2026, 44))

    assert at == datetime(2026, 10, 26, tzinfo=BUSINESS_TIMEZONE)
    assert str(at.utcoffset()) == "1:00:00"  # CET again after the October change


# --- default cadence ----------------------------------------------------------------------------


def monday(year: int, week: int) -> date:
    return IsoWeek(year, week).monday


def test_contact_s40_r1_s42_r2_s44_review_s48() -> None:
    assert suggest_next_action(S.CONTACTED, monday(2026, 40)) == IsoWeek(2026, 42)
    assert suggest_next_action(S.R1, monday(2026, 42)) == IsoWeek(2026, 44)
    # Any day of the week gives the same suggestion (the week, not the day, counts).
    assert suggest_next_action(S.R2, date(2026, 11, 1)) == IsoWeek(2026, 48)


def test_the_cadence_crosses_week_52_and_53() -> None:
    assert suggest_next_action(S.CONTACTED, monday(2025, 51)) == IsoWeek(2026, 1)
    assert suggest_next_action(S.R1, monday(2025, 52)) == IsoWeek(2026, 2)
    assert suggest_next_action(S.R2, monday(2026, 52)) == IsoWeek(2027, 3)
    assert suggest_next_action(S.CONTACTED, monday(2026, 52)) == IsoWeek(2027, 1)
    assert suggest_next_action(S.CONTACTED, monday(2026, 51)) == IsoWeek(2026, 53)


@pytest.mark.parametrize(
    "state",
    [S.NEUTRAL, S.RESPONSE_RECEIVED, S.APPOINTMENT_OBTAINED, S.FAILURE, S.IGNORED],
)
def test_no_suggestion_outside_the_sequence(state: S) -> None:
    assert suggest_next_action(state, monday(2026, 40)) is None


def test_history_and_export_read_the_same_labels() -> None:
    assert spec.TRACKING_STATUS is STATE_LABELS
    assert history.STAGES["r1"] == "R1"
    assert history.STAGES["follow_up_1"] == "Relance 1 (ancien)"
    assert set(history.STAGES) == {code.value for code in H}
