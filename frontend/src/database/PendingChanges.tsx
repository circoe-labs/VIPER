import type { ExplorerTable, RowValues } from '../api/explorer'
import { Button, IconButton } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import { AlertIcon, PencilIcon, PlusIcon, SaveIcon, TrashIcon, UndoIcon } from '../ui/icons'
import { clipboardValue, compactUuid, displayValue } from './cells'
import { type ChangeSummary, type Staging, type StagedError } from './staging'

const plural = (count: number, one: string, many: string) => `${String(count)} ${count > 1 ? many : one}`

export function summaryTitle(summary: ChangeSummary): string {
  return `${plural(summary.total, 'modification', 'modifications')} en attente`
}

export function summaryDetail(summary: ChangeSummary): string {
  return [
    summary.cells > 0 && plural(summary.cells, 'cellule modifiée', 'cellules modifiées'),
    summary.inserts > 0 && plural(summary.inserts, 'ligne ajoutée', 'lignes ajoutées'),
    summary.deletes > 0 && plural(summary.deletes, 'suppression', 'suppressions'),
  ]
    .filter(Boolean)
    .join(' · ')
}

interface PendingChangesBarProps {
  summary: ChangeSummary
  // Errors of the last refused save (nothing was saved).
  errors: number
  // The save could not reach a verdict (network, server error).
  failure: string | null
  saving: boolean
  onReview: () => void
  onCancel: () => void
  onSave: () => void
}

// Shown while changes are staged: what is pending, what the server refused, and Save / Cancel for the whole set.
export function PendingChangesBar({ summary, errors, failure, saving, onReview, onCancel, onSave }: PendingChangesBarProps) {
  const refused = errors > 0 || failure !== null
  const Icon = refused ? AlertIcon : PencilIcon
  let title = summaryTitle(summary)
  let detail = summaryDetail(summary)
  if (errors > 0) {
    title = `Enregistrement refusé : ${plural(errors, 'erreur', 'erreurs')}`
    detail = `Rien n’a été enregistré. Corrigez les cellules signalées, puis enregistrez (${summaryTitle(summary)}).`
  } else if (failure) {
    title = 'Enregistrement impossible'
    detail = `${failure} Vos ${summaryTitle(summary)} sont conservées.`
  }
  return (
    <section className="pending-bar" data-refused={refused ? '' : undefined} aria-label="Modifications en attente">
      <Icon size={20} className="pending-bar__icon" />
      <div className="pending-bar__text" role="status" aria-live="polite">
        <p className="pending-bar__title">{title}</p>
        <p className="pending-bar__detail">{detail}</p>
      </div>
      <div className="pending-bar__actions">
        <Button variant="ghost" size="sm" onClick={onReview}>
          Voir le détail
        </Button>
        <Button size="sm" icon={UndoIcon} disabled={saving} title="Annuler toutes les modifications en attente" onClick={onCancel}>
          Annuler
        </Button>
        <Button variant="primary" size="sm" icon={SaveIcon} loading={saving} onClick={onSave}>
          Enregistrer
        </Button>
      </div>
    </section>
  )
}

interface PendingChangesDrawerProps {
  meta: ExplorerTable
  staging: Staging
  onRevert: (id: string) => void
  onRevertCell: (id: string, column: string) => void
  onClose: () => void
}

function rowLabel(meta: ExplorerTable, values: RowValues): string {
  const label = meta.label_columns
    .map((name) => clipboardValue(values[name]))
    .filter(Boolean)
    .join(' ')
  const key = meta.primary_key.map((name) => compactUuid(clipboardValue(values[name]))).join(' · ')
  return label ? `${label} (${key})` : key
}

function text(meta: ExplorerTable, column: string, value: unknown): string {
  const kind = meta.columns.find((item) => item.name === column)?.kind ?? 'text'
  const shown = displayValue(value, kind)
  return shown.length > 60 ? `${shown.slice(0, 60)}…` : shown
}

function Errors({ errors }: { errors: StagedError[] }) {
  if (errors.length === 0) return null
  return (
    <ul className="pending-list__errors">
      {errors.map((error, index) => (
        <li key={`${error.column ?? ''}-${String(index)}`}>
          <AlertIcon size={14} />
          {error.column && <code>{error.column}</code>}
          {error.message}
        </li>
      ))}
    </ul>
  )
}

// Review of every staged change, current page or not, with the server errors, and undo per cell or per row.
export function PendingChangesDrawer({ meta, staging, onRevert, onRevertCell, onClose }: PendingChangesDrawerProps) {
  const errorsOf = (id: string) => staging.errors[id] ?? []
  return (
    <Drawer
      open
      size="md"
      title="Modifications en attente"
      description={`${meta.name} · rien n’est enregistré avant « Enregistrer »`}
      onClose={onClose}
      footer={
        <Button variant="ghost" onClick={onClose}>
          Fermer
        </Button>
      }
    >
      <div className="pending-list">
        {staging.updates.length > 0 && (
          <section aria-labelledby="pending-updates">
            <h3 id="pending-updates" className="pending-list__title">
              <PencilIcon size={16} /> Cellules modifiées
            </h3>
            <ul className="pending-list__items">
              {staging.updates.map((update) => (
                <li key={update.id} className="pending-list__item">
                  <p className="pending-list__row">{rowLabel(meta, update.original)}</p>
                  <ul className="pending-list__cells">
                    {Object.entries(update.values).map(([column, value]) => (
                      <li key={column}>
                        <code>{column}</code>
                        <span className="pending-list__before">{text(meta, column, update.original[column])}</span>
                        <span aria-hidden="true">→</span>
                        <span className="visually-hidden">devient</span>
                        <span className="pending-list__after">{text(meta, column, value)}</span>
                        <IconButton
                          icon={UndoIcon}
                          size="sm"
                          label={`Annuler la modification de ${column}`}
                          onClick={() => {
                            onRevertCell(update.id, column)
                          }}
                        />
                      </li>
                    ))}
                  </ul>
                  <Errors errors={errorsOf(update.id)} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {staging.inserts.length > 0 && (
          <section aria-labelledby="pending-inserts">
            <h3 id="pending-inserts" className="pending-list__title">
              <PlusIcon size={16} /> Lignes ajoutées
            </h3>
            <ul className="pending-list__items">
              {staging.inserts.map((insert) => (
                <li key={insert.id} className="pending-list__item">
                  <div className="pending-list__row-line">
                    <p className="pending-list__row">
                      {Object.entries(insert.values)
                        .map(([column, value]) => `${column} = ${text(meta, column, value)}`)
                        .join(' · ') || 'Nouvelle ligne vide'}
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onRevert(insert.id)
                      }}
                    >
                      Retirer
                    </Button>
                  </div>
                  <Errors errors={errorsOf(insert.id)} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {staging.deletes.length > 0 && (
          <section aria-labelledby="pending-deletes">
            <h3 id="pending-deletes" className="pending-list__title">
              <TrashIcon size={16} /> Suppressions
            </h3>
            <ul className="pending-list__items">
              {staging.deletes.map((item) => (
                <li key={item.id} className="pending-list__item">
                  <div className="pending-list__row-line">
                    <p className="pending-list__row">{rowLabel(meta, item.original)}</p>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        onRevert(item.id)
                      }}
                    >
                      Annuler la suppression
                    </Button>
                  </div>
                  <Errors errors={errorsOf(item.id)} />
                </li>
              ))}
            </ul>
          </section>
        )}
        {staging.updates.length + staging.inserts.length + staging.deletes.length === 0 && (
          <p className="pending-list__empty">Aucune modification en attente.</p>
        )}
      </div>
    </Drawer>
  )
}
