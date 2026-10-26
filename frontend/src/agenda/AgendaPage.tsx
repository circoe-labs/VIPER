import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import {
  type Appointment,
  type AppointmentPatch,
  type AppointmentStatus,
  type SyncResult,
  useAgendaMutations,
  useAppointments,
  useReminders,
} from '../api/agenda'
import { ApiError } from '../api/client'
import { referentName, useReferents } from '../api/settings'
import { Button, IconButton } from '../ui/Button'
import { type Point } from '../ui/floating'
import { AlertIcon, CalendarIcon, ClockIcon, ChevronLeftIcon, ChevronRightIcon, PlusIcon, RefreshIcon } from '../ui/icons'
import { Menu } from '../ui/Menu'
import { PageHeader } from '../ui/PageHeader'
import { AgendaCalendar } from './AgendaCalendar'
import { AppointmentDrawer } from './AppointmentDrawer'
import {
  type AppointmentActions,
  appointmentMenu,
  CreateDialog,
  MailRecap,
  MoveDialog,
  who,
} from './AppointmentParts'
import { type AgendaView, dayKey, periodTitle, stepAnchor, timeOf, todayKey, visibleDays } from './dates'
import './agenda.css'

function syncMessage(result: SyncResult): string {
  if (result.ok) {
    const parts = [
      `${String(result.created)} nouveau${result.created > 1 ? 'x' : ''}`,
      `${String(result.updated)} mis à jour`,
      `${String(result.cancelled)} annulé${result.cancelled > 1 ? 's' : ''}`,
    ]
    return `Calendly est à jour : ${parts.join(', ')}.`
  }
  switch (result.code) {
    case 'calendly_not_configured':
      return 'Calendly n’est pas encore relié à VIPER.'
    case 'calendly_unauthorized':
      return 'Calendly a refusé le jeton : vérifiez-le dans Paramètres.'
    case 'calendly_unreachable':
      return 'Calendly est injoignable pour l’instant. Réessayez dans quelques minutes.'
    default:
      return 'La synchronisation avec Calendly a échoué.'
  }
}

const WRITE_FAILED = 'L’enregistrement a échoué. Réessayez.'

function refusal(error: unknown): string {
  return error instanceof ApiError ? error.message || WRITE_FAILED : WRITE_FAILED
}

interface OpenMenu {
  appointment: Appointment
  position: Point
  alignRight: boolean
}

