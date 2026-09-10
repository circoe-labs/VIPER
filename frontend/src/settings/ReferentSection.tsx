import { type SubmitEvent, useRef, useState } from 'react'

import {
  type ActiveFilter,
  type Referent,
  type ReferentInput,
  referentName,
  settingsRefusal,
  useReferentMutations,
  useReferents,
} from '../api/settings'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { TextField } from '../ui/fields'
import { AlertIcon, BanIcon, PencilIcon, PlusIcon, RefreshIcon, TrashIcon, UsersIcon } from '../ui/icons'
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

// Same rule as the backend (app/services/referents.py): something@domain.tld, no spaces.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const USAGE_NOUN = 'contact_trackings'

// Circoe internal referents: people who take over a meeting or dossier. Business records, not login accounts.
export function ReferentSection() {
  const [search, setSearch] = useState('')
  const [active, setActive] = useState<ActiveFilter>('all')
  const debouncedSearch = useDebouncedValue(search, 250)
  const referents = useReferents({ search: debouncedSearch.trim(), active })
  const mutations = useReferentMutations()
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  // null: closed; 'new': creation; a referent: edition.
  const [editing, setEditing] = useState<Referent | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Referent | null>(null)
  const filtered = debouncedSearch.trim() !== '' || active !== 'all'

  function toggleActive(referent: Referent) {
    mutations.setActive.mutate(
      { id: referent.id, active: !referent.active },
      {
        onSuccess: (updated) => {
          setFeedback({
            tone: 'success',
            text: `« ${referentName(updated)} » ${updated.active ? 'réactivé' : 'désactivé'}.`,
          })
        },
        onError: (error) => {
          setFeedback({ tone: 'error', text: settingsErrorMessage(error, referentName(referent)) })
        },
      },
    )
  }

  return (
    <>
      <header className="settings-panel__header">
        <div>
          <h2 className="settings-panel__title">Référents internes</h2>
          <p className="settings-panel__description">
            Personnes Circoe qui reprennent un rendez-vous ou un dossier, choisies dans le suivi de contact. Ce ne sont
            pas des comptes de connexion à VIPER.
          </p>
        </div>
        <Button
          variant="primary"
          icon={PlusIcon}
          onClick={() => {
            setEditing('new')
          }}
        >
          Ajouter un référent
        </Button>
      </header>

      <ListToolbar
        searchLabel="Rechercher un référent"
        search={search}
        onSearch={setSearch}
        active={active}
        onActive={setActive}
        count={referents.data?.length}
      />
      <FeedbackBanner feedback={feedback} />

      {referents.isPending && <p className="settings-state">Chargement…</p>}
      {referents.isError && (
        <div className="settings-state settings-state--error" role="alert">
          <AlertIcon size={18} />
          Liste indisponible.
          <Button size="sm" onClick={() => void referents.refetch()}>
            Réessayer
          </Button>
        </div>
      )}
      {referents.data?.length === 0 &&
        (filtered ? (
          <p className="settings-state">Aucun référent ne correspond à ces critères.</p>
        ) : (
          <EmptyState
            icon={UsersIcon}
            title="Aucun référent pour l’instant"
            description="Ajoutez les personnes Circoe qui reprennent les rendez-vous obtenus."
          />
        ))}
      {referents.data && referents.data.length > 0 && (
        <Table caption="Liste des référents internes">
          <thead>
            <tr>
              <th scope="col">Nom</th>
              <th scope="col">Adresse e-mail</th>
              <th scope="col">Utilisation</th>
              <th scope="col">Statut</th>
              <th scope="col" className="settings-table__actions-head">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {referents.data.map((referent) => {
              const name = referentName(referent)
              return (
                <tr key={referent.id} data-inactive={referent.active ? undefined : ''}>
                  <td className="settings-table__label">{name}</td>
                  <td className="settings-table__nowrap">
                    {referent.email ?? <span className="settings-table__muted">Non renseignée</span>}
                  </td>
                  <td className="settings-table__nowrap">
                    <UsageCell count={referent.usage_count} noun={USAGE_NOUN} />
                  </td>
                  <td className="settings-table__nowrap">
                    <ActiveBadge active={referent.active} />
                  </td>
                  <td className="settings-table__actions-cell">
                    <div className="settings-table__actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={PencilIcon}
                        aria-label={`Modifier « ${name} »`}
                        onClick={() => {
                          setEditing(referent)
                        }}
                      >
                        Modifier
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={referent.active ? BanIcon : RefreshIcon}
                        aria-label={`${referent.active ? 'Désactiver' : 'Réactiver'} « ${name} »`}
                        loading={mutations.setActive.isPending && mutations.setActive.variables.id === referent.id}
                        onClick={() => {
                          toggleActive(referent)
                        }}
                      >
                        {referent.active ? 'Désactiver' : 'Réactiver'}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={TrashIcon}
                        aria-label={`Supprimer « ${name} »`}
                        onClick={() => {
                          mutations.remove.reset()
                          setDeleting(referent)
                        }}
                      >
                        Supprimer
                      </Button>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </Table>
      )}

      {editing && (
        <ReferentDialog
          referent={editing === 'new' ? null : editing}
          mutations={mutations}
          onClose={() => {
            setEditing(null)
          }}
          onSaved={(text) => {
            setEditing(null)
            setFeedback({ tone: 'success', text })
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          name={referentName(deleting)}
          usageCount={deleting.usage_count}
          usageNoun={USAGE_NOUN}
          active={deleting.active}
          error={mutations.remove.error}
          deleting={mutations.remove.isPending}
          onDelete={() => {
            mutations.remove.mutate(deleting.id, {
              onSuccess: () => {
                setDeleting(null)
                setFeedback({ tone: 'success', text: `« ${referentName(deleting)} » supprimé.` })
              },
            })
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

type FieldErrors = Partial<Record<keyof ReferentInput | 'form', string>>

function validate(input: ReferentInput): FieldErrors {
  const errors: FieldErrors = {}
  if (!input.first_name.trim()) errors.first_name = 'Saisissez le prénom.'
  if (!input.last_name.trim()) errors.last_name = 'Saisissez le nom.'
  if (input.email && !EMAIL_PATTERN.test(input.email)) errors.email = 'Adresse e-mail invalide.'
  return errors
}

// Server refusal → the field it concerns (duplicate name → last name, duplicate/invalid e-mail → e-mail).
function refusalErrors(error: unknown): FieldErrors {
  const refusal = settingsRefusal(error)
  const message = settingsErrorMessage(error)
  if (refusal?.field === 'email') return { email: message }
  if (refusal?.field === 'first_name') return { first_name: message }
  if (refusal?.field === 'name' || refusal?.field === 'last_name') return { last_name: message }
  return { form: message }
}

interface ReferentDialogProps {
  referent: Referent | null
  mutations: ReturnType<typeof useReferentMutations>
  onClose: () => void
  onSaved: (text: string) => void
}

function ReferentDialog({ referent, mutations, onClose, onSaved }: ReferentDialogProps) {
  const firstFieldRef = useRef<HTMLInputElement>(null)
  const [input, setInput] = useState<ReferentInput>({
    first_name: referent?.first_name ?? '',
    last_name: referent?.last_name ?? '',
    email: referent?.email ?? '',
  })
  const [errors, setErrors] = useState<FieldErrors>({})
  const saving = mutations.create.isPending || mutations.update.isPending

  function change(field: keyof ReferentInput, value: string) {
    setInput((current) => ({ ...current, [field]: value }))
    setErrors((current) => ({ ...current, [field]: undefined, form: undefined }))
  }

  function submit(event: SubmitEvent) {
    event.preventDefault()
    const body = { ...input, email: input.email?.trim() || null }
    const found = validate(body)
    setErrors(found)
    if (Object.keys(found).length > 0) return
    const handlers = {
      onSuccess: (saved: Referent) => {
        onSaved(`« ${referentName(saved)} » ${referent ? 'modifié' : 'ajouté'}.`)
      },
      onError: (error: unknown) => {
        setErrors(refusalErrors(error))
      },
    }
    if (referent) mutations.update.mutate({ id: referent.id, input: body }, handlers)
    else mutations.create.mutate(body, handlers)
  }

  const formId = 'settings-referent-form'
  return (
    <Modal
      open
      onClose={onClose}
      title={referent ? `Modifier « ${referentName(referent)} »` : 'Ajouter un référent'}
      description="Personne Circoe nommée sur le suivi de contact. L’adresse e-mail est facultative."
      initialFocusRef={firstFieldRef}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button type="submit" form={formId} variant="primary" loading={saving}>
            Enregistrer
          </Button>
        </>
      }
    >
      <form id={formId} className="settings-dialog settings-dialog--form" onSubmit={submit} noValidate>
        <TextField
          ref={firstFieldRef}
          label="Prénom"
          required
          maxLength={100}
          autoComplete="off"
          value={input.first_name}
          error={errors.first_name}
          onChange={(event) => {
            change('first_name', event.target.value)
          }}
        />
        <TextField
          label="Nom"
          required
          maxLength={100}
          autoComplete="off"
          value={input.last_name}
          error={errors.last_name}
          onChange={(event) => {
            change('last_name', event.target.value)
          }}
        />
        <TextField
          label="Adresse e-mail"
          type="email"
          maxLength={320}
          autoComplete="off"
          hint="Facultative."
          value={input.email ?? ''}
          error={errors.email}
          onChange={(event) => {
            change('email', event.target.value)
          }}
        />
        {errors.form && (
          <p className="settings-feedback settings-feedback--error" role="alert">
            <AlertIcon size={18} />
            {errors.form}
          </p>
        )}
      </form>
    </Modal>
  )
}
