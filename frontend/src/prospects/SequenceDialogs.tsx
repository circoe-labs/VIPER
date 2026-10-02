import { type ReactNode, useId, useRef, useState } from 'react'

import type { TrackingStatus } from '../api/prospection'
import { type Place, useProspectAlerts } from '../api/sequences'
import { useCohorts } from '../api/settings'
import { stepLabel, TRACKING_LABELS } from '../prospection/labels'
import { Button } from '../ui/Button'
import { Modal } from '../ui/Dialog'
import { Checkbox, SelectField, TextAreaField, TextField } from '../ui/fields'
import { AlertIcon, InfoIcon } from '../ui/icons'
import { cohortChoiceLabel, localMinute } from './sequenceModel'

// The confirmations of « Séquence de contact »: each says its consequences in plain sentences before an operation a
// person owns. « Retour » is focused first, so Enter never confirms by accident.

interface DialogFrameProps {
  title: string
  confirmLabel: string
  danger?: boolean
  busy: boolean
  // The refusal of the last attempt, in French.
  error: string | null
  // The form's unsaved changes are not saved by the action (null when there are none).
  pending: string | null
  canConfirm?: boolean
  formId?: string
  onClose: () => void
  onConfirm?: () => void
  children: ReactNode
}

function DialogFrame(props: DialogFrameProps) {
  const { title, confirmLabel, danger = false, busy, error, pending, canConfirm = true, formId, onClose, onConfirm } = props
  const backRef = useRef<HTMLButtonElement>(null)
  return (
    <Modal
      open
      size="sm"
      title={title}
      initialFocusRef={backRef}
      onClose={onClose}
      footer={
        <>
          <Button ref={backRef} disabled={busy} onClick={onClose}>
            Retour
          </Button>
          <Button
            type={formId ? 'submit' : 'button'}
            form={formId}
            variant={danger ? 'danger' : 'primary'}
            loading={busy}
            disabled={!canConfirm}
            onClick={formId ? undefined : onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="sequence-dialog">
        {props.children}
        {pending && (
          <p className="prospect-editor__note">
            <InfoIcon size={16} />
            {pending}
          </p>
        )}
        {error && (
          <p className="sequence-dialog__error" role="alert">
            <AlertIcon size={16} />
            {error}
          </p>
        )}
      </div>
    </Modal>
  )
}

interface ConfirmActionDialogProps {
  title: string
  lines: string[]
  confirmLabel: string
  danger?: boolean
  // Offer an optional note (« Précision »), sent with the confirmation.
  note?: boolean
  busy: boolean
  error: string | null
  pending: string | null
  onClose: () => void
  onConfirm: (note: string | null) => void
}

export function ConfirmActionDialog({ title, lines, note = false, onConfirm, ...frame }: ConfirmActionDialogProps) {
  const [text, setText] = useState('')
  return (
    <DialogFrame
      title={title}
      {...frame}
      onConfirm={() => {
        onConfirm(text.trim() || null)
      }}
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
      {note && (
        <TextAreaField
          label="Précision (facultative)"
          hint="Par exemple le message d’erreur reçu. Pas d’adresse e-mail ici."
          rows={2}
          maxLength={1000}
          value={text}
          onChange={(event) => {
            setText(event.target.value)
          }}
        />
      )}
    </DialogFrame>
  )
}

const RESUMED: readonly TrackingStatus[] = ['response_received', 'appointment_obtained', 'disqualified']
const REMOVE = 'none'

interface CohortDialogProps {
  prospectId: string
  place: Place
  state: TrackingStatus
  busy: boolean
  error: string | null
  pending: string | null
  onClose: () => void
  // `resolveEmailError`: also resolve the open « Erreur sur le mail » alerts `alertIds` (a person's or an import's).
  onConfirm: (cohortId: string | null, resolveEmailError: boolean, alertIds: string[]) => void
}

// A change of cohort (D6): the current sequence closes with its history, a new one opens with its counter at zero.
export function CohortDialog({ prospectId, place, state, onConfirm, ...frame }: CohortDialogProps) {
  const formId = useId()
  const cohorts = useCohorts()
  const emailErrors = useEmailErrorAlerts(prospectId)
  const [choice, setChoice] = useState('')
  const [resolve, setResolve] = useState(true)
  const current = place.cohort
  const options = (cohorts.data ?? []).filter((cohort) => cohort.id !== current?.id || !place.sequence_open)
  const target = choice === REMOVE ? null : (cohorts.data ?? []).find((cohort) => cohort.id === choice)
  const chosen = choice !== ''
  const lines: string[] = []
  if (current) {
    lines.push(
      `La séquence actuelle (${current.code}, ${String(place.sent_count)} envoi${place.sent_count > 1 ? 's' : ''}) est close et reste dans l’historique ; ses messages non envoyés sont annulés.`,
    )
  }
  if (choice === REMOVE) {
    lines.push('Le prospect n’est plus validé : rien ne sera dû. Son état commercial est conservé.')
  } else if (target) {
    lines.push(
      target.out_of_campaign
        ? 'S0 : le prospect reste validé mais hors campagne, aucun envoi ne sera prévu.'
        : `Une nouvelle séquence démarre en ${target.code} : le compteur repart de zéro (Contact à envoyer).`,
    )
    if (RESUMED.includes(state)) lines.push(`L’état « ${TRACKING_LABELS[state]} » repasse « En séquence ».`)
  }
  const offerResolve = target !== undefined && target !== null && emailErrors.length > 0
  return (
    <DialogFrame
      title={current ? 'Changer de cohorte' : 'Valider dans une cohorte'}
      confirmLabel={choice === REMOVE ? 'Retirer la cohorte' : 'Ouvrir la nouvelle séquence'}
      canConfirm={chosen}
      formId={formId}
      {...frame}
    >
      <form
        id={formId}
        className="sequence-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!chosen) return
          onConfirm(target?.id ?? null, offerResolve && resolve, emailErrors)
        }}
      >
        <SelectField
          label="Nouvelle cohorte"
          value={choice}
          hint={cohorts.isError ? 'Liste des cohortes indisponible.' : 'Créez une cohorte et sa date dans Paramètres › Cohortes.'}
          onChange={(event) => {
            setChoice(event.target.value)
          }}
        >
          <option value="">Choisir une cohorte</option>
          {options.map((cohort) => (
            <option key={cohort.id} value={cohort.id}>
              {cohortChoiceLabel(cohort)}
            </option>
          ))}
          {current && <option value={REMOVE}>Retirer la cohorte (non validé)</option>}
        </SelectField>
        {lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {offerResolve && (
          <Checkbox
            label="Résoudre aussi l’erreur sur le mail"
            hint="À cocher si une nouvelle adresse e-mail est enregistrée : sinon le prospect reste hors des actions automatiques."
            checked={resolve}
            onChange={(event) => {
              setResolve(event.target.checked)
            }}
          />
        )}
      </form>
    </DialogFrame>
  )
}

// The open « Erreur sur le mail » alerts that pause the sequence (a person's or an import's, not the AI's proposals).
function useEmailErrorAlerts(prospectId: string): string[] {
  const alerts = useProspectAlerts(prospectId)
  return (alerts.data?.items ?? [])
    .filter((alert) => alert.open && alert.type === 'email_error' && alert.source !== 'ai')
    .map((alert) => alert.id)
}

interface MarkSentDialogProps {
  // The step to declare (`contact`, `r2`…).
  step: string
  busy: boolean
  error: string | null
  pending: string | null
  onClose: () => void
  // `sentAt`: ISO 8601, or null for « now » (the field left as opened).
  onConfirm: (sentAt: string | null) => void
}

// « Marquer comme envoyé » (D3): the next step was really sent — the level moves by one. The moment defaults to now.
export function MarkSentDialog({ step, onConfirm, ...frame }: MarkSentDialogProps) {
  const formId = useId()
  const [opened] = useState(() => localMinute(new Date()))
  const [moment, setMoment] = useState(opened)
  const [invalid, setInvalid] = useState<string | null>(null)
  const label = stepLabel(step)
  return (
    <DialogFrame title={`Marquer ${label} comme envoyé`} confirmLabel={`${label} envoyé`} formId={formId} {...frame}>
      <form
        id={formId}
        className="sequence-dialog"
        onSubmit={(event) => {
          event.preventDefault()
          if (!moment) {
            setInvalid('Indiquez quand le message est parti.')
            return
          }
          if (moment > localMinute(new Date())) {
            setInvalid('La date d’envoi ne peut pas être dans le futur.')
            return
          }
          onConfirm(moment === opened ? null : new Date(moment).toISOString())
        }}
      >
        <p>
          Déclarez un envoi réellement fait : le niveau avance d’un cran. Une relance prévue mais non envoyée ne se déclare
          pas.
        </p>
        <TextField
          label="Envoyé le"
          type="datetime-local"
          required
          value={moment}
          max={localMinute(new Date())}
          hint="Par défaut maintenant. Ni dans le futur, ni avant l’envoi précédent."
          error={invalid ?? undefined}
          onChange={(event) => {
            setMoment(event.target.value)
            setInvalid(null)
          }}
        />
      </form>
    </DialogFrame>
  )
}
