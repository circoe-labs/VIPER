import { type SubmitEvent, useRef, useState } from 'react'

import type { Appointment, AppointmentMail, AppointmentStatus } from '../api/agenda'
import { Button } from '../ui/Button'
import type { MenuSection } from '../ui/Menu'
import { SelectField, TextAreaField, TextField } from '../ui/fields'
import { BanIcon, CalendarIcon, CheckCircleIcon, CloseIcon, ExpandIcon, UndoIcon } from '../ui/icons'
import { Modal } from '../ui/Dialog'
import type { StatusTone } from '../ui/Badge'
import { addMinutes, dayKey, formatSentOn, minutesBetween, parisInstant, timeOf } from './dates'

export const STATUS_META: Record<AppointmentStatus, { label: string; tone: StatusTone }> = {
  scheduled: { label: 'À venir', tone: 'info' },
  completed: { label: 'Effectué', tone: 'success' },
  no_show: { label: 'Ne s’est pas présenté', tone: 'danger' },
  cancelled: { label: 'Annulé', tone: 'neutral' },
}

// The person to show on a chip and in lists: the company is what the team recognises first.
export function who(appointment: Appointment): string {
  return appointment.company_name
    ? `${appointment.invitee_name} · ${appointment.company_name}`
    : appointment.invitee_name
}

export interface AppointmentActions {
  move: (appointment: Appointment) => void
  setStatus: (appointment: Appointment, status: AppointmentStatus) => void
  open: (appointment: Appointment) => void
}

// The follow-up of an appointment, as a context menu (right-click, « … » button, keyboard): moved, no-show, done,
// cancelled, back to scheduled, open.
export function appointmentMenu(appointment: Appointment, actions: AppointmentActions): MenuSection[] {
  const { status } = appointment
  return [
    {
      items: [
        { id: 'move', label: 'Décalé…', icon: CalendarIcon, onSelect: () => { actions.move(appointment) } },
        {
          id: 'no_show',
          label: 'Ne s’est pas présenté',
          icon: BanIcon,
          disabled: status === 'no_show',
          onSelect: () => { actions.setStatus(appointment, 'no_show') },
        },
        {
          id: 'completed',
          label: 'Rendez-vous effectué',
          icon: CheckCircleIcon,
          disabled: status === 'completed',
          onSelect: () => { actions.setStatus(appointment, 'completed') },
        },
        {
          id: 'cancelled',
          label: 'Annulé',
          icon: CloseIcon,
          danger: true,
          disabled: status === 'cancelled',
          onSelect: () => { actions.setStatus(appointment, 'cancelled') },
        },
        ...(status === 'scheduled'
          ? []
          : [
              {
                id: 'reset',
                label: 'Rétablir',
                icon: UndoIcon,
                onSelect: () => { actions.setStatus(appointment, 'scheduled') },
              },
            ]),
      ],
    },
    { items: [{ id: 'open', label: 'Ouvrir la fiche', icon: ExpandIcon, onSelect: () => { actions.open(appointment) } }] },
  ]
}

// What the prospect last received, said before the appointment: step, date, subject and text.
export function MailRecap({ mail }: { mail: AppointmentMail | null }) {
  if (!mail) return <p className="agenda-muted">Aucun mail envoyé à ce prospect.</p>
  return (
    <details className="agenda-recap">
      <summary>
        Dernier mail envoyé : {mail.step_label}, le {formatSentOn(mail.sent_at)}
      </summary>
      <p className="agenda-recap__subject">{mail.subject}</p>
      <p className="agenda-recap__body">{mail.body_text}</p>
    </details>
  )
}

interface DayTimeFormProps {
  day: string
  time: string
}

