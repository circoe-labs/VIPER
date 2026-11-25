import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { cancelImport, type ImportBatch, previewCancellation } from '../api/imports'
import { refreshAfterWrite } from '../api/refresh'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { AlertIcon, SpinnerIcon } from '../ui/icons'
import { importErrorMessage, plural } from './messages'

interface CancelImportProps {
  batch: ImportBatch
  size?: 'sm' | 'md'
  onCancelled?: () => void
}

// « Annuler l'import » : the button of a committed import and its confirmation, which says first what will be
// removed and what stays (anything used since the import).
export function CancelImport({ batch, size = 'md', onCancelled }: CancelImportProps) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        size={size}
        aria-label={`Annuler l’import de « ${batch.filename} »`}
        onClick={() => {
          setOpen(true)
        }}
      >
        Annuler l’import
      </Button>
      {open && (
        <CancelDialog
          batch={batch}
          onClose={() => {
            setOpen(false)
          }}
          onCancelled={onCancelled}
        />
      )}
    </>
  )
}

function CancelDialog({ batch, onClose, onCancelled }: CancelImportProps & { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<unknown>(null)
  // Read again at every opening: the base may have changed since.
  const preview = useQuery({
    queryKey: ['imports', 'cancellation', batch.id],
    queryFn: ({ signal }) => previewCancellation(batch.id, signal),
    gcTime: 0,
    retry: false,
  })

  async function confirm() {
    setPending(true)
    setFailure(null)
    try {
      await cancelImport(batch.id)
    } catch (error) {
      setFailure(error)
      setPending(false)
      return
    }
    onClose()
    onCancelled?.()
    void refreshAfterWrite(queryClient, [[]])
  }

  const found = preview.data
  const removed = found
    ? [
        plural(found.prospects_deleted, 'prospect supprimé', 'prospects supprimés'),
        plural(found.companies_deleted, 'entreprise supprimée', 'entreprises supprimées'),
        found.additions_removed > 0 &&
          plural(found.additions_removed, 'ajout retiré des fiches existantes', 'ajouts retirés des fiches existantes'),
        found.fields_restored > 0 &&
          plural(found.fields_restored, 'champ remis à sa valeur d’avant', 'champs remis à leur valeur d’avant'),
      ].filter((line): line is string => typeof line === 'string')
    : []
  const kept = found
    ? [
        found.prospects_kept > 0 && plural(found.prospects_kept, 'prospect', 'prospects'),
        found.companies_kept > 0 && plural(found.companies_kept, 'entreprise', 'entreprises'),
      ].filter((line): line is string => typeof line === 'string')
    : []
  const error = failure ?? preview.error

  return (
    <Modal
      open
      onClose={onClose}
      title="Annuler cet import ?"
      description={`« ${batch.filename} » — cette suppression est définitive.`}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Garder l’import
          </Button>
          <Button variant="danger" loading={pending} disabled={!found} onClick={() => void confirm()}>
            Annuler l’import
          </Button>
        </>
      }
    >
      <div className="import-commit">
        {preview.isFetching && !found && (
          <p className="import-muted" role="status">
            <SpinnerIcon size={16} className="btn__spinner" /> Calcul de ce qui sera retiré…
          </p>
        )}
        {found && (
          <ul className="import-commit__summary" aria-label="Ce qui sera retiré">
            {removed.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
        {kept.length > 0 && (
          <p className="import-alert import-alert--warning">
            <AlertIcon size={18} />
            Conservé car modifié ou utilisé depuis l’import : {kept.join(' et ')}.
          </p>
        )}
        {error !== null && (
          <p className="import-alert import-alert--danger" role="alert">
            <AlertIcon size={18} />
            {importErrorMessage(error)}
          </p>
        )}
      </div>
    </Modal>
  )
}
