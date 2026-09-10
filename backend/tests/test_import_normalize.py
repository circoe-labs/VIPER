"""Pure normalizers: civility, names, emails, phones, planned-contact week, stages, address."""

from datetime import date, datetime

import pytest

from app.models.enums import Civility, PhoneType
from app.services.imports.diagnostics import DiagnosticCode as Code
from app.services.imports.normalize import (
    Address,
    PlannedContact,
    StageState,
    is_zero_placeholder,
    normalize_civility,
    normalize_name,
    parse_address,
    parse_emails,
    parse_phones,
    parse_planned_contact,
    read_stage,
)
from app.services.imports.text import CellValue, fold, json_value, multi_line, render, single_line


def test_fold_ignores_case_accents_punctuation_and_ligatures() -> None:
    assert (
        fold("  Projet déjà réalisé avec l'entreprise ") == "projet deja realise avec l entreprise"
    )
    assert fold("Liste des fiches projets_references_CIRCOE.csv") == (
        "liste des fiches projets references circoe csv"
    )
    assert fold("Cœur") == "coeur"
    assert fold("?") == ""


def test_cell_rendering() -> None:
    assert render(612345678.0) == "612345678"
    assert render(datetime(2026, 9, 14)) == "2026-09-14"
    assert render(datetime(2026, 9, 14, 8, 30)) == "2026-09-14T08:30:00"
    assert render(True) == "VRAI"
    assert single_line("  Jean \n  Pierre ") == "Jean Pierre"
    assert single_line("   ") is None
    assert multi_line(" 12 rue  Fictive \n\n 69000  Lyon ") == "12 rue Fictive\n69000 Lyon"
    assert json_value(date(2026, 9, 14)) == "2026-09-14"
    assert json_value(0) == 0


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("M.", Civility.MR),
        ("M", Civility.MR),
        ("MR", Civility.MR),
        ("Mr.", Civility.MR),
        (" monsieur ", Civility.MR),
        ("MME", Civility.MS),
        ("MME.", Civility.MS),
        ("Mme", Civility.MS),
        ("Madame", Civility.MS),
        ("Mlle", Civility.MS),
    ],
)
def test_civility_variants(raw: str, expected: Civility) -> None:
    outcome = normalize_civility(raw)

    assert outcome.value is expected
    assert outcome.codes == () and not outcome.keep_raw


@pytest.mark.parametrize("raw", [0, "0", 0.0, "Dr", "M. et Mme", "x", True])
def test_invalid_civility_is_flagged_and_kept_raw(raw: CellValue) -> None:
    outcome = normalize_civility(raw)

    assert outcome.value is None
    assert outcome.codes == (Code.CIVILITY_INVALID,)
    assert outcome.keep_raw


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("TEST", "Test"),
        ("jean-pierre", "Jean-Pierre"),
        ("  Marie   Claire ", "Marie Claire"),
        ("DE LA TOUR", "De la Tour"),
        ("JEAN DE LA FONTAINE", "Jean de la Fontaine"),
        ("MARIE D'ARC", "Marie d'Arc"),
        ("D'ARTAGNAN", "D'Artagnan"),
        ("VAN DER BERG", "Van der Berg"),
        ("McExemple", "McExemple"),  # mixed case is the author's choice
        ("de Villiers-Test", "de Villiers-Test"),
        ("123", "123"),
    ],
)
def test_names_are_trimmed_and_capitalised_without_losing_particles(
    raw: str, expected: str
) -> None:
    assert normalize_name(raw) == expected


def test_emails_are_normalized_and_split() -> None:
    outcome = parse_emails(" Jean.Test@Example.COM ; mailto:j.test@example.com / <jt@example.fr>")

    assert outcome.value == ("jean.test@example.com", "j.test@example.com", "jt@example.fr")
    assert outcome.codes == (Code.EMAIL_MULTIPLE_IN_CELL,)
    assert not outcome.keep_raw


