"""End to end: synthetic legacy workbook → ImportPreview. Every legacy compatibility case of
`doc/process/testing-strategy.md`, determinism, no database access, losslessness."""

import ast
import csv
import dataclasses
import io
import json
import random
import socket
from datetime import date, datetime
from pathlib import Path
from typing import Any

import pytest

import app.services.imports as engine_package
from app.models.enums import Civility, ContactabilityStatus, ContactTrackingStatus, PhoneType
from app.services.imports.diagnostics import CATALOGUE, ImportRejectedError, Severity
from app.services.imports.diagnostics import DiagnosticCode as Code
from app.services.imports.fields import ImportField
from app.services.imports.layout import ImportMapping
from app.services.imports.models import (
    CandidateKind,
    ImportPreview,
    LegacyReason,
    MatchReason,
    PreviewRow,
)
from app.services.imports.normalize import StageState, parse_phones, read_stage
from app.services.imports.preview import ImportFile, build_preview
from app.services.imports.text import CellValue, is_blank, json_value
from app.services.imports.workbook import ImportLimits
from tests.fixtures.synthetic.legacy_workbook import (
    HEADERS,
    ID,
    KEYS,
    REFERENCE,
    SAMPLE_ROWS,
    legacy_values,
    legacy_xlsx,
)

LETTERS = {key: chr(ord("A") + index) for index, key in enumerate(KEYS)}


def sample_preview() -> ImportPreview:
    return build_preview(ImportFile("base_synthetique.xlsx", legacy_xlsx(SAMPLE_ROWS)), REFERENCE)


@pytest.fixture(scope="module")
def preview() -> ImportPreview:
    return sample_preview()


def row(preview: ImportPreview, number: int) -> PreviewRow:
    return next(r for r in preview.rows if r.row_number == number)


def codes(item: PreviewRow) -> set[Code]:
    return {diagnostic.code for diagnostic in item.diagnostics}


def test_summary(preview: ImportPreview) -> None:
    summary = preview.summary

    assert summary.sheet == "Base client " and summary.header_row == 1
    assert [(s.name, s.status.value) for s in summary.sheets] == [
        ("Base client ", "imported"),
        ("actualité", "skipped"),
    ]
    assert summary.rows_total == len(SAMPLE_ROWS) and summary.rows_empty == 0
    assert len(summary.columns) == 24
    everything = [*summary.notices, *(d for r in preview.rows for d in r.diagnostics)]
    assert sum(summary.counts_by_code.values()) == len(everything)
    assert sum(summary.counts_by_severity.values()) == len(everything)
    assert summary.rows_by_status == {"ok": 1, "warning": 7, "error": 2}
    assert summary.duplicate_email_groups == 1


def test_extra_sheet_is_skipped_with_an_explicit_notice(preview: ImportPreview) -> None:
    (notice,) = [n for n in preview.summary.notices if n.code is Code.SHEET_SKIPPED]

    assert "actualité" in notice.message and notice.severity is Severity.INFO


def test_civility_variants_and_the_zero_anomaly(preview: ImportPreview) -> None:
    civilities = {r.row_number: r.prospect.civility for r in preview.rows}

    assert [civilities[n] for n in (2, 3, 4, 5, 6, 7)] == [
        Civility.MR,
        Civility.MR,
        Civility.MS,
        None,
        Civility.MS,
        Civility.MR,
    ]
    zero = row(preview, 5)
    assert Code.CIVILITY_INVALID in codes(zero)
    assert zero.legacy_metadata["civility"].value == 0


def test_referent_markers_and_garbage_never_become_referents(preview: ImportPreview) -> None:
    expected = {
        3: Code.REFERENT_MARKER,  # xxx
        4: Code.REFERENT_MARKER,  # ?
        5: Code.REFERENT_MARKER,  # v
        6: Code.REFERENT_EMAIL_LIKE,
        7: Code.REFERENT_NOTE,
    }
    for number, code in expected.items():
        item = row(preview, number)
        assert code in codes(item)
        assert item.tracking is None or item.tracking.referent is None
        assert item.legacy_metadata["referent"].reason is LegacyReason.NOT_MAPPED_VALUE
    known = row(preview, 2).tracking
    assert known is not None and known.referent is not None
    assert known.referent.id == ID["referent-claire"] and not known.referent.requires_confirmation
    partial = row(preview, 11).tracking
    assert partial is not None and partial.referent is not None
    assert partial.referent.requires_confirmation


