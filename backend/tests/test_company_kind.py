"""Suggestion of a company's kind (`app.services.company_kind`): pure rules."""

import pytest

from app.models.enums import CompanyKind
from app.services.company_kind import (
    kind_from_category,
    kind_from_size,
    suggest_company_kind,
)


@pytest.mark.parametrize(
    ("category", "expected"),
    [
        ("1. Secteur public & institutions", CompanyKind.INSTITUTIONAL),
        ("secteur PUBLIC", CompanyKind.INSTITUTIONAL),
        ("Collectivité territoriale", CompanyKind.INSTITUTIONAL),
        ("3. Industrie & production", None),
        ("2. Transport & logistique", None),
        ("", None),
        (None, None),
    ],
)
def test_category_suggests_institutional_only_for_the_public_sector(
    category: str | None, expected: CompanyKind | None
) -> None:
    assert kind_from_category(category) == expected


@pytest.mark.parametrize(
    ("size", "expected"),
    [
        ("12", CompanyKind.SME),
        ("50-249 salariés", CompanyKind.SME),
        ("10 à 49 salariés", CompanyKind.SME),
        ("250-499 salariés", CompanyKind.LARGE),
        ("5 000 salariés", CompanyKind.LARGE),
        ("5000+", CompanyKind.LARGE),
        ("plus de 1000", CompanyKind.LARGE),
        ("100-400 salariés", None),
        ("50+", None),
        ("grande", None),
        ("", None),
        (None, None),
    ],
)
def test_size_label_suggests_sme_below_250_and_large_from_250(
    size: str | None, expected: CompanyKind | None
) -> None:
    assert kind_from_size(size) == expected


def test_the_public_category_wins_over_the_headcount() -> None:
    assert (
        suggest_company_kind(category="1. Secteur public & institutions", size_label="5000+")
        == CompanyKind.INSTITUTIONAL
    )
    assert suggest_company_kind(category="3. Industrie", size_label="30") == CompanyKind.SME
    assert suggest_company_kind() is None
