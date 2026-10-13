import { describe, expect, it } from 'vitest'

import { cohortStartsOn, cohortStatus, sentSummary } from './cohortStatus'

const COHORTS = [
  { code: 'S37', starts_on: '2026-09-07', out_of_campaign: false, prospects: 52, to_send: 52, overdue: 52, to_send_steps: ['r2'] },
  { code: 'S39', starts_on: '2026-09-28', out_of_campaign: false, prospects: 50, to_send: 50, overdue: 0, to_send_steps: ['r1'] },
  { code: 'S40', starts_on: '2026-10-05', out_of_campaign: false, prospects: 9, to_send: 0, overdue: 0, to_send_steps: [] },
  { code: 'S0', starts_on: null, out_of_campaign: true, prospects: 3 },
]
const TODAY = '2026-10-07'

describe('Cohort status line', () => {
  it('says what the cohort prepares, coloured by how the week stands', () => {
    expect(cohortStatus('S37', COHORTS, TODAY)).toEqual({ label: 'R2', tone: 'danger' })
    expect(cohortStatus('S39', COHORTS, TODAY)).toEqual({ label: 'R1', tone: 'warning' })
  })

  it('says « envoyé », green, when nothing is left to send this week', () => {
    expect(cohortStatus('S40', COHORTS, TODAY)).toEqual({ label: 'envoyé', tone: 'success' })
  })

  it('names the week of a cohort not started, without colour', () => {
    expect(cohortStatus('S41', COHORTS, TODAY)).toEqual({ label: 'semaine du 12/10', tone: null })
    expect(cohortStatus('S43', COHORTS, TODAY)).toEqual({ label: 'semaine du 26/10', tone: null })
    expect(cohortStatus('S40', COHORTS, '2026-10-01')).toEqual({ label: 'semaine du 05/10', tone: null })
  })

  it('joins several steps in rank order, and dates an unknown cohort from the nearest earlier one', () => {
    const mixed = [{ ...COHORTS[0], to_send_steps: ['r1', 'r2'] }] as typeof COHORTS
    expect(cohortStatus('S37', mixed, TODAY).label).toBe('R1 · R2')
    expect(cohortStartsOn('S44', COHORTS)).toBe('2026-11-02')
    expect(cohortStartsOn('S36', COHORTS)).toBeNull()
    expect(cohortStatus('S36', COHORTS, TODAY)).toEqual({ label: 'à venir', tone: null })
  })
})

describe('sentSummary', () => {
  it('says which steps left a cohort, when and how many, and nothing before any send', () => {
    const cohorts = [
      {
        ...COHORTS[0],
        sent_steps: [
          { step: 'contact', label: 'Contact', count: 44, first_on: '2026-09-07', last_on: '2026-09-07' },
          { step: 'r1', label: 'R1', count: 43, first_on: '2026-09-21', last_on: '2026-09-22' },
        ],
      },
      COHORTS[1],
    ] as typeof COHORTS
    expect(sentSummary('S37', cohorts)).toBe('Contact le 07/09 (44) · R1 du 21/09 au 22/09 (43)')
    expect(sentSummary('S39', cohorts)).toBeNull()
    expect(sentSummary('S99', cohorts)).toBeNull()
  })
})

describe('cohortStatus once the mails are scheduled', () => {
  const step = (name: string, count: number, day: string) => ({ step: name, label: name, count, first_on: day, last_on: day })

  it('reads « prêt pour être envoyé le … » when everything due is scheduled, and the step only while some are left', () => {
    const due = { ...COHORTS[1], prospects: 47, to_send: 47, overdue: 0, to_send_steps: ['contact'] }
    const all = [{ ...due, scheduled_steps: [step('contact', 47, '2026-10-14')] }] as typeof COHORTS
    expect(cohortStatus('S39', all, '2026-10-13')).toEqual({ label: 'prêt pour être envoyé le 14/10/2026', tone: 'success' })
    const part = [{ ...due, scheduled_steps: [step('contact', 30, '2026-10-14')] }] as typeof COHORTS
    expect(cohortStatus('S39', part, '2026-10-13').label).toBe('Contact')
  })

  it('names the straggler and the next step of the others: « R1 : 1 mail prêt … · R2 prévu le 19/10/2026 »', () => {
    const cohort = {
      ...COHORTS[2],
      prospects: 42,
      to_send: 1,
      overdue: 0,
      to_send_steps: ['r1'],
      scheduled_steps: [step('r1', 1, '2026-10-14')],
      next_steps: [step('r2', 41, '2026-10-19')],
    }
    expect(cohortStatus('S40', [cohort] as typeof COHORTS, '2026-10-13').label).toBe(
      'R1 : 1 mail prêt pour être envoyé le 14/10/2026 · R2 prévu le 19/10/2026',
    )
    const quiet = { ...cohort, to_send: 0, to_send_steps: [], scheduled_steps: [] }
    expect(cohortStatus('S40', [quiet] as typeof COHORTS, '2026-10-13').label).toBe('R2 prévu le 19/10/2026')
  })
})
