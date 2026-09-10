import { type SubmitEvent, useState } from 'react'
import { flushSync } from 'react-dom'

import {
  type ActiveFilter,
  settingsRefusal,
  type TaxonomyKind,
  type TaxonomyValue,
  useTaxonomyMutations,
  useTaxonomyValues,
} from '../api/settings'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { TextField } from '../ui/fields'
import { AlertIcon, BanIcon, CheckIcon, PencilIcon, PlusIcon, RefreshIcon, SlidersIcon, TrashIcon } from '../ui/icons'
import { Table } from '../ui/Table'
import { settingsErrorMessage } from './messages'
import {
  ActiveBadge,
  DeleteDialog,
  type Feedback,
  FeedbackBanner,
  ListToolbar,
  UsageCell,
  useDebouncedValue,
} from './shared'

export interface TaxonomySectionConfig {
  kind: TaxonomyKind
  title: string
  description: string
  // "Nouveau rôle", "Rechercher un rôle", "Aucun rôle pour l’instant"…
  addLabel: string
  placeholder: string
  searchLabel: string
  // Accessible name of the table ("Liste des rôles").
  listLabel: string
  emptyTitle: string
  // What references a value: prospects (roles) or companies (segments, categories).
  usageNoun: 'prospects' | 'companies'
}

type Mutations = ReturnType<typeof useTaxonomyMutations>

