const DAY = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })

// The cohorts' contact days: each week of the campaign is worked on its own weekday, so a week is never forgotten.
// (ISO weekday: 1 = Monday.)
const PLAN = [
  { cohort: 'S37', weekday: 1 },
  { cohort: 'S39', weekday: 2 },
  { cohort: 'S40', weekday: 3 },
  { cohort: 'S41', weekday: 4 },
] as const

function isoWeekday(date: Date): number {
  return date.getUTCDay() === 0 ? 7 : date.getUTCDay()
}

// `2026-10-06` → the date of that weekday in the same ISO week.
function dayOfWeek(today: string, weekday: number): Date {
  const date = new Date(`${today}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + weekday - isoWeekday(date))
  return date
}

// « Semaine X à contacter le … »: replaces the former « Prochaines actions »; today's cohort is highlighted.
export function WeekToContact({ today }: { today: string }) {
  const current = isoWeekday(new Date(`${today}T00:00:00Z`))
  return (
    <section className="home-panel" aria-labelledby="home-week-title">
      <header className="home-panel__header">
        <h2 id="home-week-title" className="home-panel__title">
          Semaine à contacter
        </h2>
      </header>
      <ul className="week-plan">
        {PLAN.map(({ cohort, weekday }) => (
          <li key={cohort} className="week-plan__item" aria-current={weekday === current ? 'date' : undefined}>
            <strong>Semaine {cohort.slice(1)}</strong> à contacter le {DAY.format(dayOfWeek(today, weekday))}
            {weekday === current && <span className="week-plan__today"> · aujourd’hui</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}
