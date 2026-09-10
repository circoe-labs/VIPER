"""Excel export API (`/api/exports`, Task 10, ADR-0013).

- `GET /exports/workbook` — the whole normalized database as one XLSX download
  (`VIPER_export_YYYY-MM-DD.xlsx`, date in Europe/Paris). A GET, so no CSRF token: it changes no
  domain data; the request's session is still required and the download is audited
  (`export.generated`, counts only) with the signed-in user. Not cached (personal data).
"""

from datetime import UTC, datetime

from fastapi import APIRouter, Response, status

from app.api.dependencies import CurrentActor, SessionDep
from app.services import excel_export

router = APIRouter(prefix="/exports", tags=["exports"])


@router.get(
    "/workbook",
    response_class=Response,
    responses={status.HTTP_200_OK: {"content": {excel_export.MEDIA_TYPE: {}}}},
)
def download_workbook(session: SessionDep, actor: CurrentActor) -> Response:
    exported = excel_export.export_workbook(session, actor, generated_at=datetime.now(UTC))
    return Response(
        content=exported.content,
        media_type=excel_export.MEDIA_TYPE,
        headers={
            "Content-Disposition": f'attachment; filename="{exported.filename}"',
            "Cache-Control": "no-store",
        },
    )