def test_week_codes_keep_no_invented_year(preview: ImportPreview) -> None:
    for number, week in ((2, 37), (3, 39)):
        item = row(preview, number)
        assert item.tracking is not None and item.tracking.planned_contact is not None
        planned = item.tracking.planned_contact
        assert (planned.week, planned.year, planned.planned_date) == (week, None, None)
        assert planned.requires_year
        assert Code.PLANNED_CONTACT_WEEK_WITHOUT_YEAR in codes(item)
        assert "planned_contact" in item.legacy_metadata


def test_retired_is_not_a_week_and_only_suggests_inactive(preview: ImportPreview) -> None:
    item = row(preview, 4)

    assert {Code.PLANNED_CONTACT_NOT_A_WEEK, Code.ACTIVITY_INACTIVE_SUGGESTED} <= codes(item)
    assert item.prospect.activity_status_suggestion == "inactive"
    assert item.tracking is None
    assert item.legacy_metadata["planned_contact"].value == "retraité"


def test_invalid_and_unknown_categories(preview: ImportPreview) -> None:
    invalid, unknown, known = row(preview, 3), row(preview, 4), row(preview, 2)

    assert Code.CATEGORY_INVALID in codes(invalid)
    assert invalid.company is not None and invalid.company.activity_categories == []
    assert invalid.legacy_metadata["category"].value == "Non"
    assert unknown.company is not None
    assert unknown.company.unmatched_categories == ["Logistique & Stockage"]
    assert unknown.company.segment_suggestion is not None
    assert {Code.CATEGORY_UNMATCHED, Code.CATEGORY_SEGMENT_SUGGESTED} <= codes(unknown)
    assert known.company is not None
    assert [c.id for c in known.company.activity_categories] == [ID["category-road"]]


def test_roles_are_suggested_never_created(preview: ImportPreview) -> None:
    exact, unknown, inactive = row(preview, 2), row(preview, 3), row(preview, 11)

    assert [r.id for r in exact.prospect.role_suggestions] == [ID["role-transport"]]
    assert exact.prospect.exact_job_title == "Responsable transport"
    assert unknown.prospect.role_suggestions == []
    assert unknown.prospect.exact_job_title == "Directeur des opérations fictives"
    assert Code.ROLE_UNMATCHED in codes(unknown)
    assert Code.ROLE_INACTIVE_MATCH in codes(inactive)


def test_duplicate_email_and_company_name_variant(preview: ImportPreview) -> None:
    first, second = row(preview, 2), row(preview, 3)

    assert [(d.kind, d.row, d.reasons) for d in first.duplicates] == [
        (CandidateKind.FILE_ROW, 3, [MatchReason.SAME_EMAIL])
    ]
    assert [d.row for d in second.duplicates] == [2]
    for item in (first, second):
        assert {Code.DUPLICATE_EMAIL_IN_FILE, Code.COMPANY_VARIANT_IN_FILE} <= codes(item)
    assert first.company is not None and second.company is not None
    assert first.company.match_key == second.company.match_key == "transports exemple"


def test_multiple_emails_and_phones_with_primary_selection(preview: ImportPreview) -> None:
    item = row(preview, 4)

    assert [(e.address, e.is_primary) for e in item.emails] == [
        ("claire.exemple@example.com", True),
        ("c.exemple@example.com", False),
    ]
    # Listed landline first, but the mobile (direct line) is primary.
    assert [(p.number, p.type, p.is_primary) for p in item.phones] == [
        ("+33100000003", PhoneType.LANDLINE, False),
        ("+33600000002", PhoneType.MOBILE, True),
    ]
    assert {Code.EMAIL_MULTIPLE_IN_CELL, Code.PHONE_MULTIPLE_IN_CELL} <= codes(item)
    two_columns = row(preview, 2)
    assert [(p.column, p.is_primary) for p in two_columns.phones] == [("P", False), ("Q", True)]


