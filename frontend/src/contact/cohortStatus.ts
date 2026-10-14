// The line of a cohort on the Contact page: « S37 · R2 · vert ». The status says what the cohort has to prepare this
// week, « envoyé » when it has nothing left to send, or the week it starts for a cohort not started yet; the colour
// says how the week stands (green nothing due, orange a mail to send this week, red a mail late).
import type { ContactDashboard } from '../api/contact'

export type ValidationTone = 'success' | 'warning' | 'danger'

export interface CohortStatus {
  label: string
  // Null when the cohort has not started: nothing to validate yet.
  tone: ValidationTone | null
}

type CohortSummary = NonNullable<ContactDashboard['cohorts']>[number]

const DAY_MS = 86_400_000

function utc(day: string): number {
  const [year = 0, month = 1, date = 1] = day.split('-').map(Number)
  return Date.UTC(year, month - 1, date)
}

function codeNumber(code: string): number {
  return Number(code.slice(1))
}

// « 2026-10-12 » → « 12/10 »
function dayMonth(day: string): string {
  const [, month = '', date = ''] = day.split('-')
  return `${date}/${month}`
}

// « 2026-10-14 » → « 14/10/2026 »
function fullDay(day: string): string {
  const [year = '', month = '', date = ''] = day.split('-')
  return `${date}/${month}/${year}`
}

// A cohort is one prospecting week, so an unknown one is dated from the nearest earlier cohort the base knows, a week
// per code (S38 was a week without prospecting: S39 is not dated from S37 but S40 is from S39).
export function cohortStartsOn(code: string, cohorts: readonly CohortSummary[]): string | null {
  const known = cohorts.find((cohort) => cohort.code === code && cohort.starts_on)
  if (known?.starts_on) return known.starts_on
  const wanted = codeNumber(code)
  const before = cohorts
    .filter((cohort) => cohort.starts_on && !cohort.out_of_campaign && codeNumber(cohort.code) < wanted)
    .sort((a, b) => codeNumber(b.code) - codeNumber(a.code))[0]
  if (!before?.starts_on) return null
  const weeks = wanted - codeNumber(before.code)
  return new Date(utc(before.starts_on) + weeks * 7 * DAY_MS).toISOString().slice(0, 10)
}

function stepLabel(step: string): string {
  return step === 'contact' ? 'Contact' : step.toUpperCase()
}

// The steps coming up after the one being sent, as « R2 prévu le 19/10/2026 » (the earliest day of each step).
function upcoming(summary: CohortSummary, due: readonly string[]): string[] {
  return (summary.next_steps ?? [])
    .filter((item) => !due.includes(item.step))
    .map((item) => `${stepLabel(item.step)} prévu le ${fullDay(item.first_on)}`)
}

export function cohortStatus(code: string, cohorts: readonly CohortSummary[], today: string): CohortStatus {
  const summary = cohorts.find((cohort) => cohort.code === code)
  const startsOn = cohortStartsOn(code, cohorts)
  const started = startsOn !== null && startsOn <= today
  if (!summary || summary.prospects === 0 || !started) {
    return { label: startsOn ? `semaine du ${dayMonth(startsOn)}` : 'à venir', tone: null }
  }
  const due = summary.to_send_steps ?? []
  const later = upcoming(summary, due)
  if ((summary.to_send ?? 0) > 0) {
    // Everything due is scheduled: « prêt pour être envoyé le 14/10/2026 » (the day, or the first and last day). When
    // only a few of the cohort are due (a straggler of an earlier step), the step and the count say so, and the
    // next step of the others follows: « R1 : 1 mail prêt … le 14/10/2026 · R2 prévu le 19/10/2026 ».
    const scheduled = (summary.scheduled_steps ?? []).filter((item) => due.includes(item.step))
    const scheduledCount = scheduled.reduce((total, item) => total + item.count, 0)
    const first = scheduled.map((item) => item.first_on).sort()[0]
    const last = scheduled.map((item) => item.last_on).sort().reverse()[0]
    const steps = due.map(stepLabel)
    if (first && last && scheduledCount >= (summary.to_send ?? 0)) {
      const when = first === last ? `le ${fullDay(first)}` : `du ${fullDay(first)} au ${fullDay(last)}`
      const everyone = (summary.to_send ?? 0) >= summary.prospects - (summary.appointments ?? 0)
      const ready = everyone
        ? `prêt pour être envoyé ${when}`
        : `${steps.join(' · ')} : ${String(summary.to_send ?? 0)} ${(summary.to_send ?? 0) > 1 ? 'mails prêts' : 'mail prêt'} pour être envoyé ${when}`
      return { label: [ready, ...later].join(' · '), tone: 'success' }
    }
    return {
      label: [steps.length > 0 ? steps.join(' · ') : 'à envoyer', ...later].join(' · '),
      tone: (summary.overdue ?? 0) > 0 ? 'danger' : 'warning',
    }
  }
  return { label: later.length > 0 ? later.join(' · ') : 'envoyé', tone: 'success' }
}

// What has really left a cohort, by step and day: « Contact le 07/09 · R1 le 21/09 · R2 du 12/10 au 14/10 (40) ». Null
// when nothing was sent yet.
export function sentSummary(code: string, cohorts: readonly CohortSummary[]): string | null {
  const steps = cohorts.find((cohort) => cohort.code === code)?.sent_steps ?? []
  if (steps.length === 0) return null
  return steps
    .map((step) => {
      const when =
        step.first_on === step.last_on ? `le ${dayMonth(step.first_on)}` : `du ${dayMonth(step.first_on)} au ${dayMonth(step.last_on)}`
      return `${step.label} ${when} (${String(step.count)})`
    })
    .join(' · ')
}

const SCHEDULABLE_STEPS = ['contact', 'r1', 'r2', 'r3', 'r4'] as const

// The first step of the cohort with people left to schedule: neither sent nor already scheduled. A follow-up counts
// only once the step before it has left for someone. Null when everything is sent or scheduled.
export function nextStepToSchedule(summary: CohortSummary | undefined): string | null {
  if (!summary) return null
  const people = summary.prospects - (summary.appointments ?? 0)
  const count = (list: CohortSummary['sent_steps'], step: string) =>
    list?.find((item) => item.step === step)?.count ?? 0
  for (const [index, step] of SCHEDULABLE_STEPS.entries()) {
    const previous = SCHEDULABLE_STEPS[index - 1]
    if (previous && count(summary.sent_steps, previous) === 0) return null
    if (people - count(summary.sent_steps, step) - count(summary.scheduled_steps, step) > 0) return step
  }
  return null
}