// Agenda: every appointment taken (synced from Calendly or typed by hand) on a month or week calendar, the reminder of
// the day before with the last mail the prospect received, and the follow-up of each appointment — moved, no-show,
// done, cancelled — from a right-click, the « … » button or the detail panel.
export function AgendaPage() {
  const today = todayKey()
  const [view, setView] = useState<AgendaView>('month')
  const [anchor, setAnchor] = useState(today)
  const days = useMemo(() => visibleDays(anchor, view), [anchor, view])
  const range = { start: days[0] ?? today, end: days.at(-1) ?? today }
  const appointments = useAppointments(range)
  const reminders = useReminders()
  const referents = useReferents()
  const { create, update, sync } = useAgendaMutations()

  const [detail, setDetail] = useState<Appointment | null>(null)
  const [menu, setMenu] = useState<OpenMenu | null>(null)
  const [moving, setMoving] = useState<Appointment | null>(null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null)
  const [syncFailed, setSyncFailed] = useState(false)

  const byDay = useMemo(() => {
    const grouped = new Map<string, Appointment[]>()
    for (const appointment of appointments.data?.items ?? []) {
      const key = dayKey(appointment.starts_at)
      grouped.set(key, [...(grouped.get(key) ?? []), appointment])
    }
    return grouped
  }, [appointments.data])

  const referentChoices = (referents.data ?? [])
    .filter((referent) => referent.active)
    .map((referent) => ({ id: referent.id, label: referentName(referent) }))

  async function apply(appointment: Appointment, patch: AppointmentPatch): Promise<boolean> {
    setError(null)
    try {
      const saved = await update.mutateAsync({ id: appointment.id, patch })
      setDetail((current) => (current?.id === appointment.id ? saved : current))
      return true
    } catch (caught) {
      setError(refusal(caught))
      return false
    }
  }

  const actions: AppointmentActions = {
    move: (appointment) => {
      setError(null)
      setMoving(appointment)
    },
    setStatus: (appointment: Appointment, status: AppointmentStatus) => {
      void apply(appointment, { status })
    },
    open: (appointment) => {
      setError(null)
      setDetail(appointment)
    },
  }

  async function runSync() {
    setSyncFailed(false)
    setSyncResult(null)
    try {
      setSyncResult(await sync.mutateAsync())
    } catch {
      setSyncFailed(true)
    }
  }

  const soon = [
    { when: 'Demain', items: reminders.data?.tomorrow ?? [] },
    { when: 'Aujourd’hui', items: reminders.data?.today ?? [] },
  ].filter((group) => group.items.length > 0)

  return (
    <div className="agenda">
      <PageHeader
        title="Agenda"
        description="Les rendez-vous pris, ce qui a été envoyé avant, et leur suivi."
        actions={
          <>
            <Button icon={RefreshIcon} loading={sync.isPending} onClick={() => void runSync()}>
              Synchroniser avec Calendly
            </Button>
            <Button
              variant="primary"
              icon={PlusIcon}
              onClick={() => {
                setError(null)
                setCreating(true)
              }}
            >
              Ajouter un rendez-vous
            </Button>
          </>
        }
      />

      <div role="status" className="agenda-sync">
        {syncResult && (
          <p className={syncResult.ok ? 'agenda-muted' : 'agenda-error'}>
            {syncMessage(syncResult)}{' '}
            {!syncResult.ok && (syncResult.code === 'calendly_not_configured' || syncResult.code === 'calendly_unauthorized') && (
              <Link to="/settings/connections">Ouvrir les connexions</Link>
            )}
          </p>
        )}
        {syncFailed && <p className="agenda-error">La synchronisation avec Calendly a échoué.</p>}
      </div>

      {soon.length > 0 && (
        <section className="agenda-reminders" aria-label="Rappels">
          {soon.map(({ when, items }) => (
            <div key={when} className="agenda-reminders__group">
              <h2 className="agenda-reminders__title">
                <ClockIcon size={18} />
                {when} : {items.length} rendez-vous
              </h2>
              <ul className="agenda-reminders__list">
                {items.map((appointment) => (
                  <li key={appointment.id} className="agenda-reminders__item">
                    <div className="agenda-reminders__line">
                      <strong>{timeOf(appointment.starts_at)}</strong>
                      <span>{who(appointment)}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          actions.open(appointment)
                        }}
                      >
                        Ouvrir le rendez-vous de {appointment.invitee_name}
                      </Button>
                    </div>
                    <MailRecap mail={appointment.last_mail} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {error && !detail && !moving && !creating && (
        <p className="agenda-error" role="alert">
          <AlertIcon size={16} /> {error}
        </p>
      )}

      <div className="agenda-toolbar">
        <div className="agenda-toolbar__nav">
          <IconButton
            icon={ChevronLeftIcon}
            label={view === 'month' ? 'Mois précédent' : 'Semaine précédente'}
            onClick={() => {
              setAnchor(stepAnchor(anchor, view, -1))
            }}
          />
          <Button
            size="sm"
            onClick={() => {
              setAnchor(today)
            }}
          >
            Aujourd’hui
          </Button>
          <IconButton
            icon={ChevronRightIcon}
            label={view === 'month' ? 'Mois suivant' : 'Semaine suivante'}
            onClick={() => {
              setAnchor(stepAnchor(anchor, view, 1))
            }}
          />
          <h2 className="agenda-toolbar__title">
            <CalendarIcon size={18} />
            {periodTitle(anchor, view)}
          </h2>
        </div>
        <div className="agenda-toolbar__views" role="group" aria-label="Affichage">
          {(['month', 'week'] as const).map((choice) => (
            <Button
              key={choice}
              size="sm"
              variant={view === choice ? 'primary' : 'secondary'}
              aria-pressed={view === choice}
              onClick={() => {
                setView(choice)
              }}
            >
              {choice === 'month' ? 'Mois' : 'Semaine'}
            </Button>
          ))}
        </div>
      </div>

      {appointments.isError && (
        <p className="agenda-error" role="alert">
          <AlertIcon size={16} /> Agenda indisponible.{' '}
          <Button size="sm" onClick={() => void appointments.refetch()}>
            Réessayer
          </Button>
        </p>
      )}

      <AgendaCalendar
        days={days}
        anchor={anchor}
        today={today}
        view={view}
        byDay={byDay}
        onOpen={actions.open}
        onMenu={(appointment, position, alignRight) => {
          setMenu({ appointment, position, alignRight })
        }}
        onShowWeek={(day) => {
          setAnchor(day)
          setView('week')
        }}
      />

      {appointments.data?.items.length === 0 && (
        <p className="agenda-muted agenda-empty">
          Aucun rendez-vous sur cette période. « Synchroniser avec Calendly » rapatrie ceux qui ont été pris.
        </p>
      )}

      {menu && (
        <Menu
          label={`Suivi du rendez-vous avec ${menu.appointment.invitee_name}`}
          position={menu.position}
          alignRight={menu.alignRight}
          sections={appointmentMenu(menu.appointment, actions)}
          onClose={() => {
            setMenu(null)
          }}
        />
      )}

      {detail && (
        <AppointmentDrawer
          key={detail.id}
          appointment={detail}
          referents={referentChoices}
          busy={update.isPending}
          error={error}
          actions={actions}
          onPatch={(patch) => void apply(detail, patch)}
          onClose={() => {
            setDetail(null)
            setError(null)
          }}
        />
      )}

      {moving && (
        <MoveDialog
          appointment={moving}
          busy={update.isPending}
          error={error}
          onClose={() => {
            setMoving(null)
            setError(null)
          }}
          onConfirm={(startsAt, endsAt) => {
            void apply(moving, { starts_at: startsAt, ends_at: endsAt }).then((saved) => {
              if (saved) setMoving(null)
            })
          }}
        />
      )}

      {creating && (
        <CreateDialog
          day={range.start <= today && today <= range.end ? today : anchor}
          referents={referentChoices}
          busy={create.isPending}
          error={error}
          onClose={() => {
            setCreating(false)
            setError(null)
          }}
          onCreate={(appointment) => {
            setError(null)
            create.mutate(
              {
                invitee_name: appointment.invitee_name,
                starts_at: appointment.starts_at,
                ends_at: appointment.ends_at,
                referent_id: appointment.referent_id,
                ...(appointment.invitee_email ? { invitee_email: appointment.invitee_email } : {}),
                ...(appointment.company_name ? { company_name: appointment.company_name } : {}),
                ...(appointment.notes ? { notes: appointment.notes } : {}),
              },
              {
                onSuccess: () => {
                  setCreating(false)
                },
                onError: (caught) => {
                  setError(refusal(caught))
                },
              },
            )
          }}
        />
      )}
    </div>
  )
}