@pytest.mark.parametrize(
    "raw", ["jean.test@", "jean test", "a@b", "jean..test@example.com", "@x.fr"]
)
def test_invalid_emails_are_flagged_and_kept_raw(raw: str) -> None:
    outcome = parse_emails(raw)

    assert Code.EMAIL_INVALID in outcome.codes
    assert outcome.keep_raw


def test_valid_addresses_survive_an_invalid_neighbour() -> None:
    outcome = parse_emails("paul.essai@example.com / paul@example fr")

    assert outcome.value == ("paul.essai@example.com",)
    assert outcome.codes == (Code.EMAIL_INVALID,)
    assert outcome.keep_raw


@pytest.mark.parametrize(
    ("raw", "number", "kind"),
    [
        ("06 00 00 00 01", "+33600000001", PhoneType.MOBILE),
        ("06.00.00.00.01 ", "+33600000001", PhoneType.MOBILE),
        ("07-00-00-00-01", "+33700000001", PhoneType.MOBILE),
        ("01 00 00 00 01", "+33100000001", PhoneType.LANDLINE),
        ("09 00 00 00 01", "+33900000001", PhoneType.LANDLINE),
        ("08 00 00 00 01", "+33800000001", PhoneType.OTHER),
        ("+33 (0)6 00 00 00 01", "+33600000001", PhoneType.MOBILE),
        ("+33 6 00 00 00 01", "+33600000001", PhoneType.MOBILE),
        ("0033 6 00 00 00 01", "+33600000001", PhoneType.MOBILE),
        ("+32 2 000 00 00", "+3220000000", PhoneType.OTHER),
    ],
)
def test_phone_formats(raw: str, number: str, kind: PhoneType) -> None:
    outcome = parse_phones(raw, mobile_column=False)

    assert [(p.number, p.type) for p in outcome.value or ()] == [(number, kind)]
    assert outcome.codes == ()


def test_phone_type_falls_back_to_the_column_for_foreign_numbers() -> None:
    (phone,) = parse_phones("+44 7000 000000", mobile_column=True).value or ()

    assert phone.type is PhoneType.MOBILE


def test_number_typed_phone_gets_its_leading_zero_back_flagged() -> None:
    outcome = parse_phones(600000004, mobile_column=True)

    assert [p.number for p in outcome.value or ()] == ["+33600000004"]
    assert outcome.codes == (Code.PHONE_LEADING_ZERO_RESTORED,)


def test_multiple_phones_in_a_cell() -> None:
    outcome = parse_phones("06 00 00 00 02 / 01 00 00 00 03 ou 06 00 00 00 02", mobile_column=False)

    assert [p.number for p in outcome.value or ()] == ["+33600000002", "+33100000003"]
    assert outcome.codes == (Code.PHONE_MULTIPLE_IN_CELL,)


@pytest.mark.parametrize("raw", ["01 00 00", "06 00 00 00 01 poste 12", "+33 6 00", "n/c", "0"])
def test_invalid_phones_are_flagged_and_kept_raw(raw: CellValue) -> None:
    outcome = parse_phones(raw, mobile_column=False)

    assert outcome.codes[0] is Code.PHONE_INVALID
    assert outcome.keep_raw


def test_digits_without_national_prefix_are_kept_but_flagged() -> None:
    outcome = parse_phones("123456", mobile_column=False)

    assert [p.number for p in outcome.value or ()] == ["123456"]
    assert outcome.codes == (Code.PHONE_UNRECOGNIZED_FORMAT,)


