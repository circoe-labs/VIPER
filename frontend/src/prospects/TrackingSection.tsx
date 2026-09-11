import { TRACKING_STATUSES, type TrackingStatus } from '../api/prospection'
import type { Prospect } from '../api/prospects'
import { formatDay, TRACKING_LABELS } from '../prospection/labels'
import { ReferentSelect } from '../settings/selectors'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { SelectField, TextField } from '../ui/fields'
import { BanIcon } from '../ui/icons'
import type { SectionProps } from './EmploymentSections'
import { EditorSection } from './EditorSection'
import { isoWeekLabel, type TrackingDraft } from './prospectForm'

const APPOINTMENT_STAGES: readonly TrackingStatus[] = ['appointment_obtained', 'quote_sent', 'quote_follow_up', 'won']

// `today` + `days`, both `YYYY-MM-DD`.
function addDays(today: string, days: number): string {
  const date = new Date(`${today}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

interface TrackingSectionProps extends SectionProps {
  prospect: Prospect | null
  today: string
}

// Suivi de contact: the planned contact (its week derived), the current stage, the response and appointment dates,
// and the Circoe referent — asked for once an appointment exists. The status history is kept by the server.
export function TrackingSection({ draft, errors, fieldId, onChange, prospect, today }: TrackingSectionProps) {
  const tracking = draft.tracking
  const set = (patch: Partial<TrackingDraft>) => {
    onChange({ tracking: { ...tracking, ...patch } })
  }
  const week = isoWeekLabel(tracking.planned_contact_on)
  const appointment = tracking.appointment_on !== '' || (tracking.status !== '' && APPOINTMENT_STAGES.includes(tracking.status))
  const since = prospect?.tracking?.status === tracking.status ? prospect.tracking.status_since : null
  const blocked = prospect?.contactability_status === 'do_not_contact'
  return (
    <EditorSection title="Suivi de contact">
      {blocked && (
        <p className="prospect-editor__note prospect-editor__note--danger">
          <BanIcon size={16} />
          Opposition enregistrée : ne planifiez pas de contact.
        </p>
      )}
      <div className="prospect-editor__grid">
        <SelectField
          id={fieldId('tracking.status')}
          label="Étape"
          value={tracking.status}
          hint={since ? `Depuis le ${formatDay(since)}` : undefined}
          onChange={(event) => {
            set({ status: event.target.value as TrackingStatus | '' })
          }}
        >
          {!prospect?.tracking && <option value="">Aucun suivi</option>}
          {TRACKING_STATUSES.map((status) => (
            <option key={status} value={status}>
              {TRACKING_LABELS[status]}
            </option>
          ))}
        </SelectField>
        <div className="prospect-editor__stack">
          <TextField
            id={fieldId('tracking.planned_contact_on')}
            type="date"
            label="Contact prévu le"
            value={tracking.planned_contact_on}
            hint={week ? <Badge>{`Semaine ${week.slice(1)}`}</Badge> : 'La semaine est calculée depuis la date.'}
            onChange={(event) => {
              set({ planned_contact_on: event.target.value })
            }}
          />
          <span className="prospect-editor__quick">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                set({ planned_contact_on: today })
              }}
            >
              Aujourd’hui
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                set({ planned_contact_on: addDays(today, 7) })
              }}
            >
              Dans 1 semaine
            </Button>
          </span>
        </div>
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
                : 'Rendez-vous obtenu : indiquez qui le prend en charge chez Circoe.'
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