// One taxonomy: add, search/filter, rename inline, deactivate/reactivate, delete when unused.
export function TaxonomySection({ config }: { config: TaxonomySectionConfig }) {
  const [search, setSearch] = useState('')
  const [active, setActive] = useState<ActiveFilter>('all')
  const debouncedSearch = useDebouncedValue(search, 250)
  const values = useTaxonomyValues(config.kind, { search: debouncedSearch.trim(), active })
  const mutations = useTaxonomyMutations(config.kind)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<TaxonomyValue | null>(null)
  const filtered = debouncedSearch.trim() !== '' || active !== 'all'

  function stopEditing(id: string) {
    flushSync(() => {
      setEditingId(null)
    })
    document.getElementById(renameButtonId(id))?.focus()
  }

  function toggleActive(value: TaxonomyValue) {
    mutations.setActive.mutate(
      { id: value.id, active: !value.active },
      {
        onSuccess: (updated) => {
          setFeedback({
            tone: 'success',
            text: `« ${updated.label} » ${updated.active ? 'réactivé' : 'désactivé'}.`,
          })
        },
        onError: (error) => {
          setFeedback({ tone: 'error', text: settingsErrorMessage(error, value.label) })
        },
      },
    )
  }

  function confirmDelete(value: TaxonomyValue) {
    mutations.remove.mutate(value.id, {
      onSuccess: () => {
        setDeleting(null)
        setFeedback({ tone: 'success', text: `« ${value.label} » supprimé.` })
      },
    })
  }

  return (
    <>
      <header className="settings-panel__header">
        <div>
          <h2 className="settings-panel__title">{config.title}</h2>
          <p className="settings-panel__description">{config.description}</p>
        </div>
      </header>

      <AddValueForm
        config={config}
        mutations={mutations}
        onDone={(text) => {
          setFeedback({ tone: 'success', text })
        }}
      />

      <ListToolbar
        searchLabel={config.searchLabel}
        search={search}
        onSearch={setSearch}
        active={active}
        onActive={setActive}
        count={values.data?.length}
      />
      <FeedbackBanner feedback={feedback} />

      {values.isPending && <p className="settings-state">Chargement…</p>}
      {values.isError && (
        <div className="settings-state settings-state--error" role="alert">
          <AlertIcon size={18} />
          Liste indisponible.
          <Button size="sm" onClick={() => void values.refetch()}>
            Réessayer
          </Button>
        </div>
      )}
      {values.data?.length === 0 &&
        (filtered ? (
          <p className="settings-state">Aucune valeur ne correspond à ces critères.</p>
        ) : (
          <EmptyState
            icon={SlidersIcon}
            title={config.emptyTitle}
            description="Ajoutez la première valeur ci-dessus. Les formulaires pourront aussi en créer à la volée."
          />
        ))}
      {values.data && values.data.length > 0 && (
        <Table caption={config.listLabel}>
          <thead>
            <tr>
              <th scope="col">Libellé</th>
              <th scope="col">Utilisation</th>
              <th scope="col">Statut</th>
              <th scope="col" className="settings-table__actions-head">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {values.data.map((value) => (
              <tr key={value.id} data-inactive={value.active ? undefined : ''}>
                <td className="settings-table__label">
                  {editingId === value.id ? (
                    <RenameForm
                      value={value}
                      mutations={mutations}
                      onDone={(text) => {
                        if (text) setFeedback({ tone: 'success', text })
                        stopEditing(value.id)
                      }}
                    />
                  ) : (
                    value.label
                  )}
                </td>
                <td className="settings-table__nowrap">
                  <UsageCell count={value.usage_count} noun={config.usageNoun} />
                </td>
                <td className="settings-table__nowrap">
                  <ActiveBadge active={value.active} />
                </td>
                <td className="settings-table__actions-cell">
                  <div className="settings-table__actions">
                    <Button
                      id={renameButtonId(value.id)}
                      size="sm"
                      variant="ghost"
                      icon={PencilIcon}
                      aria-label={`Renommer « ${value.label} »`}
                      disabled={editingId === value.id}
                      onClick={() => {
                        setEditingId(value.id)
                      }}
                    >
                      Renommer
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={value.active ? BanIcon : RefreshIcon}
                      aria-label={`${value.active ? 'Désactiver' : 'Réactiver'} « ${value.label} »`}
                      loading={mutations.setActive.isPending && mutations.setActive.variables.id === value.id}
                      onClick={() => {
                        toggleActive(value)
                      }}
                    >
                      {value.active ? 'Désactiver' : 'Réactiver'}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={TrashIcon}
                      aria-label={`Supprimer « ${value.label} »`}
                      onClick={() => {
                        mutations.remove.reset()
                        setDeleting(value)
                      }}
                    >
                      Supprimer
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {deleting && (
        <DeleteDialog
          name={deleting.label}
          usageCount={deleting.usage_count}
          usageNoun={config.usageNoun}
          active={deleting.active}
          error={mutations.remove.error}
          deleting={mutations.remove.isPending}
          onDelete={() => {
            confirmDelete(deleting)
          }}
          onDeactivate={() => {
            setDeleting(null)
            toggleActive(deleting)
          }}
          onClose={() => {
            setDeleting(null)
          }}
        />
      )}
    </>
  )
}

function renameButtonId(id: string) {
  return `settings-rename-${id}`
}

interface AddValueFormProps {
  config: TaxonomySectionConfig
  mutations: Mutations
  onDone: (text: string) => void
}

function AddValueForm({ config, mutations, onDone }: AddValueFormProps) {
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [inactiveTwin, setInactiveTwin] = useState<{ id: string; label: string } | null>(null)

  function submit(event: SubmitEvent) {
    event.preventDefault()
    setInactiveTwin(null)
    if (!label.trim()) {
      setError('Saisissez un libellé.')
      return
    }
    mutations.create.mutate(label, {
      onSuccess: (created) => {
        setLabel('')
        setError(null)
        onDone(`« ${created.label} » ajouté.`)
      },
      onError: (caught) => {
        setError(settingsErrorMessage(caught))
        const existing = settingsRefusal(caught)?.existing
        if (existing && !existing.active) setInactiveTwin(existing)
      },
    })
  }

  function reactivate(twin: { id: string; label: string }) {
    mutations.setActive.mutate(
      { id: twin.id, active: true },
      {
        onSuccess: () => {
          setLabel('')
          setError(null)
          setInactiveTwin(null)
          onDone(`« ${twin.label} » réactivé.`)
        },
        onError: (caught) => {
          setError(settingsErrorMessage(caught, twin.label))
        },
      },
    )
  }

  return (
    <form className="settings-add" aria-label={config.addLabel} onSubmit={submit} noValidate>
      <TextField
        label={config.addLabel}
        placeholder={config.placeholder}
        value={label}
        maxLength={255}
        hint="Les doublons sont refusés sans tenir compte des majuscules, des accents ni des espaces."
        error={error}
        onChange={(event) => {
          setLabel(event.target.value)
          setError(null)
          setInactiveTwin(null)
        }}
      />
      <div className="settings-add__actions">
        {inactiveTwin && (
          <Button
            icon={RefreshIcon}
            loading={mutations.setActive.isPending}
            onClick={() => {
              reactivate(inactiveTwin)
            }}
          >
            Réactiver « {inactiveTwin.label} »
          </Button>
        )}
        <Button type="submit" variant="primary" icon={PlusIcon} loading={mutations.create.isPending}>
          Ajouter
        </Button>
      </div>
    </form>
  )
}

interface RenameFormProps {
  value: TaxonomyValue
  mutations: Mutations
  // Called with a confirmation text after a rename, or null when cancelled / unchanged.
  onDone: (text: string | null) => void
}

// Inline rename in the label cell: Enter saves, Esc cancels. Only the label changes; the value keeps its id.
function RenameForm({ value, mutations, onDone }: RenameFormProps) {
  const [label, setLabel] = useState(value.label)
  const [error, setError] = useState<string | null>(null)

  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!label.trim()) {
      setError('Saisissez un libellé.')
      return
    }
    if (label.trim() === value.label) {
      onDone(null)
      return
    }
    mutations.rename.mutate(
      { id: value.id, label },
      {
        onSuccess: (renamed) => {
          onDone(`« ${value.label} » renommé en « ${renamed.label} ».`)
        },
        onError: (caught) => {
          setError(settingsErrorMessage(caught))
        },
      },
    )
  }

  return (
    <form
      className="settings-rename"
      onSubmit={submit}
      noValidate
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          onDone(null)
        }
      }}
    >
      <TextField
        label={`Nouveau libellé pour « ${value.label} »`}
        className="settings-rename__input"
        value={label}
        maxLength={255}
        error={error}
        autoFocus
        onChange={(event) => {
          setLabel(event.target.value)
          setError(null)
        }}
      />
      <div className="settings-rename__actions">
        <Button type="submit" size="sm" variant="primary" icon={CheckIcon} loading={mutations.rename.isPending}>
          Enregistrer
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onDone(null)
          }}
        >
          Annuler
        </Button>
      </div>
    </form>
  )
}
