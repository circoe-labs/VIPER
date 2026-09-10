import type { PreviewResult } from '../api/imports'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { SelectField } from '../ui/fields'
import { AlertIcon, CheckCircleIcon, InfoIcon } from '../ui/icons'
import { fieldLabel, rowsText } from './messages'
import { ReimportWarning } from './ReimportWarning'

interface SheetStepProps {
  preview: PreviewResult
  busy: boolean
  onConfirm: () => void
  onChooseSheet: (sheet: string) => void
  onReset: () => void
}

// Which sheet holds the prospects, which ones are skipped and why, and how the columns were read — confirmed by the
// user before the review.
export function SheetStep({ preview, busy, onConfirm, onChooseSheet, onReset }: SheetStepProps) {
  const summary = preview.review.preview.summary
  const notFound = summary.notices.find((notice) => notice.code === 'sheet.not_found')
  const skipped = summary.notices.filter((notice) => notice.code === 'sheet.skipped')
  const columnNotices = summary.notices.filter((notice) => notice.code.startsWith('column.'))
  const recognized = summary.columns.filter((column) => column.field !== null).length

  return (
    <Card title="Feuille à importer" className="import-card">
      <ReimportWarning previous={preview.previous_imports} />
      {notFound ? (
        <p className="import-alert import-alert--danger">
          <AlertIcon size={18} />
          {notFound.message} Choisissez la feuille à importer ci-dessous.
        </p>
      ) : (
        <p className="import-sheet__detected">
          <CheckCircleIcon size={20} />
          <span>
            Feuille des prospects détectée : <strong>« {summary.sheet} »</strong> — {rowsText(summary.rows_total)} de
            données, en-têtes en ligne {summary.header_row}
            {summary.rows_empty > 0 && `, ${rowsText(summary.rows_empty)} vides ignorées`}.
          </span>
        </p>
      )}
      {skipped.length > 0 && (
        <ul className="import-sheet__skipped" aria-label="Feuilles ignorées">
          {skipped.map((notice) => (
            <li key={notice.message}>
              <InfoIcon size={16} />
              {notice.message}
            </li>
          ))}
        </ul>
      )}
      {!notFound && (
        <details className="import-sheet__columns">
          <summary>
            {recognized} colonnes reconnues sur {summary.columns.length} — voir la correspondance
          </summary>
          <table className="import-mini-table">
            <thead>
              <tr>
                <th scope="col">Colonne</th>
                <th scope="col">En-tête du fichier</th>
                <th scope="col">Devient</th>
              </tr>
            </thead>
            <tbody>
              {summary.columns.map((column) => (
                <tr key={column.column}>
                  <td>{column.column}</td>
                  <td>{column.header ?? '—'}</td>
                  <td>{column.field ? fieldLabel(column.field) : 'Conservée telle quelle'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {columnNotices.length > 0 && (
            <ul className="import-sheet__notices">
              {columnNotices.map((notice) => (
                <li key={notice.message}>{notice.message}</li>
              ))}
            </ul>
          )}
        </details>
      )}
      <div className="import-sheet__footer">
        <SelectField
          label="Feuille des prospects"
          value={summary.sheet ?? ''}
          disabled={busy}
          onChange={(event) => {
            onChooseSheet(event.target.value)
          }}
        >
          {!summary.sheet && <option value="">Choisir une feuille</option>}
          {summary.sheets.map((sheet) => (
            <option key={sheet.name} value={sheet.name}>
              {sheet.name} ({rowsText(sheet.rows)})
            </option>
          ))}
        </SelectField>
        <div className="import-sheet__actions">
          <Button onClick={onReset}>Changer de fichier</Button>
          <Button variant="primary" disabled={Boolean(notFound) || busy} loading={busy} onClick={onConfirm}>
            Confirmer la feuille
          </Button>
        </div>
      </div>
    </Card>
  )
}
