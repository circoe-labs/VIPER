import { useState } from 'react'
import { Link } from 'react-router'

import type { Appointment, AppointmentPatch } from '../api/agenda'
import { StatusBadge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Drawer } from '../ui/Dialog'
import { SelectField, TextAreaField } from '../ui/fields'
import { BanIcon, CalendarIcon, CheckCircleIcon, CloseIcon, LinkIcon, UndoIcon } from '../ui/icons'
import { prospectionHref } from '../prospection/criteria'
import { type AppointmentActions, MailRecap, STATUS_META } from './AppointmentParts'
import { dayFull, dayKey, timeOf } from './dates'

interface DrawerProps {
  appointment: Appointment
  referents: { id: string; label: string }[]
  busy: boolean
  error: string | null
  actions: AppointmentActions
  onPatch: (patch: AppointmentPatch) => void
  onClose: () => void
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="agenda-detail__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

// The appointment in full: who, which company, who hosts it, who of Circoe is assigned, the notes, the last mail sent —
// and the same follow-up actions as the context menu, as visible buttons.
export function AppointmentDrawer({ appointment, referents, busy, error, actions, onPatch, onClose }: DrawerProps) {
  const [notes, setNotes] = useState(appointment.notes ?? '')
  const status = STATUS_META[appointment.status]
  const isLink = appointment.location?.startsWith('http') ?? false
  const referentOptions =
    appointment.referent && !referents.some((referent) => referent.id === appointment.referent?.id)
      ? [appointment.referent, ...referents]
      : referents
  return (
    <Drawer open size="md" title={appointment.invitee_name} onClose={onClose}
      description={`${dayFull(dayKey(appointment.starts_at))} à ${timeOf(appointment.starts_at)}`}
    >
      <div className="agenda-detail">
        <p className="agenda-detail__status">
          <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          {appointment.reschedule_count > 0 && (
            <span className="agenda-muted">
              Décalé {appointment.reschedule_count} fois
            </span>
          )}
        </p>

        <dl className="agenda-detail__list">
          <Row label="Société">{appointment.company_name ?? '—'}</Row>
          <Row label="Personne">
            {appointment.invitee_name}
            {appointment.invitee_email && <span className="agenda-muted"> · {appointment.invitee_email}</span>}
          </Row>
          <Row label="Fiche prospect">
            {appointment.prospect ? (
              <Link to={prospectionHref({ prospect: appointment.prospect.id })}>{appointment.prospect.name}</Link>
            ) : (
              <span className="agenda-muted">Aucune fiche rattachée</span>
            )}
          </Row>
          <Row label="Reçu par (Calendly)">{appointment.host_name ?? '—'}</Row>
          <Row label="Lieu">
            {appointment.location ? (
              isLink ? (
                <a href={appointment.location} target="_blank" rel="noreferrer">
                  <LinkIcon size={14} /> Ouvrir le lien du rendez-vous
                </a>
              ) : (
                appointment.location
              )
            ) : (
              '—'
            )}
          </Row>
        </dl>

        <SelectField
          label="Référent assigné"
          value={appointment.referent?.id ?? ''}
          disabled={busy}
          onChange={(event) => {
            onPatch({ referent_id: event.target.value || null })
          }}
        >
          <option value="">Non assigné</option>
          {referentOptions.map((referent) => (
            <option key={referent.id} value={referent.id}>
              {referent.label}
            </option>
          ))}
        </SelectField>

        <div className="agenda-detail__notes">
          <TextAreaField
            label="Notes"
            rows={4}
            value={notes}
            onChange={(event) => {
              setNotes(event.target.value)
            }}
          />
          <Button
            size="sm"
            disabled={busy || notes === (appointment.notes ?? '')}
            onClick={() => {
              onPatch({ notes })
            }}
          >
            Enregistrer les notes
          </Button>
        </div>

        <section aria-label="Dernier mail envoyé">
          <h3 className="agenda-detail__heading">Avant le rendez-vous</h3>
          <MailRecap mail={appointment.last_mail} />
        </section>

        {error && (
          <p className="agenda-error" role="alert">
            {error}
          </p>
        )}

        <div className="agenda-detail__actions">
          <Button icon={CalendarIcon} onClick={() => { actions.move(appointment) }}>
            Décalé…
          </Button>
          <Button
            icon={BanIcon}
            disabled={busy || appointment.status === 'no_show'}
            onClick={() => { actions.setStatus(appointment, 'no_show') }}
          >
            Ne s’est pas présenté
          </Button>
          <Button
            icon={CheckCircleIcon}
            disabled={busy || appointment.status === 'completed'}
            onClick={() => { actions.setStatus(appointment, 'completed') }}
          >
            Rendez-vous effectué
          </Button>
          <Button
            icon={CloseIcon}
            variant="danger"
            disabled={busy || appointment.status === 'cancelled'}
            onClick={() => { actions.setStatus(appointment, 'cancelled') }}
          >
            Annulé
          </Button>
          {appointment.status !== 'scheduled' && (
            <Button icon={UndoIcon} variant="ghost" disabled={busy} onClick={() => { actions.setStatus(appointment, 'scheduled') }}>
              Rétablir
            </Button>
          )}
        </div>
      </div>
    </Drawer>
  )
}
