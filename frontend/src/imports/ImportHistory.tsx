import { type BatchStatus, useImportHistory } from '../api/imports'
import { type StatusTone, StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { AlertIcon } from '../ui/icons'
import { Table } from '../ui/Table'
import { formatDateTime } from './messages'

// Also Home's recent imports (Task 16).
export const BATCH_STATUS: Record<BatchStatus, { tone: StatusTone; label: string }> = {
  committed: { tone: 'success', label: 'Importé' },
  failed: { tone: 'danger', label: 'Échec, rien importé' },
  pending: { tone: 'info', label: 'En cours' },
  cancelled: { tone: 'neutral', label: 'Annulé' },
}

// The last imports: metadata and counts only (the file itself is never stored).
export function ImportHistory() {
  const history = useImportHistory()
  return (
    <Card title="Historique des imports" className="import-card import-history">
      {history.isPending && <p className="import-muted">Chargement…</p>}
      {history.isError && (
        <p className="import-alert import-alert--danger" role="alert">
          <AlertIcon size={18} />
          Historique indisponible.
          <Button size="sm" onClick={() => void history.refetch()}>
            Réessayer
          </Button>
        </p>
      )}
      {history.data?.length === 0 && <p className="import-muted">Aucun import pour l’instant.</p>}
      {history.data && history.data.length > 0 && (
        <Table caption="Historique des imports">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Fichier</th>
              <th scope="col">Par</th>
              <th scope="col" className="table__numeric">
                Importées
              </th>
              <th scope="col" className="table__numeric">
                Exclues
              </th>
              <th scope="col">Statut</th>
            </tr>
          </thead>
          <tbody>
            {history.data.map((batch) => (
              <tr key={batch.id}>
                <td className="import-history__date">{formatDateTime(batch.committed_at ?? batch.created_at)}</td>
                <td>
                  <span className="import-history__file">{batch.filename}</span>
                  {batch.source_reference && <span className="import-muted">{batch.source_reference}</span>}
                </td>
                <td>{batch.actor_display}</td>
                <td className="table__numeric">
                  {batch.rows_imported} / {batch.rows_total}
                </td>
                <td className="table__numeric">{batch.rows_skipped}</td>
                <td>
                  <StatusBadge tone={BATCH_STATUS[batch.status].tone}>{BATCH_STATUS[batch.status].label}</StatusBadge>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  )
}
