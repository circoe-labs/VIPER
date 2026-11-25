import type { ImportPlan, PreviewResult } from '../api/imports'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { SelectField } from '../ui/fields'
import { AlertIcon, CheckCircleIcon, InfoIcon, RefreshIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { fieldLabel, plural, rowsText } from './messages'
import { ReimportWarning } from './ReimportWarning'

interface SheetStepProps {
  preview: PreviewResult
  busy: boolean
  agentReading: boolean
  onAskAgent: () => void
  onConfirm: () => void
  onChooseSheet: (sheet: string) => void
  onReset: () => void
}

// Which sheet holds the prospects, which ones are skipped and why, and how the columns were read — confirmed by the
// user before the review.
export function SheetStep(props: SheetStepProps) {
  const { preview, busy, agentReading, onAskAgent, onConfirm, onChooseSheet, onReset } = props
  const summary = preview.review.preview.summary
  const notFound = summary.notices.find((notice) => notice.code === 'sheet.not_found')
  const skipped = summary.notices.filter((notice) => notice.code === 'sheet.skipped')
  const columnNotices = summary.notices.filter((notice) => notice.code.startsWith('column.'))
  const recognized = summary.columns.filter((column) => column.field !== null).length
  if (summary.plan) return <AgentReading {...props} plan={summary.plan} />

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
          <Button icon={RefreshIcon} disabled={busy} loading={agentReading} onClick={onAskAgent}>
            Faire lire par l’agent IA
          </Button>
          <Button variant="primary" disabled={Boolean(notFound) || busy} loading={busy} onClick={onConfirm}>
            Confirmer la feuille
          </Button>
        </div>
      </div>
    </Card>
  )
}

// The agent's reading: what it understood (per block of rows), what it asks to check and what it left out.
function AgentReading({ preview, plan, busy, agentReading, onAskAgent, onConfirm, onReset }: SheetStepProps & { plan: ImportPlan }) {
  const { summary, rows } = preview.review.preview
  const skipped = summary.notices.filter((notice) => notice.code === 'sheet.rows_not_read')
  const companies = preview.review.companies.length
  return (
    <Card
      title="Lecture par l’agent IA"
      className="import-card"
      actions={
        <InfoTip label="Aide : agent d’import">
          Le contenu du classeur est envoyé au service d’IA configuré pour comprendre sa mise en page. Les valeurs importées
          sont lues dans votre fichier, jamais rédigées par l’IA. Rien n’est enregistré avant votre confirmation.
        </InfoTip>
      }
    >
      <ReimportWarning previous={preview.previous_imports} />
      <p className="import-sheet__detected">
        <CheckCircleIcon size={20} />
        <span>
          <strong>{rowsText(summary.rows_total)}</strong> et <strong>{plural(companies, 'entreprise', 'entreprises')}</strong> lues
          dans « {summary.sheet} ».
        </span>
      </p>
      {(plan.notes.length > 0 || skipped.length > 0) && (
        <ul className="import-sheet__skipped" aria-label="Points à vérifier">
          {[...skipped.map((notice) => notice.message), ...plan.notes].map((text) => (
            <li key={text}>
              <InfoIcon size={16} />
              {text}
            </li>
          ))}
        </ul>
      )}
      <details className="import-sheet__columns">
        <summary>Voir la correspondance des colonnes</summary>
        <div className="import-sheet__blocks">
          {plan.blocks.map((block) => {
            const sample = rows.find(
              (row) => row.source_sheet === block.sheet && (row.source_row ?? 0) >= block.first_row && (row.source_row ?? 0) <= block.last_row,
            )
            return (
              <table key={`${block.sheet}-${String(block.first_row)}`} className="import-mini-table">
                <caption>
                  {block.sheet}, lignes {block.first_row} à {block.last_row}
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Colonne</th>
                    <th scope="col">En-tête du fichier</th>
                    <th scope="col">Devient</th>
                  </tr>
                </thead>
                <tbody>
                  {block.columns.map((column) => (
                    <tr key={column.column}>
                      <td>{column.column}</td>
                      <td>{sample?.cells.find((cell) => cell.column === column.column)?.header ?? '—'}</td>
                      <td>{fieldLabel(column.field)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          })}
        </div>
      </details>
      <div className="import-sheet__footer">
        <div className="import-sheet__actions">
          <Button onClick={onReset}>Changer de fichier</Button>
          <Button icon={RefreshIcon} disabled={busy} loading={agentReading} onClick={onAskAgent}>
            Relire avec l’agent
          </Button>
          <Button variant="primary" disabled={busy || summary.rows_total === 0} onClick={onConfirm}>
            Confirmer la lecture
          </Button>
        </div>
      </div>
    </Card>
  )
}
