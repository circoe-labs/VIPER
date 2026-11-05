"""Data-quality score rules (`app.services.prospect_data_quality`): pure computation and config."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest

from app.core.config import Settings
from app.models.enums import ActivityStatus, OriginType, PhoneType, VerificationStatus
from app.models.prospects import Email, Phone, Prospect
from app.services.prospect_data_quality import (
    DataQualityConfig,
    band_of,
    data_quality_of,
)
from app.services.prospect_score import ScoreBand

NOW = datetime(2026, 10, 27, 9, 0, tzinfo=UTC)
CONFIG = DataQualityConfig(stale_days=180)


def email(
    status: VerificationStatus = VerificationStatus.VERIFIED,
    *,
    primary: bool = True,
    active: bool = True,
) -> Email:
    return Email(
        address="a@b.fr",
        is_primary=primary,
        is_active=active,
        verification_status=status,
        origin_type=OriginType.MANUAL,
    )


def phone(
    status: VerificationStatus = VerificationStatus.VERIFIED, *, active: bool = True
) -> Phone:
    return Phone(
        number="0102030405",
        type=PhoneType.MOBILE,
        is_primary=False,
        is_active=active,
        verification_status=status,
        origin_type=OriginType.MANUAL,
    )


def prospect(**overrides: object) -> Prospect:
    fields: dict[str, object] = {
        "first_name": "Ada",
        "last_name": "Lovelace",
        "company_id": uuid.uuid4(),
        "role_id": uuid.uuid4(),
        "exact_job_title": "Directrice financière",
        "activity_status": ActivityStatus.ACTIVE,
        "employment_verified_at": NOW - timedelta(days=10),
        "emails": [email()],
        "phones": [phone()],
    }
    fields.update(overrides)
    return Prospect(**fields)


def points(score_prospect: Prospect, criterion: str, config: DataQualityConfig = CONFIG) -> int:
    score = data_quality_of(score_prospect, NOW, config)
    return next(item.points for item in score.criteria if item.id == criterion)


def test_a_complete_verified_record_scores_100_and_is_green() -> None:
    score = data_quality_of(prospect(), NOW, CONFIG)

    assert (score.total, score.band) == (100, ScoreBand.GREEN)
    assert score.summary == "Fiche complète et vérifiée."
    assert sum(item.max_points for item in score.criteria) == 100


def test_an_empty_record_scores_zero_and_is_red() -> None:
    bare = prospect(
        company_id=None,
        role_id=None,
        exact_job_title=None,
        activity_status=ActivityStatus.UNKNOWN,
        employment_verified_at=None,
        emails=[],
        phones=[],
    )

    score = data_quality_of(bare, NOW, CONFIG)

    assert (score.total, score.band) == (0, ScoreBand.RED)
    assert score.summary.startswith("À compléter : e-mail actif, e-mail vérifié, téléphone")
    assert score.summary.endswith("et 6 autres.")


def test_unverified_and_invalid_emails_do_not_count_as_verified() -> None:
    for status in (VerificationStatus.UNVERIFIED, VerificationStatus.INVALID):
        record = prospect(emails=[email(status)])
        assert points(record, "email_active") == 20
        assert points(record, "email_verified") == 0


def test_an_inactive_email_does_not_count() -> None:
    record = prospect(emails=[email(active=False, primary=False)])

    assert (points(record, "email_active"), points(record, "email_verified")) == (0, 0)


def test_the_primary_email_is_the_one_checked() -> None:
    record = prospect(
        emails=[
            email(VerificationStatus.UNVERIFIED, primary=True),
            Email(
                address="c@d.fr",
                is_primary=False,
                is_active=True,
                verification_status=VerificationStatus.VERIFIED,
                origin_type=OriginType.MANUAL,
            ),
        ]
    )

    assert points(record, "email_verified") == 0


def test_phone_points_follow_activity_and_verification() -> None:
    assert (
        points(prospect(phones=[phone()]), "phone_active"),
        points(prospect(phones=[phone()]), "phone_verified"),
    ) == (10, 5)
    unverified = prospect(phones=[phone(VerificationStatus.UNVERIFIED)])
    assert (points(unverified, "phone_active"), points(unverified, "phone_verified")) == (10, 0)
    inactive = prospect(phones=[phone(active=False)])
    assert (points(inactive, "phone_active"), points(inactive, "phone_verified")) == (0, 0)


def test_employment_is_partial_when_stale_and_never_stale_without_a_threshold() -> None:
    old = prospect(employment_verified_at=NOW - timedelta(days=400))

    assert points(old, "employment") == 8
    assert points(old, "employment", DataQualityConfig(stale_days=None)) == 15
    assert points(prospect(employment_verified_at=None), "employment") == 0


def test_blank_job_title_and_unknown_activity_are_missing() -> None:
    record = prospect(exact_job_title="   ", activity_status=ActivityStatus.UNKNOWN)

    assert (points(record, "job_title"), points(record, "activity")) == (0, 0)


@pytest.mark.parametrize(
    ("total", "band"),
    [(49, ScoreBand.RED), (50, ScoreBand.YELLOW), (79, ScoreBand.YELLOW), (80, ScoreBand.GREEN)],
)
def test_band_thresholds(total: int, band: ScoreBand) -> None:
    assert band_of(total, DataQualityConfig()) == band


def test_thresholds_come_from_settings_and_must_be_ordered() -> None:
    config = DataQualityConfig.from_settings(
        Settings(
            _env_file=None, prospect_data_score_red_below=30, prospect_data_score_green_from=60
        )
    )
    assert (config.red_below, config.green_from) == (30, 60)

    with pytest.raises(ValueError, match="DATA_SCORE_RED_BELOW"):
        Settings(
            _env_file=None, prospect_data_score_red_below=80, prospect_data_score_green_from=80
        )
