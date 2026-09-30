import { TRACKING_STATUSES, type TrackingStatus } from '../api/prospection'
import type { Prospect } from '../api/prospects'
import { isoWeekOf, weekMonday } from '../lib/isoWeek'
import { formatDay, TRACKING_LABELS } from '../prospection/labels'
import { ReferentSelect } from '../settings/selectors'
import { SelectField, TextField } from '../ui/fields'
import { BanIcon, InfoIcon } from '../ui/icons'
import type { SectionProps } from './EmploymentSections'
import { EditorSection } from './EditorSection'
import { type TrackingDraft, withStatus } from './prospectForm'
import { cadenceSuggestion, WeekPlanner } from './WeekPlanner'

// What choosing a state implies, said before saving (backend contact_tracking rules, Contact decisions 7-13, 29).
const STATE_HINTS: Partial<Record<TrackingStatus, string>> = {
  response_received: 'La date de réponse est celle du jour si vous n’en indiquez pas.',
  appointment_obtained: 'Fin de la séquence de contact : indiquez le référent qui prend le rendez-vous.',
  failure: 'Séquence close sans réponse. Ce n’est pas une opposition.',
  ignored: 'Définitif : le prospect passe en « Ne pas contacter » et n’aura plus de prochaine action.',
}

interface TrackingSectionProps extends SectionProps {
  prospect: Prospect | null
  today: string
}

// Suivi de contact: the Contact state (no badge while `neutral`), the next-action week — separate from the state —
// with the cadence proposal, the response and appointment dates, and the Circoe referent asked for once an appointment
// exists. Saved with the form; the status history is kept by the server.
export function TrackingSection({ draft, errors, fieldId, onChange, prospect, today }: TrackingSectionProps) {
  const tracking = draft.tracking
  const set = (patch: Partial<TrackingDraft>) => {
    onChange({ tracking: { ...tracking, ...patch } })
  }
  const saved = prospect?.tracking ?? null
  const appointment = tracking.appointment_on !== '' || tracking.status === 'appointment_obtained'
  const since = saved?.status === tracking.status ? saved.status_since : null
  const blocked = prospect?.contactability_status === 'do_not_contact'
  // `ignored` is terminal once saved (decision 7): the state and the week stay as they are.
  const terminal = saved?.status === 'ignored'
  const ignored = tracking.status === 'ignored'
  const stateHint = terminal
    ? '« Ignoré » est définitif : l’état ne peut plus changer.'
    : [since && `Depuis le ${formatDay(since)}.`, tracking.status !== saved?.status && tracking.status && STATE_HINTS[tracking.status]]
        .filter(Boolean)
        .join(' ') || undefined
  return (
    <EditorSection title="Suivi de contact">
      {blocked && !ignored && (
        <p className="prospect-editor__note prospect-editor__note--danger">
          <BanIcon size={16} />
          Opposition enregistrée : ne planifiez pas de contact.
        </p>
      )}
      <div className="prospect-editor__grid">
        <SelectField
          id={fieldId('tracking.status')}
          label="État"
          value={tracking.status}
          hint={stateHint}
          error={errors['tracking.status']}
          disabled={terminal}
          onChange={(event) => {
            onChange({
              tracking: withStatus(tracking, event.target.value as TrackingStatus | '', saved?.planned_contact_on ?? null),
            })
          }}
        >
          {!saved && <option value="">Aucun suivi</option>}
          {TRACKING_STATUSES.map((status) => (
            <option key={status} value={status}>
              {TRACKING_LABELS[status]}
            </option>
          ))}
        </SelectField>
        {ignored ? (
          <p className="prospect-editor__note" id={fieldId('tracking.planned_contact_on')}>
            <InfoIcon size={16} />
            Prospect ignoré : aucune prochaine action ne peut être planifiée.
          </p>
        ) : (
          <WeekPlanner
            idPrefix={fieldId('tracking.planned_contact_on')}
            value={isoWeekOf(tracking.planned_contact_on)}
            today={today}
            suggestion={cadenceSuggestion(prospect?.tracking ?? null, tracking.status)}
            onChange={(week) => {
              set({ planned_contact_on: week ? weekMonday(week) : '' })
            }}
          />
        )}
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
