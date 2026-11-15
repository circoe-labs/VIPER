import { useState } from 'react'

import { ApiError } from '../api/client'
import { type MissionSource, type TargetOption, useAddMissionSource, useMissionSources } from '../api/missions'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { TextField } from '../ui/fields'
import { BuildingIcon, CloseIcon, DatabaseIcon, LinkIcon, PencilIcon, PlusIcon, UsersIcon, WarehouseIcon } from '../ui/icons'
import { InfoTip } from '../ui/InfoTip'
import { SourceTreePicker } from './ConfigPickers'
import './configPickers.css'
import { InheritanceNote } from './InheritanceNote'
import { sourceName } from './sourceTree'
import { TargetPicker } from './TargetPicker'
import type { MissionFormApi } from './useMissionForm'

function recordKey(record: Pick<TargetOption, 'kind' | 'id'>): string {
  return `${record.kind}:${record.id}`
}

function RecordList({
  records,
  noun,
  onRemove,
  label,
}: {
  records: readonly TargetOption[]
  noun: string
  onRemove: (record: TargetOption) => void
  label: string
}) {
  if (records.length === 0) return null
  return (
    <ul className="mission-targets" aria-label={label}>
      {records.map((record) => {
        const KindIcon = record.kind === 'company' ? BuildingIcon : record.kind === 'warehouse' ? WarehouseIcon : UsersIcon
        return (
          <li key={recordKey(record)} className="mission-target">
            <span className="mission-target__icon" role="img" aria-label={record.kind === 'company' ? 'Société' : record.kind === 'warehouse' ? 'Entrepôt' : 'Prospect'}>
              <KindIcon size={14} />
            </span>
            <span className="mission-target__label">{record.label}</span>
            <button
              type="button"
              className="mission-target__remove"
              aria-label={`Retirer ${record.label} (${noun})`}
              onClick={() => {
                onRemove(record)
              }}
            >
              <CloseIcon size={14} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// « Sources » panel. Three distinct things, never mixed:
//   1. external research sources (websites the agent searches): the category's defaults until the mission picks its own;
//   2. internal VIPER records linked as read-only context (they inform the agent, they are not what it processes);
//   3. linked data = the targets (what the tasks are about).
export function MissionSourcesPanel({ form }: { form: MissionFormApi }) {
  const library = useMissionSources()
  const addSource = useAddMissionSource()
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [picking, setPicking] = useState(false)
  const { category, sourceIds } = form
  const inherited = sourceIds === null
  const defaults: { id: string; url: string; label: string | null }[] = category?.sources ?? []

  const customize = () => {
    form.setSourceIds(defaults.map((source) => source.id))
  }

  // Saves the link in VIPER's library (once) and uses it in this mission (which then has its own list).
  const saveSource = () => {
    if (url.trim() === '') return
    addSource.mutate(
      { url, label: label.trim() || null },
      {
        onSuccess: (saved) => {
          const current = sourceIds ?? defaults.map((source) => source.id)
          form.setSourceIds(current.includes(saved.id) ? current : [...current, saved.id])
          setUrl('')
          setLabel('')
        },
      },
    )
  }

  const add = (added: TargetOption[]) => {
    const seen = new Set(form.contextRefs.map(recordKey))
    form.setContextRefs([...form.contextRefs, ...added.filter((item) => !seen.has(recordKey(item))).map((item) => ({ ...item, note: null }))])
  }

  const libraryRows: MissionSource[] = library.data ?? []

  return (
    <div className="mission-form__panel">
      <section className="mission-form__section">
        <h3 className="mission-form__title">
          <LinkIcon size={18} /> Sources externes
          <InfoTip label="Aide : sources externes">
            Les sites que l’agent consulte pour sa recherche. Ils viennent de la bibliothèque de VIPER ; le chiffre est le
            nombre de résultats acceptés qu’une source a appuyés.
          </InfoTip>
        </h3>
        <InheritanceNote
          inherited={inherited}
          categoryName={category?.name}
          resetLabel="Revenir aux sources de la catégorie"
          onReset={() => {
            form.setSourceIds(null)
          }}
        />
        {inherited ? (
          <>
            {defaults.length > 0 ? (
              <ul className="cfg-chips" aria-label="Sources de la catégorie">
                {defaults.map((source) => (
                  <li key={source.id}>
                    <Badge>{sourceName(source)}</Badge>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="missions-muted">Cette catégorie n’a pas de source par défaut.</p>
            )}
            <div>
              <Button size="sm" icon={PencilIcon} onClick={customize}>
                Personnaliser les sources
              </Button>
            </div>
          </>
        ) : library.isPending ? (
          <p className="missions-muted">Chargement des sources…</p>
        ) : library.isError ? (
          <p className="missions-error" role="alert">
            La bibliothèque de sources n’a pas pu être chargée.
          </p>
        ) : (
          <SourceTreePicker sources={libraryRows} value={sourceIds} onChange={form.setSourceIds} />
        )}
        {!inherited && (
          <>
            <div className="mission-form__row">
              <TextField
                label="Nouveau lien"
                type="url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value)
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    saveSource()
                  }
                }}
                placeholder="https://…"
              />
              <TextField
                label="Nom (facultatif)"
                value={label}
                onChange={(event) => {
                  setLabel(event.target.value)
                }}
                placeholder="Annuaire des transporteurs"
              />
            </div>
            <div>
              <Button
                variant="secondary"
                size="sm"
                icon={PlusIcon}
                loading={addSource.isPending}
                disabled={url.trim() === '' || addSource.isPending}
                onClick={saveSource}
              >
                Enregistrer le lien
              </Button>
            </div>
            {addSource.isError && (
              <p className="missions-error" role="alert">
                {addSource.error instanceof ApiError ? addSource.error.message : 'Le lien n’a pas pu être enregistré.'}
              </p>
            )}
          </>
        )}
      </section>

      <section className="mission-form__section">
        <h3 className="mission-form__title">
          <DatabaseIcon size={18} /> Contexte VIPER{' '}
          <span className="mission-form__count">{form.contextRefs.length || ''}</span>
          <InfoTip label="Aide : contexte VIPER">
            Des sociétés, prospects ou entrepôts déjà dans VIPER qui aident l’agent à comprendre le sujet. Il les lit,
            sans les traiter ni les modifier.
          </InfoTip>
        </h3>
        <RecordList
          records={form.contextRefs}
          noun="contexte"
          label="Contexte VIPER lié"
          onRemove={(record) => {
            form.setContextRefs(form.contextRefs.filter((item) => recordKey(item) !== recordKey(record)))
          }}
        />
        <div>
          <Button
            variant="secondary"
            size="sm"
            icon={PlusIcon}
            onClick={() => {
              setPicking(true)
            }}
          >
            Ajouter du contexte
          </Button>
        </div>
      </section>

      <TargetPicker
        open={picking}
        mode="context"
        onClose={() => {
          setPicking(false)
        }}
        onAdd={add}
      />
    </div>
  )
}
