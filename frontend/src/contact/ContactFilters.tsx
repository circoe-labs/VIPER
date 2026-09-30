import type { ReactNode } from 'react'

import type { ContactDashboard } from '../api/contact'
import { mondayLabel } from '../lib/isoWeek'
import { TRACKING_LABELS } from '../prospection/labels'
import { SelectField } from '../ui/fields'
import { CONTACT_STATES, type ContactView, type WeekChoice } from './criteria'

interface ContactFiltersProps {
  view: ContactView
  dashboard: ContactDashboard | undefined
  onChange: (patch: Partial<ContactView>) => void
  // Search box, placed first.
  search: ReactNode
}

const NUMBER = new Intl.NumberFormat('fr-FR')

// « S41 · lun. 5 oct. 2026 (3) »
function weekOption(week: { year: number; number: number; count: number }): string {
  const label = `S${String(week.number).padStart(2, '0')} · ${mondayLabel({ year: week.year, week: week.number })} ${String(week.year)}`
  return `${label} (${NUMBER.format(week.count)})`
}

// The toolbar of the Contact list, in one bordered surface like Prospection's: search, the next-action week
// (« Cette semaine » by default — the server's current week —, a week of the planning, or every week) and the state.
export function ContactFilters({ view, dashboard, onChange, search }: ContactFiltersProps) {
  const weeks = dashboard?.weeks ?? []
  const current = dashboard?.current_week
  // A week typed in the URL that the planning does not hold (any more) stays selectable.
  const unknownWeek = view.week !== 'current' && view.week !== 'all' && !weeks.some((week) => week.week === view.week)
  return (
    <div className="contact-toolbar" role="search" aria-label="Filtrer la liste">
      <div className="contact-toolbar__search">{search}</div>
      <div className="contact-toolbar__select">
        <SelectField
          label="Semaine"
          value={view.week}
          onChange={(event) => {
            onChange({ week: event.target.value as WeekChoice, page: 1 })
          }}
        >
          <option value="current">Cette semaine{current ? ` (${current.slice(-3).replace('W', 'S')})` : ''}</option>
          <option value="all">Toutes les semaines</option>
          {unknownWeek && <option value={view.week}>{view.week.replace('-W', ' · S')}</option>}
          {weeks
            .filter((week) => week.week !== current)
            .map((week) => (
              <option key={week.week} value={week.week}>
                {weekOption(week)}
              </option>
            ))}
        </SelectField>
      </div>
      <div className="contact-toolbar__select">
        <SelectField
          label="État"
          value={view.state ?? ''}
          onChange={(event) => {
            const value = event.target.value
            onChange({ state: value === '' ? null : (value as ContactView['state']), page: 1 })
          }}
        >
          <option value="">Tous les états</option>
          {CONTACT_STATES.map((state) => (
            <option key={state} value={state}>
              {TRACKING_LABELS[state]}
            </option>
          ))}
        </SelectField>
      </div>
    </div>
  )
}