def test_historical_stages(preview: ImportPreview) -> None:
    conflict, consistent = row(preview, 7), row(preview, 8)

    assert conflict.tracking is not None
    assert conflict.tracking.status is ContactTrackingStatus.QUOTE_SENT
    assert conflict.tracking.requires_review
    assert Code.TRACKING_STAGE_CONFLICT in codes(conflict)
    assert consistent.tracking is not None
    assert consistent.tracking.status is ContactTrackingStatus.APPOINTMENT_OBTAINED
    assert not consistent.tracking.requires_review


def test_unknown_columns_and_opaque_fields_are_preserved(preview: ImportPreview) -> None:
    first, eighth = row(preview, 2), row(preview, 8)

    assert first.legacy_metadata["contact_mode"].model_dump() == {
        "column": "I",
        "header": "Mode de contact",
        "value": "Auto",
        "reason": "opaque_field",
    }
    assert first.legacy_metadata["legacy_to_contact_flag"].value == "Oui"
    assert eighth.legacy_metadata["column_X"].model_dump() == {
        "column": "X",
        "header": None,
        "value": "note fictive",
        "reason": "unmapped_column",
    }
    assert eighth.company is not None and eighth.company.establishment is not None
    establishment = eighth.company.establishment
    assert (establishment.address_line1, establishment.postal_code, establishment.city) == (
        "12 rue de l'Exemple",
        "69000",
        "Lyon",
    )


def test_do_not_contact_match_blocks_the_row(preview: ImportPreview) -> None:
    item = row(preview, 9)

    assert item.status == "error" and item.blocked_by_do_not_contact
    assert Code.CONTACTABILITY_DO_NOT_CONTACT in codes(item)
    (candidate,) = item.duplicates
    assert candidate.kind is CandidateKind.EXISTING_PROSPECT
    assert candidate.prospect_id == ID["prospect-blocked"]
    assert candidate.contactability is ContactabilityStatus.DO_NOT_CONTACT
    assert candidate.reasons == [MatchReason.SAME_EMAIL, MatchReason.SAME_PERSON]
    # A proposal never carries a contactability value that could overwrite the block.
    assert "contactability_status" not in item.prospect.model_dump()


def test_identity_diagnostics(preview: ImportPreview) -> None:
    assert Code.PROSPECT_MISSING_NAME in codes(row(preview, 10))
    assert row(preview, 10).status == "error"
    homonym = row(preview, 11)
    assert {Code.COMPANY_MISSING, Code.CONTACTABILITY_POSSIBLE_DO_NOT_CONTACT} <= codes(homonym)
    assert not homonym.blocked_by_do_not_contact


def test_preview_is_json_serializable_and_round_trips(preview: ImportPreview) -> None:
    payload = preview.model_dump(mode="json")

    assert json.loads(json.dumps(payload)) == payload
    assert ImportPreview.model_validate_json(preview.model_dump_json()) == preview


def test_preview_is_deterministic() -> None:
    shuffled = dataclasses.replace(
        REFERENCE,
        **{
            name: tuple(reversed(getattr(REFERENCE, name)))
            for name in ("roles", "activity_categories", "referents", "companies", "prospects")
        },
    )
    content = legacy_xlsx(SAMPLE_ROWS)

    runs = {
        build_preview(ImportFile("base.xlsx", content), reference).model_dump_json()
        for reference in (REFERENCE, REFERENCE, shuffled)
    }

    assert len(runs) == 1


