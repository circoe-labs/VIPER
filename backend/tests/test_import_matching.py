"""Matching against reference data: roles, categories, segments, referents; company key."""

import pytest

from app.services.imports.diagnostics import DiagnosticCode as Code
from app.services.imports.matching import (
    company_key,
    match_categories,
    match_referent,
    match_role,
)
from app.services.imports.models import MatchKind
from tests.fixtures.synthetic.legacy_workbook import ID, REFERENCE

ROLES = REFERENCE.roles
CATEGORIES = REFERENCE.activity_categories
SEGMENTS = REFERENCE.commercial_segments
REFERENTS = REFERENCE.referents


def test_role_exact_match_needs_no_confirmation() -> None:
    for title in ("Responsable transport", "RESPONSABLE TRANSPORT", "responsable-transport"):
        matches, codes = match_role(title, ROLES)

        assert [(m.id, m.match, m.requires_confirmation) for m in matches] == [
            (ID["role-transport"], MatchKind.EXACT, False)
        ]
        assert codes == ()


def test_role_suggestions_are_ranked_and_need_confirmation() -> None:
    matches, codes = match_role("Responsable transport et logistique", ROLES)
    similar, _ = match_role("Responsable transports", ROLES)

    assert [(m.label, m.match, m.requires_confirmation) for m in matches] == [
        ("Responsable transport", MatchKind.CONTAINS, True)
    ]
    assert codes == (Code.ROLE_SUGGESTED,)
    assert similar[0].match is MatchKind.SIMILAR and similar[0].score >= 0.8


def test_unknown_title_is_never_turned_into_a_role() -> None:
    assert match_role("Directeur des opérations fictives", ROLES) == ([], (Code.ROLE_UNMATCHED,))


def test_deactivated_role_is_reported_instead_of_duplicated() -> None:
    matches, codes = match_role("Chef de quai", ROLES)

    assert [(m.id, m.match) for m in matches] == [(ID["role-old"], MatchKind.INACTIVE)]
    assert codes == (Code.ROLE_INACTIVE_MATCH,)


def test_category_whole_cell_with_numeric_prefix() -> None:
    outcome = match_categories("1. Entreposage et stockage", CATEGORIES, SEGMENTS)

    assert [m.id for m in outcome.matches] == [ID["category-storage"]]
    assert outcome.codes == () and not outcome.keep_raw


def test_ampersand_and_et_never_split_a_category() -> None:
    outcome = match_categories("2. Logistique & Stockage", CATEGORIES, SEGMENTS)

    assert outcome.unmatched == ("Logistique & Stockage",)
    assert outcome.codes == (Code.CATEGORY_UNMATCHED,)
    assert outcome.keep_raw


def test_several_categories_in_one_cell() -> None:
    outcome = match_categories(
        "Transport routier de marchandises / Entreposage et stockage ; Transporteur ; Non",
        CATEGORIES,
        SEGMENTS,
    )

    assert [m.id for m in outcome.matches] == [ID["category-road"], ID["category-storage"]]
    assert outcome.segment is not None and outcome.segment.id == ID["segment-carrier"]
    assert outcome.segment.requires_confirmation
    assert outcome.codes == (Code.CATEGORY_SEGMENT_SUGGESTED, Code.CATEGORY_INVALID)
    assert outcome.keep_raw


@pytest.mark.parametrize("raw", ["Non", "OUI", "xxx", "?", "0", 12, "N/A"])
def test_non_category_values_are_invalid(raw: object) -> None:
    outcome = match_categories(raw, CATEGORIES, SEGMENTS)  # type: ignore[arg-type]

    assert outcome.matches == () and outcome.unmatched == ()
    assert outcome.codes == (Code.CATEGORY_INVALID,)
    assert outcome.keep_raw


