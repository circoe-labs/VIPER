import { isoWeekOf, type IsoWeek, mondayLabel, weekBadgeLabel } from '../lib/isoWeek'
import { Badge } from '../ui/Badge'
import { CalendarIcon } from '../ui/icons'

// A calendar (ISO) week of the Contact planning — never a cohort `Sxx` (sequences rework D5). Moved from the
// Prospection badges, which show the cohort instead; the Contact page is redone in S5.

// « Semaine 41 de 2026, du lun. 5 oct. »
export function weekTitle(week: IsoWeek): string {
  return `Semaine ${String(week.week)} de ${String(week.year)}, du ${mondayLabel(week)}`
}

// « S41 »; its year is written out when it is not the current one (« S02 · 2027 »), and is always in the tooltip and
// for screen readers.
export function WeekBadge({ week, today }: { week: IsoWeek; today: string }) {
  const otherYear = isoWeekOf(today)?.year !== week.year
  const title = weekTitle(week)
  return (
    <Badge tone="accent" icon={CalendarIcon} title={title}>
      <span className="visually-hidden">Prochaine action : {title}</span>
      <span aria-hidden="true">
        {weekBadgeLabel(week)}
        {otherYear && ` · ${String(week.year)}`}
      </span>
    </Badge>
  )
}