def test_engine_runs_without_any_database(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VIPER_DATABASE_URL", "postgresql+psycopg://nobody:none@192.0.2.1:1/none")

    def refuse(*args: object, **kwargs: object) -> None:
        raise AssertionError("the import engine opened a network connection")

    monkeypatch.setattr(socket.socket, "connect", refuse)
    monkeypatch.setattr(socket, "create_connection", refuse)

    assert sample_preview().summary.rows_total == len(SAMPLE_ROWS)


def test_engine_modules_do_not_import_the_database_layer() -> None:
    forbidden = ("sqlalchemy", "psycopg", "app.db", "app.repositories", "app.api")
    package = Path(engine_package.__file__).parent
    offenders = {}
    for module in sorted(package.glob("*.py")):
        if module.name == "reference_loader.py":  # the one read-only DB entry point
            continue
        tree = ast.parse(module.read_text(encoding="utf-8"))
        imported = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        imported |= {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module}
        bad = {
            name
            for name in imported
            if name.startswith(forbidden)
            or (name.startswith("app.models") and name != "app.models.enums")
        }
        if bad:
            offenders[module.name] = sorted(bad)

    assert offenders == {}


def test_csv_legacy_export_in_windows_1252() -> None:
    buffer = io.StringIO()
    writer = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
    writer.writerow(["" if header is None else header for header in HEADERS])
    for sample in SAMPLE_ROWS[:3]:
        writer.writerow(["" if value is None else value for value in legacy_values(sample)])

    result = build_preview(ImportFile("export.csv", buffer.getvalue().encode("cp1252")), REFERENCE)

    assert (result.summary.file_format, result.summary.encoding) == ("csv", "cp1252")
    assert result.summary.delimiter == ";"
    assert Code.FILE_ENCODING_FALLBACK in result.summary.counts_by_code
    assert [r.prospect.last_name for r in result.rows] == ["Test", "Démo", "Exemple"]
    assert result.rows[0].tracking is not None
    assert result.rows[0].tracking.referent is not None


def test_merged_company_cell_is_copied_to_each_row() -> None:
    rows = [
        {"company": "Transports Exemple SARL", "last_name": "Test", "first_name": "Jean"},
        {"last_name": "Démo", "first_name": "Marc"},
    ]

    result = build_preview(ImportFile("m.xlsx", legacy_xlsx(rows, merges=("C2:C3",))), REFERENCE)

    second = result.rows[1]
    assert second.company is not None and second.company.display_name == "Transports Exemple SARL"
    assert Code.CELL_MERGED_VALUE_COPIED in codes(second)
    assert [c.copied_from_merge for c in second.cells if c.column == "C"] == [True]
    assert Code.SHEET_MERGED_CELLS in result.summary.counts_by_code


def test_mapping_override_and_empty_rows() -> None:
    rows: list[Any] = [
        {"company": "Transports Exemple", "last_name": "Test", "unnamed": "jean.test@example.com"},
        {},
        {"company": "Fret Modèle", "last_name": "Essai"},
    ]
    content = legacy_xlsx(rows)

    result = build_preview(
        ImportFile("o.xlsx", content), REFERENCE, ImportMapping(columns={"X": ImportField.EMAIL})
    )

    assert [r.row_number for r in result.rows] == [2, 4]
    assert result.summary.rows_empty == 1
    assert [e.address for e in result.rows[0].emails] == ["jean.test@example.com"]


def test_file_errors_surface_as_rejections() -> None:
    with pytest.raises(ImportRejectedError) as caught:
        build_preview(ImportFile("big.xlsx", legacy_xlsx(SAMPLE_ROWS)), limits=ImportLimits(1024))

    assert caught.value.code is Code.FILE_TOO_LARGE
    assert str(caught.value) == "Le fichier dépasse la taille maximale autorisée (0 Mo)."


# --- Losslessness: property-style check over generated rows ----------------------------------

POOLS: dict[str, list[CellValue]] = {
    "referent": ["Claire Référente", "Paul", "v", "xxx", "?", "a@example.com", "note 12/03", None],
    "week": ["S37", "s39", "S37 2026", "retraité", "à voir", date(2026, 9, 14), 0, None],
    "company": ["Transports Exemple SARL", "TRANSPORTS EXEMPLE", "x" * 300, 0, None],
    "rdv": ["oui", "non", "x", "à rappeler", datetime(2026, 3, 12), 2, None],
    "devis": ["oui", "non", True, "?", None],
    "suivi": ["x", "fait", "-", None],
    "relance1": ["x", "12/03/2026", None],
    "relance2": ["oui", "OUI le 5/4", None],
    "mode": ["Auto", "Commercial", "Commerciale", None],
    "category": ["Transport routier de marchandises", "Non", "1. A & B / Transporteur", None],
    "civility": ["M.", "MME.", "MR", 0, "Dr", None],
    "last_name": ["TEST", "de la Tour", "y" * 120, None],
    "first_name": ["Jean", "marie-claire", 0, None],
    "job": ["Responsable transport", "Chef de quai", "Gérant fictif", None],
    "email": ["jean.test@example.com", "a@example.com / b@", "invalide", None],
    "phone": ["01 00 00 00 01", "01 00 00", 600000001, "06 00 00 00 02 / 07 00 00 00 03", None],
    "mobile": ["06 00 00 00 01", "+44 7000 000000", "n/c", None],
    "address": ["12 rue Fictive 69000 Lyon", "Zone fictive", 0, None],
    "project_done": ["Oui", "Non", 0, None],
    "project_type": [0, "1 Étude fictive", None],
    "references": ["Fiche fictive A\nFiche fictive B", None],
    "approach": ["Salon fictif", None],
    "flag": ["Oui", "OUI", None],
    "unnamed": ["note libre", 7, None],
}


def phones_present(item: PreviewRow, value: CellValue, *, mobile: bool) -> bool:
    """Numbers of the cell are proposed (a number repeated in `Mobile` is proposed once)."""
    numbers = {phone.number for phone in parse_phones(value, mobile_column=mobile).value or ()}
    return bool(numbers) and numbers <= {phone.number for phone in item.phones}


def represented(item: PreviewRow, key: str, value: CellValue) -> bool:
    """The proposal really carries something derived from a cell marked `mapped`."""
    company, prospect, tracking = item.company, item.prospect, item.tracking
    checks = {
        "referent": lambda: tracking is not None and bool(tracking.referent_suggestions),
        "week": lambda: tracking is not None and tracking.planned_contact is not None,
        "company": lambda: company is not None,
        "category": lambda: (
            company is not None
            and bool(
                company.activity_categories
                or company.unmatched_categories
                or company.segment_suggestion
            )
        ),
        "civility": lambda: prospect.civility is not None,
        "last_name": lambda: prospect.last_name is not None,
        "first_name": lambda: prospect.first_name is not None,
        "job": lambda: prospect.exact_job_title is not None,
        "email": lambda: bool(item.emails),
        "phone": lambda: phones_present(item, value, mobile=False),
        "mobile": lambda: phones_present(item, value, mobile=True),
        "address": lambda: company is not None and company.establishment is not None,
        "project_done": lambda: (
            company is not None and company.project_done_with_circoe is not None
        ),
        "project_type": lambda: company is not None and company.project_type is not None,
        "references": lambda: company is not None and company.circoe_references is not None,
        "approach": lambda: company is not None and company.client_approach is not None,
    }
    if key in ("rdv", "devis", "suivi", "relance1", "relance2"):
        return read_stage(value).state is not StageState.UNRECOGNIZED
    return checks[key]()


def test_every_non_empty_cell_is_mapped_or_preserved() -> None:
    generator = random.Random(20260910)
    rows = [{key: generator.choice(pool) for key, pool in POOLS.items()} for _ in range(300)]

    result = build_preview(ImportFile("random.xlsx", legacy_xlsx(rows)), REFERENCE)

    by_number = {item.row_number: item for item in result.rows}
    checked = 0
    for number, source in enumerate(rows, start=2):
        if all(is_blank(value) for value in source.values()):
            assert number not in by_number
            continue
        item = by_number[number]
        cells = {cell.column: cell for cell in item.cells}
        preserved = {entry.column: entry.value for entry in item.legacy_metadata.values()}
        assert set(preserved) <= set(cells)  # legacy metadata only holds source cells
        for key, value in source.items():
            letter = LETTERS[key]
            if is_blank(value):
                assert letter not in cells
                continue
            cell = cells[letter]
            assert cell.value == json_value(value)
            assert cell.mapped or cell.preserved, (number, letter)
            if cell.preserved:
                assert preserved[letter] == json_value(value), (number, letter)
            if cell.mapped:
                assert represented(item, key, value), (number, letter)
            checked += 1
    assert checked > 3000


def test_every_diagnostic_code_is_catalogued_and_documented() -> None:
    documented = (
        Path(__file__).parents[2] / "doc" / "features" / "excel-import-export.md"
    ).read_text(encoding="utf-8")

    assert set(CATALOGUE) == set(Code)
    assert [code.value for code in Code if f"| `{code.value}` |" not in documented] == []
