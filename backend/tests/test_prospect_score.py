"""Score contract and rules (`app.services.prospect_score`): pure computation and config."""

import uuid
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.models.prospects import ProspectNote
from app.services.prospect_score import (
    ProspectScore,
    ScoreBand,
    ScoreConfig,
    ScoreContribution,
    band_of,
    build_score,
    contribution_of,
    score_from_notes,
)

CONFIG = ScoreConfig()
NOW = datetime(2026, 10, 3, 9, 0, tzinfo=UTC)


def line(delta: int, reason: str = "fait") -> ScoreContribution:
    return ScoreContribution(id=str(uuid.uuid4()), delta=delta, reason=reason)


def note(delta: int | None, fact: str = "a liké un post") -> ProspectNote:
    return ProspectNote(
        id=uuid.uuid4(), prospect_id=uuid.uuid4(), fact_text=fact, score_delta=delta, created_at=NOW
    )


def test_no_contribution_gives_the_base_with_a_factual_summary() -> None:
    score = build_score([], CONFIG)

    assert (score.total, score.band, score.contributions) == (50, ScoreBand.YELLOW, [])
    assert score.summary == "Aucun signal enregistré : score de départ."


def test_positive_and_negative_contributions_are_summed_and_explained() -> None:
    lines = [line(5, "a liké un post"), line(10, "très bon interlocuteur"), line(-8)]

    score = build_score(lines, CONFIG)

    assert score.total == 57
    assert [item.delta for item in score.contributions] == [5, 10, -8]
    assert score.summary == "3 signaux (2 favorables, 1 défavorable), bilan +7."


def test_total_is_clamped_to_both_ends_and_deltas_are_kept_as_entered() -> None:
    low = build_score([line(-50), line(-50)], CONFIG)
    high = build_score([line(50), line(50)], CONFIG)

    assert (low.total, low.band) == (0, ScoreBand.RED)
    assert (high.total, high.band) == (100, ScoreBand.GREEN)
    assert [item.delta for item in high.contributions] == [50, 50]


def test_the_exact_bounds_are_reachable() -> None:
    assert build_score([line(-50)], ScoreConfig(base=50)).total == 0
    assert build_score([line(50)], ScoreConfig(base=50)).total == 100


@pytest.mark.parametrize(
    ("total", "band"),
    [
        (0, ScoreBand.RED),
        (39, ScoreBand.RED),
        (40, ScoreBand.YELLOW),
        (69, ScoreBand.YELLOW),
        (70, ScoreBand.GREEN),
        (100, ScoreBand.GREEN),
    ],
)
def test_default_band_thresholds(total: int, band: ScoreBand) -> None:
    assert band_of(total, CONFIG) is band


def test_thresholds_and_base_come_from_the_configuration() -> None:
    config = ScoreConfig(base=20, red_below=10, green_from=30)

    assert build_score([], config).band is ScoreBand.YELLOW
    assert build_score([line(15)], config).band is ScoreBand.GREEN
    assert build_score([line(-15)], config).band is ScoreBand.RED


def test_settings_feed_the_score_configuration_and_refuse_inverted_bands() -> None:
    settings = Settings(
        _env_file=None,
        prospect_score_base=60,
        prospect_score_red_below=30,
        prospect_score_green_from=80,
    )

    assert ScoreConfig.from_settings(settings) == ScoreConfig(60, 30, 80)
    with pytest.raises(ValidationError, match="RED_BELOW"):
        Settings(_env_file=None, prospect_score_red_below=70, prospect_score_green_from=70)


def test_a_note_without_delta_is_not_a_contribution() -> None:
    assert contribution_of(note(None)) is None
    assert score_from_notes([note(None)], CONFIG).total == 50


def test_a_scored_note_becomes_a_traceable_manual_contribution() -> None:
    scored = note(5)

    [item] = score_from_notes([scored], CONFIG).contributions

    assert (item.delta, item.reason, item.origin) == (5, "a liké un post", "manual")
    assert (item.source_type, item.source_ref) == ("note", str(scored.id))
    assert item.created_at == NOW


def test_source_ref_is_optional_and_the_contract_round_trips() -> None:
    score = build_score([line(3)], CONFIG)

    dumped = score.model_dump(mode="json")

    assert dumped["contributions"][0]["source_ref"] is None
    assert dumped["contributions"][0]["source_type"] is None
    assert set(dumped) == {"total", "summary", "band", "contributions"}
    assert ProspectScore.model_validate(dumped) == score


@pytest.mark.parametrize("total", [-1, 101])
def test_the_contract_refuses_a_total_outside_0_100(total: int) -> None:
    with pytest.raises(ValidationError):
        ProspectScore(total=total, summary="", band=ScoreBand.RED)
