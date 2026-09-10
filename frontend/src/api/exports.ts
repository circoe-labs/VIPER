import { apiDownload, type DownloadedFile } from './client'

// Mirrors backend/app/api/routes/exports.py: the normalized Excel export (Task 10, doc/features/excel-import-export.md).
// The whole database as one workbook, `VIPER_export_YYYY-MM-DD.xlsx`; each download is audited server-side.
export const WORKBOOK_EXPORT_PATH = '/exports/workbook'

export function downloadWorkbook(signal?: AbortSignal): Promise<DownloadedFile> {
  return apiDownload(WORKBOOK_EXPORT_PATH, signal)
}
