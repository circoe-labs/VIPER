import { type MouseEvent, useMemo } from 'react'

import type { Appointment } from '../api/agenda'
import { IconButton } from '../ui/Button'
import { MoreIcon } from '../ui/icons'
import type { Point } from '../ui/floating'
import { type AgendaView, dayFull, dayNumber, sameMonth, timeOf, weekdayShort } from './dates'
import { who } from './AppointmentParts'
import { frenchHolidays } from './holidays'
import { calendarMood, type Celebration, celebrationsFor } from './seasonal'
import { SeasonBanner } from './SeasonBanner'

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
    <li className={`agenda-chip agenda-chip--${appointment.source} agenda-chip--${appointment.status}`}>
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
  const mood = calendarMood(anchor)
  const { holidays, celebrations } = useMemo(() => {
    const grouped = new Map<string, string[]>()
    const occasions = new Map<string, Celebration>()
    const years = new Set(days.map((day) => Number(day.slice(0, 4))))
    for (const year of years) {
      for (const [day, occasion] of celebrationsFor(year)) occasions.set(day, occasion)
      for (const holiday of frenchHolidays(year)) {
        grouped.set(holiday.day, [...(grouped.get(holiday.day) ?? []), holiday.name])
      }
    }
    return { holidays: grouped, celebrations: occasions }
  }, [days])

  return (
    <div className={`agenda-grid agenda-grid--${view} agenda-grid--${mood.season}`}>
      <SeasonBanner day={anchor} />
      <div className="agenda-grid__head" aria-hidden="true">
        {WEEKDAYS.map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div className="agenda-grid__days">
        {days.map((day) => {
          const items = byDay.get(day) ?? []
          const holidayNames = holidays.get(day) ?? []
          const celebration = celebrations.get(day)
          const shown = view === 'month' ? items.slice(0, MAX_CHIPS_IN_MONTH) : items
          const hidden = items.length - shown.length
          const classes = [
            'agenda-day',
            day === today && 'agenda-day--today',
            view === 'month' && !sameMonth(day, anchor) && 'agenda-day--outside',
            holidayNames.length > 0 && 'agenda-day--holiday',
            celebration && 'agenda-day--celebration',
            items.length === 0 && holidayNames.length === 0 && !celebration && 'agenda-day--empty',
          ]
            .filter(Boolean)
            .join(' ')
          return (
            <section key={day} className={classes} aria-label={dayFull(day)}>
              <h3 className="agenda-day__label">
                <span className="agenda-day__weekday">{weekdayShort(day)} </span>
                <span className="agenda-day__number">{dayNumber(day)}</span>
              </h3>
              {celebration && (
                <div className="agenda-day__celebration" title={holidayNames.includes(celebration.name) ? `Jour férié : ${celebration.name}` : celebration.name}>
                  <span className="agenda-day__festive-icons" aria-hidden="true">
                    {celebration.decorations.map((symbol, index) => <span key={index}>{symbol}</span>)}
                  </span>
                  <span className={holidayNames.includes(celebration.name) ? 'agenda-day__holiday' : 'agenda-day__occasion'}>{celebration.name}</span>
                </div>
              )}
              {holidayNames.filter((name) => name !== celebration?.name).map((name) => (
                <p key={name} className="agenda-day__holiday" title={`Jour férié : ${name}`}>
                  {name}
                </p>
              ))}
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
              <span className="agenda-day__season-mark" aria-hidden="true">{calendarMood(day).symbol}</span>
            </section>
          )
        })}
      </div>
    </div>
  )
}
