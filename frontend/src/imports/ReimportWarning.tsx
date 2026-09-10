import type { ImportBatch } from '../api/imports'
import { AlertIcon } from '../ui/icons'
import { formatDateTime, rowsText } from './messages'

// The same file (same SHA-256) was already committed: importing it again is allowed, knowingly.
export function ReimportWarning({ previous }: { previous: ImportBatch[] }) {
  const last = previous[0]
  if (!last) return null
  return (
    <div className="import-alert import-alert--warning" role="alert">
      <AlertIcon size={18} />
      <p>
        <strong>Ce fichier a déjà été importé</strong>
        {previous.length > 1 && ` (${String(previous.length)} fois)`} — dernier import le{' '}
        {formatDateTime(last.committed_at ?? last.created_at)} par {last.actor_display},{' '}
        {rowsText(last.rows_imported)} importées. L’importer à nouveau peut compléter ou dupliquer des fiches : vérifiez
        les doublons proposés.
      </p>
    </div>
  )
}