// « Décalé… »: the new day and time (the duration is kept).
export function MoveDialog({
  appointment,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  appointment: Appointment
  busy: boolean
  error: string | null
  onClose: () => void
  onConfirm: (startsAt: string, endsAt: string) => void
}) {
  const [form, setForm] = useState<DayTimeFormProps>({ day: dayKey(appointment.starts_at), time: timeOf(appointment.starts_at) })
  const first = useRef<HTMLInputElement>(null)
  const valid = form.day !== '' && form.time !== ''
  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!valid) return
    const startsAt = parisInstant(form.day, form.time)
    onConfirm(startsAt, addMinutes(startsAt, minutesBetween(appointment.starts_at, appointment.ends_at)))
  }
  return (
    <Modal
      open
      size="sm"
      title="Rendez-vous décalé"
      description={`Nouvelle date de ${appointment.invitee_name}. L’ancien créneau est remplacé.`}
      initialFocusRef={first}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button type="submit" form="agenda-move-form" variant="primary" loading={busy} disabled={!valid}>
            Enregistrer le nouveau créneau
          </Button>
        </>
      }
    >
      <form id="agenda-move-form" className="agenda-form" onSubmit={submit}>
        <TextField
          ref={first}
          label="Nouvelle date"
          type="date"
          value={form.day}
          onChange={(event) => { setForm({ ...form, day: event.target.value }) }}
        />
        <TextField
          label="Nouvelle heure"
          type="time"
          value={form.time}
          onChange={(event) => { setForm({ ...form, time: event.target.value }) }}
        />
        {error && <p className="agenda-error" role="alert">{error}</p>}
      </form>
    </Modal>
  )
}

export interface NewAppointment {
  invitee_name: string
  invitee_email: string
  company_name: string
  starts_at: string
  ends_at: string
  referent_id: string | null
  notes: string
}

// « Ajouter un rendez-vous »: an appointment taken outside Calendly (phone, event…).
export function CreateDialog({
  day,
  referents,
  busy,
  error,
  onClose,
  onCreate,
}: {
  day: string
  referents: { id: string; label: string }[]
  busy: boolean
  error: string | null
  onClose: () => void
  onCreate: (appointment: NewAppointment) => void
}) {
  const [form, setForm] = useState({
    name: '',
    email: '',
    company: '',
    day,
    time: '10:00',
    minutes: '30',
    referent: '',
    notes: '',
  })
  const first = useRef<HTMLInputElement>(null)
  const valid = form.name.trim() !== '' && form.day !== '' && form.time !== ''
  const set = (patch: Partial<typeof form>) => { setForm({ ...form, ...patch }) }
  function submit(event: SubmitEvent) {
    event.preventDefault()
    if (!valid) return
    const startsAt = parisInstant(form.day, form.time)
    onCreate({
      invitee_name: form.name.trim(),
      invitee_email: form.email.trim(),
      company_name: form.company.trim(),
      starts_at: startsAt,
      ends_at: addMinutes(startsAt, Number(form.minutes)),
      referent_id: form.referent || null,
      notes: form.notes.trim(),
    })
  }
  return (
    <Modal
      open
      title="Ajouter un rendez-vous"
      description="Pour un rendez-vous pris hors Calendly. Ceux de Calendly arrivent seuls avec « Synchroniser »."
      initialFocusRef={first}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Annuler</Button>
          <Button type="submit" form="agenda-create-form" variant="primary" loading={busy} disabled={!valid}>
            Ajouter
          </Button>
        </>
      }
    >
      <form id="agenda-create-form" className="agenda-form" onSubmit={submit}>
        <TextField ref={first} label="Personne" required value={form.name} onChange={(event) => { set({ name: event.target.value }) }} />
        <TextField label="Société" value={form.company} onChange={(event) => { set({ company: event.target.value }) }} />
        <TextField label="E-mail" type="email" value={form.email} onChange={(event) => { set({ email: event.target.value }) }} />
        <div className="agenda-form__row">
          <TextField label="Date" type="date" required value={form.day} onChange={(event) => { set({ day: event.target.value }) }} />
          <TextField label="Heure" type="time" required value={form.time} onChange={(event) => { set({ time: event.target.value }) }} />
          <SelectField label="Durée" value={form.minutes} onChange={(event) => { set({ minutes: event.target.value }) }}>
            {['15', '30', '45', '60', '90'].map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} min
              </option>
            ))}
          </SelectField>
        </div>
        <SelectField label="Référent" value={form.referent} onChange={(event) => { set({ referent: event.target.value }) }}>
          <option value="">Non assigné</option>
          {referents.map((referent) => (
            <option key={referent.id} value={referent.id}>
              {referent.label}
            </option>
          ))}
        </SelectField>
        <TextAreaField label="Notes" rows={3} value={form.notes} onChange={(event) => { set({ notes: event.target.value }) }} />
        {error && <p className="agenda-error" role="alert">{error}</p>}
      </form>
    </Modal>
  )
}
