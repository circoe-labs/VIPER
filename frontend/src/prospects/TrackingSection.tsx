import { TRACKING_STATUSES, type TrackingStatus } from '../api/prospection'
import type { Prospect } from '../api/prospects'
import { formatDay, levelLabel, TRACKING_LABELS } from '../prospection/labels'
import { ReferentSelect } from '../settings/selectors'
import { SelectField, TextField } from '../ui/fields'
import { BanIcon } from '../ui/icons'
import type { SectionProps } from './EmploymentSections'
import { EditorSection } from './EditorSection'
import type { TrackingDraft } from './prospectForm'

// What choosing a state implies, said before saving (backend contact_tracking rules, sequences rework D7).
const STATE_HINTS: Partial<Record<TrackingStatus, string>> = {
  neutral: 'La séquence reprend là où elle s’était arrêtée (le niveau est conservé).',
  response_received: 'Sort la séquence des actions automatiques. La date de réponse est celle du jour si vous n’en indiquez pas.',
  appointment_obtained: 'Fin de la séquence de contact : indiquez le référent qui prend le rendez-vous.',
  ignored: 'Définitif : le prospect passe en « Ne pas contacter » et n’aura plus d’envoi.',
}

// « Défaillant » is never chosen here: it is a person's confirmed decision (Séquence de contact). Shown only while it is
// the saved state, so the form can leave it.
function offeredStates(saved: TrackingStatus | null): readonly TrackingStatus[] {
  return TRACKING_STATUSES.filter((status) => status !== 'disqualified' || saved === 'disqualified')
}

// The few facts read at a glance: cohort (with its first send), relance level, referent, and the appointment — a
// response always comes with the appointment booked through the link of the e-mail.
function Summary({ prospect, tracking }: { prospect: Prospect; tracking: TrackingDraft }) {
  const { cohort, level } = prospect.contact
  const referent = prospect.tracking?.referent?.label ?? null
  const answered = tracking.response_received_on !== '' || tracking.status === 'response_received' || tracking.status === 'appointment_obtained'
  const appointment = tracking.appointment_on
    ? `Oui, prévu le ${formatDay(tracking.appointment_on)}${tracking.appointment_time ? ` à ${tracking.appointment_time.slice(0, 5)}` : ''}`
    : answered
      ? 'Oui, date à renseigner'
      : 'Non'
  const facts: [string, string][] = [
    ['Semaine', cohort ? `${cohort.code}${cohort.starts_on ? ` · 1er envoi le ${formatDay(cohort.starts_on)}` : ''}` : 'Aucune'],
    ['Relance', level ? levelLabel(level) : '—'],
    ['Référent', referent ?? '—'],
    ['RDV', appointment],
  ]
  return (
    <dl className="prospect-editor__summary">
      {facts.map(([term, value]) => (
        <div key={term}>
          <dt>{term}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

interface TrackingSectionProps extends SectionProps {
  prospect: Prospect | null
}

// Suivi de contact: the commercial state (« En séquence » by default), the response and appointment dates and the
// Circoe referent asked for once an appointment exists. Saved with the form; the status history is kept by the server.
// The cohort, the level and the sends are in « Séquence de contact » (their own operations, never this save).
export function TrackingSection({ draft, errors, fieldId, onChange, prospect }: TrackingSectionProps) {
  const tracking = draft.tracking
  const set = (patch: Partial<TrackingDraft>) => {
    onChange({ tracking: { ...tracking, ...patch } })
  }
  const saved = prospect?.tracking ?? null
  const appointment = tracking.appointment_on !== '' || tracking.status === 'appointment_obtained'
  const since = saved?.status === tracking.status ? saved.status_since : null
  const blocked = prospect?.contactability_status === 'do_not_contact'
  // `ignored` is terminal once saved: the state stays as it is.
  const terminal = saved?.status === 'ignored'
  const stateHint = terminal
    ? '« Ignoré » est définitif : l’état ne peut plus changer.'
    : [
        since && `Depuis le ${formatDay(since)}.`,
        tracking.status !== (saved?.status ?? '') && tracking.status && STATE_HINTS[tracking.status],
      ]
        .filter(Boolean)
        .join(' ') || undefined
  return (
    <EditorSection title="Suivi de contact">
      {blocked && (
        <p className="prospect-editor__note prospect-editor__note--danger">
          <BanIcon size={16} />
          Ne pas contacter{prospect.do_not_contact_reason ? ` — ${prospect.do_not_contact_reason}` : ''}. Opposition enregistrée : aucun envoi n’est possible.
        </p>
      )}
      {prospect && <Summary prospect={prospect} tracking={tracking} />}
      <div className="prospect-editor__grid">
        <SelectField
          id={fieldId('tracking.status')}
          label="État commercial"
          value={tracking.status}
          hint={stateHint}
          error={errors['tracking.status']}
          disabled={terminal}
          onChange={(event) => {
            set({ status: event.target.value as TrackingStatus | '' })
          }}
        >
          {!saved && <option value="">Aucun suivi</option>}
          {offeredStates(saved?.status ?? null).map((status) => (
            <option key={status} value={status}>
              {TRACKING_LABELS[status]}
            </option>
          ))}
        </SelectField>
        <TextField
          id={fieldId('tracking.response_received_on')}
          type="date"
          label="Réponse reçue le"
          value={tracking.response_received_on}
          onChange={(event) => {
            set({ response_received_on: event.target.value })
          }}
        />
        <div className="prospect-editor__pair">
          <TextField
            id={fieldId('tracking.appointment_on')}
            type="date"
            label="Rendez-vous le"
            value={tracking.appointment_on}
            onChange={(event) => {
              set({ appointment_on: event.target.value })
            }}
          />
          <TextField
            id={fieldId('tracking.appointment_time')}
            type="time"
            label="à"
            value={tracking.appointment_time}
            error={errors['tracking.appointment_time']}
            onChange={(event) => {
              set({ appointment_time: event.target.value })
            }}
          />
        </div>
      </div>
      <div className="prospect-editor__referent" data-emphasis={appointment && !tracking.referent_id ? '' : undefined}>
        <ReferentSelect
          label="Référent Circoe"
          placeholder="Choisir ou créer un référent"
          hint={
            appointment
              ? tracking.referent_id
                ? 'Personne de Circoe qui prend en charge le rendez-vous.'
                : 'RDV pris : indiquez qui le prend en charge chez Circoe.'
              : 'Utile surtout une fois un rendez-vous obtenu.'
          }
          value={tracking.referent_id}
          onChange={(referent_id) => {
            set({ referent_id })
          }}
        />
      </div>
    </EditorSection>
  )
}
