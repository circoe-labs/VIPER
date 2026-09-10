import { type DeleteCheck, type ExplorerTable, useDeleteCheck } from '../api/explorer'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { AlertIcon, BanIcon, InfoIcon, TrashIcon } from '../ui/icons'
import { clipboardValue, compactUuid } from './cells'
import type { SourceRow } from './staging'
import { tableLabel } from './tableCatalog'

interface DeleteRowsDialogProps {
  meta: ExplorerTable
  rows: SourceRow[]
  onConfirm: () => void
  onClose: () => void
}

function tableName(table: string | null): string {
  if (table === null) return 'données non exposées'
  const label = tableLabel(table)
  return label ? `${table} (${label})` : table
}

const lines = (count: number) => `${String(count)} ligne${count > 1 ? 's' : ''}`

export function effectText(effect: DeleteCheck['effects'][number]): string {
  const where = tableName(effect.table)
  const chain = effect.depth > 1 ? ' (par cascade)' : ''
  switch (effect.action) {
    case 'cascade':
      return `Supprime aussi ${lines(effect.count)} de ${where}${chain}.`
    case 'set_null':
      return `Vide ${effect.column ?? 'la référence'} dans ${lines(effect.count)} de ${where}${chain}.`
    case 'restrict':
      return `${lines(effect.count)} de ${where} y font référence${chain}.`
  }
}

// Confirms a deletion after asking the server what it would block or cascade. Confirming stages the deletion; it is
// applied with the other pending changes by "Enregistrer".
export function DeleteRowsDialog({ meta, rows, onConfirm, onClose }: DeleteRowsDialogProps) {
  const check = useDeleteCheck(
    meta.name,
    rows.map((row) => row.key),
  )
  const data = check.data
  const effects = (data?.effects ?? []).filter((effect) => effect.action !== 'restrict')
  const cascades = effects.some((effect) => effect.action === 'cascade')
  const title = rows.length === 1 ? `Supprimer cette ligne de ${meta.name} ?` : `Supprimer ${String(rows.length)} lignes de ${meta.name} ?`

  return (
    <Modal
      open
      size="md"
      title={title}
      description="La suppression sera appliquée avec les autres modifications, à l’enregistrement. D’ici là, vous pouvez l’annuler."
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuler
          </Button>
          <Button variant="danger" icon={TrashIcon} disabled={!data?.allowed} onClick={onConfirm}>
            {cascades ? 'Supprimer avec les lignes liées' : 'Marquer pour suppression'}
          </Button>
        </>
      }
    >
      <div className="delete-check">
        <ul className="delete-check__rows" aria-label="Lignes à supprimer">
          {rows.slice(0, 5).map((row) => (
            <li key={row.id}>
              {meta.label_columns
                .map((name) => clipboardValue(row.original[name]))
                .filter(Boolean)
                .join(' ') || meta.name}
              <code>{meta.primary_key.map((name) => compactUuid(clipboardValue(row.key[name]))).join(' · ')}</code>
            </li>
          ))}
          {rows.length > 5 && <li>… et {rows.length - 5} autre(s)</li>}
        </ul>
        {check.isPending && <p className="delete-check__note">Vérification des dépendances…</p>}
        {check.isError && (
          <p className="delete-check__note delete-check__note--error">
            <AlertIcon size={16} /> Impossible de vérifier les dépendances : réessayez plus tard.
          </p>
        )}
        {data && data.blockers.length > 0 && (
          <div className="delete-check__blockers" role="alert">
            <p className="delete-check__heading">
              <BanIcon size={16} /> Suppression impossible
            </p>
            <ul>
              {data.blockers.map((blocker) => (
                <li key={blocker}>{blocker}</li>
              ))}
            </ul>
          </div>
        )}
        {data?.allowed && effects.length > 0 && (
          <div className="delete-check__effects">
            <p className="delete-check__heading">
              <AlertIcon size={16} /> Effets en cascade
            </p>
            <ul>
              {effects.map((effect) => (
                <li key={`${effect.table ?? ''}-${effect.column ?? ''}-${String(effect.depth)}`}>{effectText(effect)}</li>
              ))}
            </ul>
            {cascades && (
              <p className="delete-check__note">
                <InfoIcon size={16} /> Seule la suppression de la ligne principale est inscrite au journal d’audit ; les
                lignes supprimées en cascade disparaissent avec elle.
              </p>
            )}
          </div>
        )}
        {data?.allowed && effects.length === 0 && <p className="delete-check__note">Aucune autre ligne n’est touchée.</p>}
      </div>
    </Modal>
  )
}
