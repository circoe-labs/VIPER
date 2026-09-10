"""Sheet recognition, header matching, `A contacter` disambiguation, notices and user overrides."""

import pytest

from app.services.imports.diagnostics import Diagnostic, DiagnosticCode, ImportRejectedError
from app.services.imports.fields import LEGACY_LAYOUT, ImportField
from app.services.imports.layout import ImportMapping, Layout, MatchedBy, resolve_layout
from app.services.imports.workbook import ImportLimits, read_workbook
from tests.fixtures.synthetic.legacy_workbook import HEADERS, NEWS_ROWS, legacy_xlsx

LIMITS = ImportLimits()
ROW = {"company": "Transports Exemple SARL", "last_name": "Test", "first_name": "Jean"}


def layout_of(
    content: bytes, filename: str = "base.xlsx", mapping: ImportMapping | None = None
) -> Layout:
    return resolve_layout(read_workbook(filename, content, LIMITS), mapping)


def codes(notices: tuple[Diagnostic, ...]) -> list[DiagnosticCode]:
    return [notice.code for notice in notices]


def test_legacy_layout_maps_all_24_columns() -> None:
    layout = layout_of(legacy_xlsx([ROW]))

    assert layout.sheet is not None and layout.sheet.name == "Base client "
    assert layout.header is not None and layout.header.number == 1
    fields = [column.field for column in layout.columns]
    assert fields == [spec.field for spec in LEGACY_LAYOUT] + [None]
    assert [c.column for c in layout.columns][:3] == ["A", "B", "C"]
    assert layout.columns[1].matched_by is MatchedBy.HEADER
    assert layout.columns[22].field is ImportField.LEGACY_TO_CONTACT_FLAG
    assert layout.columns[22].matched_by is MatchedBy.POSITION
    assert layout.columns[23].header is None


def test_other_sheets_get_an_explicit_skip_notice() -> None:
    layout = layout_of(legacy_xlsx([ROW]))

    skipped = [n for n in layout.notices if n.code is DiagnosticCode.SHEET_SKIPPED]
    assert len(skipped) == 1
    assert skipped[0].message == (
        "Feuille « actualité » ignorée : elle ne fait pas partie du modèle d'import des prospects."
    )
    assert codes(layout.notices) == [
        DiagnosticCode.SHEET_SKIPPED,
        DiagnosticCode.COLUMN_LEGACY_PRESERVED,  # Mode de contact
        DiagnosticCode.COLUMN_LEGACY_PRESERVED,  # second A contacter
        DiagnosticCode.COLUMN_UNNAMED,
    ]


def test_prospect_sheet_is_found_by_fingerprint_whatever_its_name_and_position() -> None:
    content = legacy_xlsx(
        [ROW],
        sheet="Feuil2",
        extra_sheets={"Notes": NEWS_ROWS, "Autres": [("Entreprise", "Commentaire")]},
    )

    layout = layout_of(content)

    assert layout.sheet is not None and layout.sheet.name == "Feuil2"
    assert codes(layout.notices).count(DiagnosticCode.SHEET_SKIPPED) == 2


def test_header_row_can_follow_title_rows() -> None:
    layout = layout_of(legacy_xlsx([ROW], blank_rows_before=3))

    assert layout.header is not None and layout.header.number == 4


@pytest.mark.parametrize(
    ("header", "field"),
    [
        ("ENTREPRISE", ImportField.COMPANY_NAME),
        (" Société ", ImportField.COMPANY_NAME),
        ("E-mail", ImportField.EMAIL),
        ("Courriel", ImportField.EMAIL),
        ("Prenom", ImportField.FIRST_NAME),
        ("CIVILITE", ImportField.CIVILITY),
        ("Rendez-vous obtenu", ImportField.STAGE_APPOINTMENT),
        ("Portable", ImportField.MOBILE),
        ("références CIRCOE", ImportField.CIRCOE_REFERENCES),
        ("liste des fiches projets références circoe.csv", ImportField.CIRCOE_REFERENCES),
    ],
)
def test_headers_are_compared_without_case_accents_or_punctuation(
    header: str, field: ImportField
) -> None:
    layout = layout_of(f"Nom;Téléphone;{header}\nTest;0100000001;x\n".encode(), "export.csv")

    assert layout.columns[2].field is field


