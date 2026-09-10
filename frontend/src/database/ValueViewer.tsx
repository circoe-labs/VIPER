import type { ExplorerColumn, ExplorerRow } from '../api/explorer'
import { useExplorerRecord } from '../api/explorer'
import { Button } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import { CopyIcon } from '../ui/icons'
import { clipboardValue, fullValueText } from './cells'

interface ValueViewerProps {
  table: string
  column: ExplorerColumn
  row: ExplorerRow
  rowNumber: number
  primaryKey: string[]
  onCopy: (text: string, message: string) => void
  onClose: () => void
}

const COUNT = new Intl.NumberFormat('fr-FR')

// Full value of one cell. A value cut in the page is fetched in full from the record endpoint; JSON is
// pretty-printed. Read-only.
export function ValueViewer({ table, column, row, rowNumber, primaryKey, onCopy, onClose }: ValueViewerProps) {
  const truncated = row.truncated.includes(column.name)
  const key = Object.fromEntries(primaryKey.map((name) => [name, row.values[name]]))
  const record = useExplorerRecord(table, key, truncated)
  const value = truncated ? record.data?.values[column.name] : row.values[column.name]
  const text = fullValueText(value, column.kind)
  const ready = !truncated || record.isSuccess
  const isNull = ready && (value === null || value === undefined)

  return (
    <Drawer
      open
      size="lg"
      title={column.name}
      description={`${table} · ligne ${String(rowNumber)} · ${column.sql_type}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Fermer
          </Button>
          <Button
            icon={CopyIcon}
            disabled={!ready || isNull}
            onClick={() => {
              onCopy(column.kind === 'json' ? text : clipboardValue(value), 'Valeur complète copiée')
            }}
          >
            Copier la valeur
          </Button>
        </>
      }
    >
      {truncated && record.isPending && <p className="value-viewer__note">Chargement de la valeur complète…</p>}
      {truncated && record.isError && (
        <p className="value-viewer__note value-viewer__note--error">
          Impossible de charger la valeur complète. Elle a peut-être été supprimée ; actualisez la table.
        </p>
      )}
      {isNull && <p className="value-viewer__null">NULL — aucune valeur enregistrée.</p>}
      {ready && !isNull && (
        <>
          <p className="value-viewer__meta">
            {COUNT.format(text.length)} caractères{column.kind === 'json' ? ' · JSON mis en forme' : ''}
          </p>
          <pre className="value-viewer__content" data-kind={column.kind} tabIndex={0} aria-label={`Valeur de ${column.name}`}>
            {text}
          </pre>
        </>
      )}
    </Drawer>
  )
}
