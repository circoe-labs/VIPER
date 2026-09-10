"""ExcelExportService (Task 10, ADR-0013): the normalized database as one workbook, audited.

Read-only on the domain: `build_workbook` loads the projection, lays it out with the export
specification and writes the XLSX; `export_workbook` adds the `export.generated` audit event
(counts only — no personal value) with the signed-in actor. The generation date is an argument:
the same data and date give the same bytes.
"""

from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.orm import Session

from app.core.actor import ActorContext
from app.services import audit
from app.services.audit import AuditAction
from app.services.exports.projection import ExportData, load_export_data
from app.services.exports.spec import SHEETS, Sheet
from app.services.exports.workbook import SheetContent, write_workbook
from app.services.import_commit import BUSINESS_TIMEZONE

EXPORT_ENTITY = "excel_export"
MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@dataclass(frozen=True, slots=True)
class ExportedWorkbook:
    filename: str
    content: bytes
    rows: dict[str, int]  # data rows per sheet key


def export_filename(generated_at: datetime) -> str:
    return f"VIPER_export_{generated_at.astimezone(BUSINESS_TIMEZONE):%Y-%m-%d}.xlsx"


def build_workbook(session: Session, *, generated_at: datetime) -> ExportedWorkbook:
    data = load_export_data(session)
    content, rows = write_workbook(
        (_content(sheet, data) for sheet in SHEETS), created=generated_at
    )
    return ExportedWorkbook(export_filename(generated_at), content, rows)


def export_workbook(
    session: Session, actor: ActorContext, *, generated_at: datetime
) -> ExportedWorkbook:
    exported = build_workbook(session, generated_at=generated_at)
    facts = {f"{key}_rows": count for key, count in exported.rows.items()}
    facts["size_bytes"] = len(exported.content)
    audit.record_event(
        session,
        actor,
        AuditAction.EXPORT_GENERATED,
        entity_type=EXPORT_ENTITY,
        entity_id=None,
        changes={name: {"before": None, "after": value} for name, value in facts.items()},
    )
    return exported


def _content[R](sheet: Sheet[R], data: ExportData) -> SheetContent:
    return SheetContent(
        key=sheet.key,
        name=sheet.name,
        columns=sheet.columns,
        rows=([column.get(row) for column in sheet.columns] for row in sheet.rows(data)),
    )
