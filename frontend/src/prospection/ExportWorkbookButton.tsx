import { DownloadIcon } from '../ui/icons'

// Excel export of the whole base (Task 10, `GET /api/exports/workbook`): a plain download link — the session cookie
// travels with same-origin GETs, and the server names the file (Content-Disposition).
export const WORKBOOK_EXPORT_URL = '/api/exports/workbook'

export function ExportWorkbookButton() {
  return (
    <a className="btn btn--secondary btn--md" href={WORKBOOK_EXPORT_URL} download>
      <DownloadIcon size={18} />
      Exporter Excel
    </a>
  )
}