def test_category_suggestion_and_inactive_match() -> None:
    suggested = match_categories("Transports routiers de marchandises", CATEGORIES, SEGMENTS)
    inactive = match_categories("Déménagement", CATEGORIES, SEGMENTS)

    assert suggested.matches[0].match is MatchKind.SIMILAR
    assert suggested.codes == (Code.CATEGORY_SUGGESTED,)
    assert inactive.matches[0].match is MatchKind.INACTIVE
    assert inactive.codes == (Code.CATEGORY_INACTIVE_MATCH,)


@pytest.mark.parametrize("raw", ["Claire Référente", "REFERENTE Claire", "claire referente"])
def test_known_referent_full_name(raw: str) -> None:
    outcome = match_referent(raw, REFERENTS)

    assert outcome.match is not None and outcome.match.id == ID["referent-claire"]
    assert outcome.match.match is MatchKind.EXACT and not outcome.match.requires_confirmation
    assert outcome.codes == () and not outcome.keep_raw


@pytest.mark.parametrize("raw", ["Paul", "Démo", "P. Démo"])
def test_partial_referent_needs_confirmation(raw: str) -> None:
    outcome = match_referent(raw, REFERENTS)

    assert outcome.match is not None and outcome.match.id == ID["referent-paul"]
    assert outcome.match.requires_confirmation
    assert outcome.codes == (Code.REFERENT_PARTIAL_MATCH,)
    assert outcome.keep_raw


def test_ambiguous_and_inactive_referents() -> None:
    twins = (*REFERENTS, REFERENTS[1].__class__(ID["referent-former"], "Paul", "Autre"))

    ambiguous = match_referent("Paul", twins)
    inactive = match_referent("Hugo Ancien", REFERENTS)

    assert ambiguous.match is None and len(ambiguous.suggestions) == 2
    assert ambiguous.codes == (Code.REFERENT_AMBIGUOUS,)
    assert inactive.match is not None and inactive.match.match is MatchKind.INACTIVE
    assert inactive.codes == (Code.REFERENT_INACTIVE,)


@pytest.mark.parametrize(
    ("raw", "code"),
    [
        ("v", Code.REFERENT_MARKER),
        ("V", Code.REFERENT_MARKER),
        ("xxx", Code.REFERENT_MARKER),
        ("?", Code.REFERENT_MARKER),
        ("??", Code.REFERENT_MARKER),
        ("claire.referente@example.com", Code.REFERENT_EMAIL_LIKE),
        ("S37", Code.REFERENT_WEEK_MARKER),
        ("RDV pris le 12/03", Code.REFERENT_NOTE),
        ("Dupont -> Test", Code.REFERENT_NOTE),
        ("rappeler lundi", Code.REFERENT_NOTE),
        ("Inconnu Fictif", Code.REFERENT_UNKNOWN),
    ],
)
def test_garbage_never_becomes_a_referent(raw: str, code: Code) -> None:
    outcome = match_referent(raw, REFERENTS)

    assert outcome.match is None and outcome.suggestions == ()
    assert outcome.codes == (code,)
    assert outcome.keep_raw


def test_even_a_referent_email_is_not_a_referent() -> None:
    assert match_referent("claire.referente@example.com", REFERENTS).match is None


def test_departure_note_in_referent_suggests_inactive() -> None:
    outcome = match_referent("parti à la retraite", REFERENTS)

    assert outcome.codes == (Code.REFERENT_NOTE,)
    assert outcome.suggests_inactive


@pytest.mark.parametrize(
    "name",
    [
        "Transports Exemple SARL",
        "TRANSPORTS EXEMPLE",
        "Transports Exemple S.A.R.L.",
        "Sté Transports  Exemple",
        "transports-exemple sas",
    ],
)
def test_company_key_ignores_legal_forms_case_and_punctuation(name: str) -> None:
    assert company_key(name) == "transports exemple"


def test_company_key_details() -> None:
    assert company_key("Exemple & Fils") == company_key("Exemple et Fils")
    assert company_key("SARL") == "sarl"
    assert company_key("Fret Modèle") != company_key("Fret Modèles Associés")
