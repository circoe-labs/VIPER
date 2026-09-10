import { useState } from 'react'

import { downloadWorkbook } from '../api/exports'
import { Button, type ButtonVariant } from '../ui/Button'
import { AlertIcon, DownloadIcon } from '../ui/icons'
import './exports.css'

// Hands a downloaded file to the browser under `filename` (a temporary object URL, released right after).
export function saveFile(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.hidden = true
  document.body.append(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function fallbackName(): string {
  return `VIPER_export_${new Date().toISOString().slice(0, 10)}.xlsx`
}

interface ExportWorkbookButtonProps {
  variant?: ButtonVariant
}

// « Exporter Excel » (Task 10): downloads the normalized workbook of the whole database. Reusable in any page header
// (Entreprises, Import, the Prospection workspace of Task 14). Shows progress while the server builds the file and a
// French error next to the button when it fails.
export function ExportWorkbookButton({ variant = 'secondary' }: ExportWorkbookButtonProps) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function exportWorkbook() {
    setBusy(true)
    setFailed(false)
    try {
      const { blob, filename } = await downloadWorkbook()
      saveFile(blob, filename ?? fallbackName())
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <span className="export-workbook">
      <Button variant={variant} icon={DownloadIcon} loading={busy} onClick={() => void exportWorkbook()}>
        {busy ? 'Export en cours…' : 'Exporter Excel'}
      </Button>
      {failed && (
        <span className="export-workbook__error" role="alert">
          <AlertIcon size={16} />
          L’export Excel a échoué. Réessayez.
        </span>
      )}
    </span>
  )
}
