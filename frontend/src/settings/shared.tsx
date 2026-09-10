import { type ReactNode, useEffect, useState } from 'react'

import type { ActiveFilter } from '../api/settings'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { AlertIcon, CheckCircleIcon } from '../ui/icons'
import { SearchField } from '../ui/SearchField'
import { settingsErrorMessage, usageText } from './messages'

// Building blocks shared by the taxonomy and referent sections of the Settings page.

export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebounced(value)
    }, delay)
    return () => {
      window.clearTimeout(timer)
    }
  }, [value, delay])
  return debounced
}

const ACTIVE_FILTERS: { value: ActiveFilter; label: string }[] = [
  { value: 'all', label: 'Tous' },
  { value: 'active', label: 'Actifs' },
  { value: 'inactive', label: 'Inactifs' },
]

interface ListToolbarProps {
  searchLabel: string
  search: string
  onSearch: (value: string) => void
  active: ActiveFilter
  onActive: (value: ActiveFilter) => void
  count: number | undefined
}

// Search box (every word, case and accents ignored — done by the API) + status filter + result count.
export function ListToolbar({ searchLabel, search, onSearch, active, onActive, count }: ListToolbarProps) {
  return (
    <div className="settings-toolbar">
      <SearchField label={searchLabel} value={search} onChange={onSearch} />
      <fieldset className="segmented">
        <legend className="visually-hidden">Filtrer par statut</legend>
        {ACTIVE_FILTERS.map((filter) => (
          <label key={filter.value} className="segmented__option">
            <input
              type="radio"
              className="visually-hidden"
              name={`${searchLabel}-statut`}
              value={filter.value}
              checked={active === filter.value}
              onChange={() => {
                onActive(filter.value)
              }}
            />
            {filter.label}
          </label>
        ))}
      </fieldset>
      {count !== undefined && (
        <p className="settings-toolbar__count" aria-live="polite">
          {count} {count > 1 ? 'résultats' : 'résultat'}
        </p>
      )}
    </div>
  )
}

export function ActiveBadge({ active }: { active: boolean }) {
  return active ? <StatusBadge tone="success">Actif</StatusBadge> : <StatusBadge tone="neutral">Inactif</StatusBadge>
}

export function UsageCell({ count, noun }: { count: number; noun: string }) {
  return count > 0 ? (
    <>{usageText(count, noun)}</>
  ) : (
    <span className="settings-table__muted">Non utilisé</span>
  )
}

export interface Feedback {
  tone: 'success' | 'error'
  text: string
}

// Result of the last row action. The status region stays mounted so screen readers announce each change.
export function FeedbackBanner({ feedback }: { feedback: Feedback | null }) {
  return (
    <div role="status" className="settings-feedback-region">
      {feedback && (
        <p className={`settings-feedback settings-feedback--${feedback.tone}`}>
          {feedback.tone === 'success' ? <CheckCircleIcon size={18} /> : <AlertIcon size={18} />}
          {feedback.text}
        </p>
      )}
    </div>
  )
}

interface DeleteDialogProps {
  // Name of the value, and what references it (0 = deletable).
  name: string
  usageCount: number
  usageNoun: string
  active: boolean
  // Error of the last attempt (e.g. a reference added meanwhile).
  error: unknown
  deleting: boolean
  onDelete: () => void
  onDeactivate: () => void
  onClose: () => void
}

// Confirms a deletion, or explains why it is impossible and offers deactivation instead.
export function DeleteDialog(props: DeleteDialogProps) {
  const { name, usageCount, usageNoun, active, error, deleting, onDelete, onDeactivate, onClose } = props
  const inUse = usageCount > 0
  let body: ReactNode
  if (inUse) {
    body = (
      <p>
        « {name} » est utilisé par {usageText(usageCount, usageNoun)}. Une valeur utilisée ne peut pas être supprimée :{' '}
        {active
          ? 'désactivez-la pour la retirer des listes de choix ; les fiches existantes la conservent.'
          : 'elle est déjà désactivée et n’apparaît plus dans les listes de choix.'}
      </p>
    )
  } else {
    body = (
      <p>
        « {name} » n’est utilisé par aucune fiche. La suppression est définitive ; elle reste tracée dans l’historique.
      </p>
    )
  }
  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title={inUse ? 'Suppression impossible' : `Supprimer « ${name} » ?`}
      footer={
        <>
          <Button onClick={onClose}>{inUse && !active ? 'Fermer' : 'Annuler'}</Button>
          {inUse && active && (
            <Button variant="primary" onClick={onDeactivate}>
              Désactiver
            </Button>
          )}
          {!inUse && (
            <Button variant="danger" loading={deleting} onClick={onDelete}>
              Supprimer
            </Button>
          )}
        </>
      }
    >
      <div className="settings-dialog">
        {body}
        {error !== null && (
          <p className="settings-feedback settings-feedback--error" role="alert">
            <AlertIcon size={18} />
            {settingsErrorMessage(error, name)}
          </p>
        )}
      </div>
    </Modal>
  )
}
