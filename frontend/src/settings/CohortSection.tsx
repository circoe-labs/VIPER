import { type SubmitEvent, useRef, useState } from 'react'

import {
  type Cohort,
  MAX_FOLLOW_UPS_LIMIT,
  settingsRefusal,
  useCohortMutations,
  useCohorts,
  useContactSettings,
  useContactSettingsMutation,
} from '../api/settings'
import { formatDay } from '../prospection/labels'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { EmptyState } from '../ui/EmptyState'
import { TextField } from '../ui/fields'
import { AlertIcon, CalendarIcon, ClockIcon, LockIcon, PencilIcon, PlusIcon, TrashIcon } from '../ui/icons'
import { Table } from '../ui/Table'
import { type Feedback, FeedbackBanner } from './shared'

// French copy of the cohort and « max relances » refusals (backend app/services/cohorts.py, app_settings.py).
export function cohortErrorMessage(error: unknown, subject?: string): string {
  const refusal = settingsRefusal(error)
  switch (refusal?.code) {
    case 'duplicate':
      return `La cohorte « ${refusal.existing?.label ?? subject ?? ''} » existe déjà : un code est unique. Pour le réutiliser, renommez d’abord l’ancienne.`
    case 'invalid':
      if (refusal.field === 'code') return 'Code attendu : S suivi d’un numéro (ex. S41). Ce n’est pas une semaine ISO.'
      if (refusal.field === 'starts_on') return 'Indiquez la date réelle du premier envoi de la cohorte.'
      if (refusal.field === 'max_follow_ups') return `Nombre de relances entre 0 et ${String(MAX_FOLLOW_UPS_LIMIT)}.`
      return 'Valeur invalide.'
    case 'in_use': {
      const count = refusal.usage?.sequences ?? 0
      return `Suppression impossible : « ${subject ?? 'cette cohorte'} » a servi à ${String(count)} séquence${count > 1 ? 's' : ''}. Une cohorte utilisée reste, avec son historique.`
    }
    case 'cohort_s0_fixed':
      return 'S0 est la cohorte fixe « validé hors campagne » : elle ne se renomme, ne se date ni ne se supprime.'
    case 'not_found':
      return 'Cette cohorte n’existe plus : la liste a été actualisée.'
    case 'human_actor_required':
      return 'Seule une personne connectée peut modifier les cohortes.'
    default:
      return 'L’opération a échoué. Vérifiez la connexion puis réessayez.'
  }
}

