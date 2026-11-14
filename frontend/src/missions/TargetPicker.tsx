import { useState } from 'react'

import { useContextCandidates } from '../api/missionConfig'
import { type TargetOption, useMissionTargets } from '../api/missions'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { SearchField } from '../ui/SearchField'

function keyOf(target: TargetOption): string {
  return `${target.kind}:${target.id}`
}

// « + Ajouter des données »: the attachment-like picker of existing companies and prospects. What
// the mission keeps is a reference (`kind`, `id`), never a copy of the record. `mode="context"` is the same picker for
// the internal records linked as read-only context (searched through `/missions/context-candidates`): they inform the
// agent but are never what its tasks process.
export function TargetPicker({
  open,
  onClose,
  onAdd,
  mode = 'target',
}: {
  open: boolean
  onClose: () => void
  onAdd: (targets: TargetOption[]) => void
  mode?: 'target' | 'context'
}) {
  const [kind, setKind] = useState<'company' | 'prospect'>('company')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Record<string, TargetOption>>({})
  const targetResults = useMissionTargets(kind, search, open && mode === 'target')
  const contextResults = useContextCandidates(kind, search, open && mode === 'context')
  const results = mode === 'context' ? contextResults : targetResults

  const toggle = (target: TargetOption) => {
    const key = keyOf(target)
    setSelected((current) => {
      if (current[key]) {
        return Object.fromEntries(Object.entries(current).filter(([name]) => name !== key))
      }
      return { ...current, [key]: target }
    })
  }

  const close = () => {
    setSelected({})
    setSearch('')
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title={mode === 'context' ? 'Ajouter du contexte VIPER' : 'Ajouter des données'}
      description={
        mode === 'context'
          ? 'Choisissez des fiches VIPER qui aident l’agent à comprendre le sujet. Elles sont lues en lecture seule : l’agent ne les traite pas et ne les modifie pas.'
          : 'Choisissez des sociétés ou des prospects déjà dans VIPER. La mission gardera leur référence, pas une copie.'
      }
      footer={
        <div className="mission-picker__footer">
          <Button variant="secondary" onClick={close}>
            Annuler
          </Button>
          <Button
            variant="primary"
            disabled={Object.keys(selected).length === 0}
            onClick={() => {
              onAdd(Object.values(selected))
              close()
            }}
          >
            Ajouter ({String(Object.keys(selected).length)})
          </Button>
        </div>
      }
    >
      <div className="mission-picker">
        <div className="mission-picker__tabs" role="group" aria-label="Type de donnée">
          {(['company', 'prospect'] as const).map((value) => (
            <Button
              key={value}
              size="sm"
              variant={kind === value ? 'primary' : 'secondary'}
              aria-pressed={kind === value}
              onClick={() => {
                setKind(value)
                setSearch('')
              }}
            >
              {value === 'company' ? 'Sociétés' : 'Prospects'}
            </Button>
          ))}
        </div>
        <SearchField
          label={kind === 'company' ? 'Rechercher une société' : 'Rechercher un prospect'}
          value={search}
          onChange={setSearch}
        />
        {results.isLoading && <p className="missions-muted">Recherche…</p>}
        {results.isError && (
          <p className="missions-error" role="alert">
            La recherche a échoué : réessayez.
          </p>
        )}
        {results.data && results.data.length === 0 && (
          <p className="missions-muted">Aucun résultat. Essayez un autre mot.</p>
        )}
        <ul className="mission-picker__list">
          {(results.data ?? []).map((target) => {
            const checked = Boolean(selected[keyOf(target)])
            return (
              <li key={keyOf(target)}>
                <label className={`mission-picker__row${checked ? ' is-selected' : ''}`}>
                  <input type="checkbox" checked={checked} onChange={() => { toggle(target) }} />
                  <span className="mission-picker__label">{target.label}</span>
                  {target.hint && <span className="mission-picker__hint">{target.hint}</span>}
                </label>
              </li>
            )
          })}
        </ul>
      </div>
    </Modal>
  )
}
