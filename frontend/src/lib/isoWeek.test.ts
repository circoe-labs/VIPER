import { describe, expect, it } from 'vitest'

import {
  addWeeks,
  isoWeekOf,
  mondayLabel,
  parseIsoWeek,
  relativeWeekLabel,
  sameWeek,
  weekBadgeLabel,
  weekMonday,
  weeksFrom,
  weeksInYear,
} from './isoWeek'

describe('ISO weeks', () => {
  it('finds the ISO week of a day, across year boundaries', () => {
    expect(isoWeekOf('2026-09-14')).toEqual({ year: 2026, week: 38 })
    expect(isoWeekOf('2026-12-31')).toEqual({ year: 2026, week: 53 })
    expect(isoWeekOf('2027-01-03')).toEqual({ year: 2026, week: 53 })
    expect(isoWeekOf('2027-01-04')).toEqual({ year: 2027, week: 1 })
    expect(isoWeekOf('2025-12-29')).toEqual({ year: 2026, week: 1 })
    expect(isoWeekOf('')).toBeNull()
    expect(isoWeekOf('14/09/2026')).toBeNull()
  })

  it('knows the 53-week years and the Monday of a week (what the planner stores)', () => {
    expect(weeksInYear(2026)).toBe(53)
    expect(weeksInYear(2027)).toBe(52)
    expect(weekMonday({ year: 2026, week: 38 })).toBe('2026-09-14')
    expect(weekMonday({ year: 2026, week: 1 })).toBe('2025-12-29')
    expect(weekMonday({ year: 2026, week: 53 })).toBe('2026-12-28')
  })

  it('parses the API week label and refuses a week the year does not have', () => {
    expect(parseIsoWeek('2026-W41')).toEqual({ year: 2026, week: 41 })
    expect(parseIsoWeek('2027-W53')).toBeNull()
    expect(parseIsoWeek('2026-41')).toBeNull()
    expect(parseIsoWeek(null)).toBeNull()
  })

  it('moves by weeks through the year change and measures the distance from today', () => {
    expect(addWeeks({ year: 2026, week: 52 }, 2)).toEqual({ year: 2027, week: 1 })
    expect(addWeeks({ year: 2027, week: 1 }, -1)).toEqual({ year: 2026, week: 53 })
    expect(weeksFrom('2026-09-30', { year: 2026, week: 42 })).toBe(2)
    expect(weeksFrom('2026-09-30', { year: 2026, week: 39 })).toBe(-1)
    expect(relativeWeekLabel('2026-09-30', { year: 2026, week: 40 })).toBe('cette semaine')
    expect(relativeWeekLabel('2026-09-30', { year: 2026, week: 41 })).toBe('dans 1 semaine')
    expect(relativeWeekLabel('2026-09-30', { year: 2026, week: 37 })).toBe('il y a 3 semaines')
  })

  it('formats the badge and the Monday', () => {
    expect(weekBadgeLabel({ year: 2027, week: 2 })).toBe('S02')
    expect(weekBadgeLabel({ year: 2026, week: 41 })).toBe('S41')
    expect(mondayLabel({ year: 2026, week: 41 })).toBe('lun. 5 oct.')
    expect(sameWeek({ year: 2026, week: 41 }, { year: 2026, week: 41 })).toBe(true)
    expect(sameWeek(null, { year: 2026, week: 41 })).toBe(false)
    expect(sameWeek(null, null)).toBe(true)
  })
})