// Cohortes (sequences rework D2, D5): the prospecting sessions `Sxx` with their real start date — never an ISO week —
// and « max relances ». S0 (validated, out of campaign) is fixed. A cohort created by the migration from a former week
// is « à confirmer » until a person dates or renames it. A used cohort cannot be deleted.
export function CohortSection() {
  const cohorts = useCohorts()
  const mutations = useCohortMutations()
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [editing, setEditing] = useState<Cohort | 'new' | null>(null)
  const [deleting, setDeleting] = useState<Cohort | null>(null)

  return (
    <>
      <header className="settings-panel__header">
        <div>
          <h2 className="settings-panel__title">Cohortes et relances</h2>
          <p className="settings-panel__description">
            Une cohorte Sxx est une session de prospection avec la date réelle de son premier envoi (S39 peut commencer le
            28 septembre : ce n’est pas une semaine ISO). Le Contact d’un prospect est dû à cette date, chaque relance la
            semaine qui suit l’envoi précédent. S0 : validé mais hors campagne.
          </p>
        </div>
        <Button
          variant="primary"
          icon={PlusIcon}
          onClick={() => {
            mutations.create.reset()
            setEditing('new')
          }}
        >
          Ajouter une cohorte
        </Button>
      </header>

      <MaxFollowUps onSaved={setFeedback} />
      <FeedbackBanner feedback={feedback} />

      {cohorts.isPending && <p className="settings-state">Chargement…</p>}
      {cohorts.isError && (
        <div className="settings-state settings-state--error" role="alert">
          <AlertIcon size={18} />
          Liste indisponible.
          <Button size="sm" onClick={() => void cohorts.refetch()}>
            Réessayer
          </Button>
        </div>
      )}
      {cohorts.data?.length === 0 && (
        <EmptyState
          icon={CalendarIcon}
          title="Aucune cohorte pour l’instant"
          description="Ajoutez la première session de prospection avec la date réelle de son premier envoi."
        />
      )}
      {cohorts.data && cohorts.data.length > 0 && (
        <Table caption="Liste des cohortes">
          <thead>
            <tr>
              <th scope="col">Cohorte</th>
              <th scope="col">Premier envoi</th>
              <th scope="col">Prospects en cours</th>
              <th scope="col">Séquences</th>
              <th scope="col">Statut</th>
              <th scope="col" className="settings-table__actions-head">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {cohorts.data.map((cohort) => (
              <tr key={cohort.id}>
                <td className="settings-table__label">{cohort.code}</td>
                <td className="settings-table__nowrap">
                  {cohort.starts_on ? formatDay(cohort.starts_on) : <span className="settings-table__muted">Sans date</span>}
                </td>
                <td className="settings-table__nowrap">{cohort.current_count}</td>
                <td className="settings-table__nowrap">{cohort.sequence_count}</td>
                <td className="settings-table__nowrap">
                  <CohortStatus cohort={cohort} />
                </td>
                <td className="settings-table__actions-cell">
                  {!cohort.out_of_campaign && (
                    <div className="settings-table__actions">
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={PencilIcon}
                        aria-label={`Modifier « ${cohort.code} »`}
                        onClick={() => {
                          mutations.update.reset()
                          setEditing(cohort)
                        }}
                      >
                        Modifier
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={TrashIcon}
                        aria-label={`Supprimer « ${cohort.code} »`}
                        onClick={() => {
                          mutations.remove.reset()
                          setDeleting(cohort)
                        }}
                      >
                        Supprimer
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {editing && (
        <CohortDialog
          cohort={editing === 'new' ? null : editing}
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
        <DeleteCohortDialog
          cohort={deleting}
          error={mutations.remove.error}
          deleting={mutations.remove.isPending}
          onDelete={() => {
            mutations.remove.mutate(deleting.id, {
              onSuccess: () => {
                setDeleting(null)
                setFeedback({ tone: 'success', text: `Cohorte « ${deleting.code} » supprimée.` })
              },
            })
          }}
          onClose={() => {
            setDeleting(null)
          }}
        />
      )}
    </>
  )
}

function CohortStatus({ cohort }: { cohort: Cohort }) {
  if (cohort.out_of_campaign) {
    return (
      <StatusBadge tone="neutral" icon={LockIcon}>
        Hors campagne · fixe
      </StatusBadge>
    )
  }
  if (cohort.needs_review) {
    return (
      <StatusBadge tone="warning" icon={ClockIcon}>
        Date à confirmer
      </StatusBadge>
    )
  }
  return <StatusBadge tone="success">Datée</StatusBadge>
}

// « Max relances » (D2): after R<max> is sent, the prospect is « Relance terminée ».
function MaxFollowUps({ onSaved }: { onSaved: (feedback: Feedback) => void }) {
  const settings = useContactSettings()
  const save = useContactSettingsMutation()
  const [typed, setTyped] = useState<string | null>(null)
  const stored = settings.data?.max_follow_ups
  const value = typed ?? (stored === undefined ? '' : String(stored))
  const number = Number(value)
  const valid = value.trim() !== '' && Number.isInteger(number) && number >= 0 && number <= MAX_FOLLOW_UPS_LIMIT
  const error = typed !== null && !valid ? `Nombre de relances entre 0 et ${String(MAX_FOLLOW_UPS_LIMIT)}.` : undefined

  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!valid) return
    save.mutate(
      { max_follow_ups: number },
      {
        onSuccess: (saved) => {
          setTyped(null)
          onSaved({
            tone: 'success',
            text: `Max relances : ${String(saved.max_follow_ups)}. Une séquence est « Relance terminée » après l’envoi de R${String(saved.max_follow_ups)}.`,
          })
        },
        onError: (caught) => {
          onSaved({ tone: 'error', text: cohortErrorMessage(caught) })
        },
      },
    )
  }

  return (
    <form className="settings-add" onSubmit={submit} noValidate aria-label="Max relances">
      <TextField
        label="Max relances"
        type="number"
        min={0}
        max={MAX_FOLLOW_UPS_LIMIT}
        step={1}
        inputMode="numeric"
        value={value}
        error={error}
        disabled={settings.isPending}
        hint={`Relances après le Contact (0 à ${String(MAX_FOLLOW_UPS_LIMIT)}, 4 par défaut) : après l’envoi de R${valid ? String(number) : '…'}, le prospect passe en « Relance terminée » (sorti des actions automatiques, toujours contactable).`}
        onChange={(event) => {
          setTyped(event.target.value)
        }}
      />
      <div className="settings-add__actions">
        <Button type="submit" variant="primary" loading={save.isPending} disabled={typed === null || !valid || number === stored}>
          Enregistrer
        </Button>
      </div>
    </form>
  )
}

type FieldErrors = Partial<Record<'code' | 'starts_on' | 'form', string>>

interface CohortDialogProps {
  cohort: Cohort | null
  mutations: ReturnType<typeof useCohortMutations>
  onClose: () => void
  onSaved: (text: string) => void
}

function CohortDialog({ cohort, mutations, onClose, onSaved }: CohortDialogProps) {
  const firstFieldRef = useRef<HTMLInputElement>(null)
  const [code, setCode] = useState(cohort?.code ?? '')
  const [startsOn, setStartsOn] = useState(cohort?.starts_on ?? '')
  const [errors, setErrors] = useState<FieldErrors>({})
  const saving = mutations.create.isPending || mutations.update.isPending
  const formId = 'settings-cohort-form'

  function submit(event: SubmitEvent) {
    event.preventDefault()
    const found: FieldErrors = {}
    if (!code.trim()) found.code = 'Saisissez le code (ex. S41).'
    if (!startsOn) found.starts_on = 'Indiquez la date réelle du premier envoi de la cohorte.'
    setErrors(found)
    if (Object.keys(found).length > 0) return
    const handlers = {
      onSuccess: (saved: Cohort) => {
        onSaved(`Cohorte « ${saved.code} » ${cohort ? 'modifiée' : 'ajoutée'} (premier envoi le ${formatDay(saved.starts_on ?? startsOn)}).`)
      },
      onError: (error: unknown) => {
        const refusal = settingsRefusal(error)
        const message = cohortErrorMessage(error, code.trim())
        setErrors(
          refusal?.field === 'starts_on' ? { starts_on: message } : refusal?.field === 'code' ? { code: message } : { form: message },
        )
      },
    }
    if (cohort) mutations.update.mutate({ id: cohort.id, code: code.trim(), starts_on: startsOn }, handlers)
    else mutations.create.mutate({ code: code.trim(), starts_on: startsOn }, handlers)
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={cohort ? `Modifier « ${cohort.code} »` : 'Ajouter une cohorte'}
      description={
        cohort?.needs_review
          ? 'Cohorte reprise de l’ancien suivi : enregistrer sa date réelle la confirme.'
          : 'Le code Sxx nomme la session ; la date est celle, réelle, de son premier envoi.'
      }
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
          label="Code"
          required
          maxLength={16}
          autoComplete="off"
          placeholder="S41"
          hint="S suivi d’un numéro ; « s 041 » s’écrit S41."
          value={code}
          error={errors.code}
          onChange={(event) => {
            setCode(event.target.value)
            setErrors((current) => ({ ...current, code: undefined, form: undefined }))
          }}
        />
        <TextField
          label="Date du premier envoi"
          type="date"
          required
          value={startsOn}
          error={errors.starts_on}
          hint={cohort && cohort.sequence_count > 0 ? 'Changer la date déplace les échéances des Contacts pas encore envoyés.' : undefined}
          onChange={(event) => {
            setStartsOn(event.target.value)
            setErrors((current) => ({ ...current, starts_on: undefined, form: undefined }))
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

interface DeleteCohortDialogProps {
  cohort: Cohort
  error: unknown
  deleting: boolean
  onDelete: () => void
  onClose: () => void
}

// A cohort a sequence ever used stays (history); only an unused one is deleted.
function DeleteCohortDialog({ cohort, error, deleting, onDelete, onClose }: DeleteCohortDialogProps) {
  const used = cohort.sequence_count > 0
  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title={used ? 'Suppression impossible' : `Supprimer « ${cohort.code} » ?`}
      footer={
        <>
          <Button onClick={onClose}>{used ? 'Fermer' : 'Annuler'}</Button>
          {!used && (
            <Button variant="danger" loading={deleting} onClick={onDelete}>
              Supprimer
            </Button>
          )}
        </>
      }
    >
      <div className="settings-dialog">
        <p>
          {used
            ? `« ${cohort.code} » a servi à ${String(cohort.sequence_count)} séquence${cohort.sequence_count > 1 ? 's' : ''} : une cohorte utilisée reste, avec l’historique des prospects. Pour réutiliser son code, renommez-la.`
            : `« ${cohort.code} » n’a jamais servi. La suppression est définitive ; elle reste tracée dans l’historique.`}
        </p>
        {error !== null && (
          <p className="settings-feedback settings-feedback--error" role="alert">
            <AlertIcon size={18} />
            {cohortErrorMessage(error, cohort.code)}
          </p>
        )}
      </div>
    </Modal>
  )
}