def test_unknown_duplicate_and_unnamed_columns_are_reported_and_left_unmapped() -> None:
    content = (
        "Entreprise;Nom;Mail;Commentaire;Mail;;Prénom\nA;B;c@example.com;x;d@example.com;y;E\n"
    )

    layout = layout_of(content.encode(), "export.csv")

    assert [c.field for c in layout.columns] == [
        ImportField.COMPANY_NAME,
        ImportField.LAST_NAME,
        ImportField.EMAIL,
        None,
        None,
        None,
        ImportField.FIRST_NAME,
    ]
    notices = {n.code: n for n in layout.notices if n.column}
    assert notices[DiagnosticCode.COLUMN_UNMAPPED].column == "D"
    assert "« Commentaire »" in notices[DiagnosticCode.COLUMN_UNMAPPED].message
    assert notices[DiagnosticCode.COLUMN_DUPLICATE_HEADER].column == "E"
    assert notices[DiagnosticCode.COLUMN_UNNAMED].column == "F"


def test_missing_columns_are_noticed_key_ones_as_warnings() -> None:
    layout = layout_of(b"Entreprise;Nom;Mail\nA;B;c@example.com\n", "export.csv")

    missing = {n.field: n.code for n in layout.notices if n.field and n.column is None}
    assert missing[ImportField.FIRST_NAME] is DiagnosticCode.COLUMN_MISSING_KEY
    assert missing[ImportField.REFERENT] is DiagnosticCode.COLUMN_MISSING
    assert len(missing) == len(LEGACY_LAYOUT) - 3


def test_no_recognisable_sheet() -> None:
    content = legacy_xlsx([], headers=["Date", "Titre"], extra_sheets={"actualité": NEWS_ROWS})

    layout = layout_of(content)

    assert layout.sheet is None and layout.columns == ()
    assert codes(layout.notices) == [
        DiagnosticCode.SHEET_NOT_FOUND,
        DiagnosticCode.SHEET_SKIPPED,
        DiagnosticCode.SHEET_SKIPPED,
    ]


def test_user_overrides_remap_and_unmap_columns() -> None:
    content = legacy_xlsx([ROW])
    mapping = ImportMapping(
        columns={"X": ImportField.REFERENT, "I": None, "O": ImportField.JOB_TITLE}
    )

    layout = layout_of(content, mapping=mapping)

    by_letter = {c.column: c for c in layout.columns}
    assert by_letter["X"].field is ImportField.REFERENT
    assert by_letter["X"].matched_by is MatchedBy.OVERRIDE
    assert by_letter["A"].field is None  # its field moved to X
    assert by_letter["I"].field is None and by_letter["I"].matched_by is MatchedBy.OVERRIDE
    assert by_letter["O"].field is ImportField.JOB_TITLE
    assert by_letter["N"].field is None
    missing = {n.field for n in layout.notices if n.code is DiagnosticCode.COLUMN_MISSING_KEY}
    assert missing == {ImportField.EMAIL}


def test_user_can_force_a_sheet_and_header_row() -> None:
    content = legacy_xlsx([ROW], extra_sheets={"Autre": [("Titre",), ("Entreprise", "Nom")]})

    layout = layout_of(content, mapping=ImportMapping(sheet="Autre", header_row=2))

    assert layout.sheet is not None and layout.sheet.name == "Autre"
    assert layout.header is not None and layout.header.number == 2
    assert [c.field for c in layout.columns] == [ImportField.COMPANY_NAME, ImportField.LAST_NAME]
    assert codes(layout.notices).count(DiagnosticCode.SHEET_SKIPPED) == 1


def test_forced_sheet_without_known_headers_uses_its_first_row() -> None:
    content = legacy_xlsx([ROW], extra_sheets={"Libre": [("Colonne 1", "Colonne 2"), ("a", "b")]})

    layout = layout_of(content, mapping=ImportMapping(sheet="Libre"))

    assert layout.header is not None and layout.header.number == 1
    assert [c.field for c in layout.columns] == [None, None]


@pytest.mark.parametrize(
    ("mapping", "code"),
    [
        (ImportMapping(sheet="Inconnue"), DiagnosticCode.MAPPING_UNKNOWN_SHEET),
        (ImportMapping(header_row=99), DiagnosticCode.MAPPING_INVALID_HEADER_ROW),
        (ImportMapping(columns={"ZZ": ImportField.EMAIL}), DiagnosticCode.MAPPING_UNKNOWN_COLUMN),
        (
            ImportMapping(columns={"A": ImportField.EMAIL, "B": ImportField.EMAIL}),
            DiagnosticCode.MAPPING_DUPLICATE_FIELD,
        ),
    ],
)
def test_invalid_overrides_are_rejected(mapping: ImportMapping, code: DiagnosticCode) -> None:
    with pytest.raises(ImportRejectedError) as caught:
        layout_of(legacy_xlsx([ROW]), mapping=mapping)

    assert caught.value.code is code


def test_historical_headers_are_the_documented_ones() -> None:
    assert [spec.header for spec in LEGACY_LAYOUT] == list(HEADERS[:23])
