"""Private compatibility smoke against the real, git-ignored client workbook. Never runs in CI.

Skipped unless `VIPER_PRIVATE_WORKBOOK` points to the file. Privacy: the preview is only inspected
through structural facts and counts; assertions compare numbers, codes, sheet names and column
letters — never row content — and the printed report holds counts per diagnostic code only.
Run from `backend/`: `VIPER_PRIVATE_WORKBOOK=<path> pytest -m private -s`.
"""

import os
from collections import Counter
from pathlib import Path

import pytest

from app.services.imports.fields import ImportField
from app.services.imports.layout import MatchedBy
from app.services.imports.preview import ImportFile, build_preview

WORKBOOK = os.environ.get("VIPER_PRIVATE_WORKBOOK", "")

pytestmark = [
    pytest.mark.private,
    pytest.mark.skipif(
        not WORKBOOK or not Path(WORKBOOK).is_file(),
        reason="VIPER_PRIVATE_WORKBOOK does not point to the private workbook",
    ),
]

EXPECTED_ANOMALIES = {
    "referent.marker",
    "referent.email_like",
    "referent.note",
    "planned_contact.week_without_year",
    "planned_contact.not_a_week",
    "activity.inactive_suggested",
    "civility.invalid",
    "category.invalid",
    "duplicate.email_in_file",
    "sheet.skipped",
    "column.unnamed",
    "column.legacy_preserved",
}


def test_private_workbook_parses_to_the_expected_structure() -> None:
    path = Path(WORKBOOK)
    file = ImportFile(path.name, path.read_bytes())
    preview = build_preview(file)
    summary = preview.summary
    codes = Counter(summary.counts_by_code)
    unaccounted = sum(
        1 for row in preview.rows for cell in row.cells if not (cell.mapped or cell.preserved)
    )
    mapped_columns = sum(1 for column in summary.columns if column.field is not None)
    by_position = [c.column for c in summary.columns if c.matched_by is MatchedBy.POSITION]
    unnamed = [c.column for c in summary.columns if c.header is None]

    report = [f"rows={summary.rows_total} empty={summary.rows_empty}"]
    report.append(f"rows_by_status={dict(summary.rows_by_status)}")
    report.append(f"severities={summary.counts_by_severity}")
    report.extend(f"  {code}: {count}" for code, count in sorted(codes.items()))
    report.append(f"duplicate_email_groups={summary.duplicate_email_groups}")
    print("\n".join(["", "PRIVATE WORKBOOK — aggregate diagnostics", *report]))

    assert summary.sheet == "Base client "
    assert [(s.name, s.status.value) for s in summary.sheets] == [
        ("Base client ", "imported"),
        ("actualité", "skipped"),
    ]
    assert summary.header_row == 1
    assert summary.rows_total == 339
    assert summary.rows_empty == 3
    assert len(summary.columns) == 24
    assert mapped_columns == 23
    assert by_position == ["W"]
    assert unnamed == ["X"]
    assert {c.field for c in summary.columns if c.field} == set(ImportField)
    assert set(codes) >= EXPECTED_ANOMALIES
    assert summary.duplicate_email_groups == 3
    assert unaccounted == 0
    assert build_preview(file).model_dump_json() == preview.model_dump_json()