@pytest.mark.parametrize(("raw", "week"), [("S37", 37), ("s39", 39), ("S 37", 37), ("sem. 5", 5)])
def test_week_without_year_is_a_candidate_never_a_guessed_date(raw: str, week: int) -> None:
    outcome = parse_planned_contact(raw)

    assert outcome.value == PlannedContact(week=week)
    assert outcome.codes == (Code.PLANNED_CONTACT_WEEK_WITHOUT_YEAR,)
    assert outcome.keep_raw


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("S37 2026", PlannedContact(date(2026, 9, 7), 37, 2026)),
        ("S37/26", PlannedContact(date(2026, 9, 7), 37, 2026)),
        ("2026-W53", PlannedContact(date(2026, 12, 28), 53, 2026)),
        ("14/09/2026", PlannedContact(date(2026, 9, 14))),
        (datetime(2026, 9, 14, 10, 0), PlannedContact(date(2026, 9, 14))),
        (date(2026, 9, 14), PlannedContact(date(2026, 9, 14))),
    ],
)
def test_week_with_its_year_or_a_date_is_a_real_date(
    raw: CellValue, expected: PlannedContact
) -> None:
    outcome = parse_planned_contact(raw)

    assert outcome.value == expected
    assert outcome.codes == () and not outcome.keep_raw


@pytest.mark.parametrize("raw", ["S60", "S0", "2025-W53"])
def test_impossible_week(raw: str) -> None:
    outcome = parse_planned_contact(raw)

    assert outcome.value is None
    assert outcome.codes == (Code.PLANNED_CONTACT_INVALID_WEEK,)


@pytest.mark.parametrize(
    ("raw", "inactive"),
    [
        ("retraité", True),
        ("RETRAITEE", True),
        ("décédé", True),
        ("à voir", False),
        ("31/02/2026", False),
    ],
)
def test_other_planned_contact_values_are_not_weeks(raw: str, inactive: bool) -> None:
    outcome = parse_planned_contact(raw)

    assert outcome.value is None
    assert outcome.codes == (Code.PLANNED_CONTACT_NOT_A_WEEK,)
    assert outcome.keep_raw
    assert outcome.suggests_inactive is inactive


@pytest.mark.parametrize(
    ("raw", "state", "plain"),
    [
        ("oui", StageState.POSITIVE, True),
        ("X", StageState.POSITIVE, True),
        (True, StageState.POSITIVE, True),
        ("✓", StageState.POSITIVE, True),
        ("Oui le 12/03", StageState.POSITIVE, False),
        (3, StageState.POSITIVE, False),
        ("non", StageState.NEGATIVE, True),
        ("-", StageState.NEGATIVE, True),
        (0, StageState.NEGATIVE, True),
        (False, StageState.NEGATIVE, True),
        ("à rappeler", StageState.UNRECOGNIZED, False),
        ("?", StageState.UNRECOGNIZED, False),
    ],
)
def test_stage_readings(raw: CellValue, state: StageState, plain: bool) -> None:
    reading = read_stage(raw)

    assert (reading.state, reading.plain) == (state, plain)


def test_stage_dates_are_positive_with_their_date() -> None:
    assert read_stage(datetime(2026, 3, 12, 9, 0)).when == date(2026, 3, 12)
    assert read_stage("12/03/2026").when == date(2026, 3, 12)


def test_structured_address() -> None:
    outcome = parse_address("12 rue de l'Exemple\n69000 Lyon")

    assert outcome.value == Address("12 rue de l'Exemple", None, "69000", "Lyon")
    assert outcome.codes == ()
    assert parse_address("3 allée Fictive, 44000 NANTES, France").value == Address(
        "3 allée Fictive", None, "44000", "NANTES", "France"
    )


def test_unstructured_address_stays_free_text_and_raw() -> None:
    outcome = parse_address("Zone fictive\nBâtiment B")

    assert outcome.value == Address("Zone fictive", "Bâtiment B")
    assert outcome.codes == (Code.ADDRESS_UNSTRUCTURED,)
    assert outcome.keep_raw


def test_zero_placeholder() -> None:
    assert is_zero_placeholder(0) and is_zero_placeholder(0.0) and is_zero_placeholder(" 0 ")
    assert not is_zero_placeholder(False) and not is_zero_placeholder("0 projet")
