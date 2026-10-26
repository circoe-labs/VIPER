import type { MouseEvent } from 'react'

import type { Appointment } from '../api/agenda'
import { IconButton } from '../ui/Button'
import { MoreIcon } from '../ui/icons'
import type { Point } from '../ui/floating'
import { type AgendaView, dayFull, dayNumber, sameMonth, timeOf, weekdayShort } from './dates'
import { who } from './AppointmentParts'

const MAX_CHIPS_IN_MONTH = 3
const WEEKDAYS = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.']

interface CalendarProps {
  days: string[]
  anchor: string
  today: string
  view: AgendaView
  byDay: Map<string, Appointment[]>
  onOpen: (appointment: Appointment) => void
  // A right-click, or the « … » button, asks for the follow-up menu at a point of the screen.
  onMenu: (appointment: Appointment, position: Point, alignRight: boolean) => void
  // « +n autres » of a crowded day: that day's week.
  onShowWeek: (day: string) => void
}

function Chip({
  appointment,
  onOpen,
  onMenu,
}: Pick<CalendarProps, 'onOpen' | 'onMenu'> & { appointment: Appointment }) {
  const label = `${timeOf(appointment.starts_at)} ${who(appointment)}`
  return (
    <li className={`agenda-chip agenda-chip--${appointment.status}`}>
      <button
        type="button"
        className="agenda-chip__main"
        title={label}
        aria-label={`Rendez-vous ${label}`}
        onClick={() => {
          onOpen(appointment)
        }}
        onContextMenu={(event: MouseEvent) => {
          event.preventDefault()
          onMenu(appointment, { x: event.clientX, y: event.clientY }, false)
        }}
      >
        <span className="agenda-chip__time">{timeOf(appointment.starts_at)}</span>
        <span className="agenda-chip__who">{who(appointment)}</span>
      </button>
      <IconButton
        size="sm"
        icon={MoreIcon}
        label={`Actions du rendez-vous avec ${appointment.invitee_name}`}
        className="agenda-chip__more"
        onClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect()
          onMenu(appointment, { x: box.right, y: box.bottom }, true)
        }}
      />
    </li>
  )
}

// Days of the month or the week, Monday first. On a phone the grid becomes a list of the days that have something.
export function AgendaCalendar({ days, anchor, today, view, byDay, onOpen, onMenu, onShowWeek }: CalendarProps) {
  return (
    <div className={`agenda-grid agenda-grid--${view}`}>
      <div className="agenda-grid__head" aria-hidden="true">
        {WEEKDAYS.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div className="agenda-grid__days">
        {days.map((day) => {
          const items = byDay.get(day) ?? []
          const shown = view === 'month' ? items.slice(0, MAX_CHIPS_IN_MONTH) : items
          const hidden = items.length - shown.length
          const classes = [
            'agenda-day',
            day === today && 'agenda-day--today',
            view === 'month' && !sameMonth(day, anchor) && 'agenda-day--outside',
            items.length === 0 && 'agenda-day--empty',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <section key={day} className={classes} aria-label={dayFull(day)}>
              <h3 className="agenda-day__label">
                <span className="agenda-day__weekday">{weekdayShort(day)} </span>
                <span className="agenda-day__number">{dayNumber(day)}</span>
              </h3>
              {shown.length > 0 && (
                <ul className="agenda-day__list">
                  {shown.map((appointment) => (
                    <Chip key={appointment.id} appointment={appointment} onOpen={onOpen} onMenu={onMenu} />
                  ))}
                </ul>
              )}
              {hidden > 0 && (
                <button
                  type="button"
                  className="agenda-day__more"
                  onClick={() => {
                    onShowWeek(day)
                  }}
                >
                  +{hidden} autre{hidden > 1 ? 's' : ''}
                </button>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
