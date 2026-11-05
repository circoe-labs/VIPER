import { describe, expect, it } from 'vitest'

import { calendarMood, celebrationsFor } from './seasonal'

describe('Calendar seasons and celebrations', () => {
  it('follows meteorological seasons at month and year boundaries', () => {
    expect(['2026-02-28', '2026-03-01', '2026-05-31', '2026-06-01', '2026-08-31', '2026-09-01', '2026-11-30', '2026-12-01', '2027-01-01'].map((day) => calendarMood(day).season)).toEqual([
      'winter', 'spring', 'spring', 'summer', 'summer', 'autumn', 'autumn', 'winter', 'winter',
    ])
  })

  it('uses a different motif for each season and festive October/December banners', () => {
    expect(['2026-04-01', '2026-07-01', '2026-11-01', '2026-01-01'].map((day) => calendarMood(day).symbol)).toEqual(['🌸', '☀️', '🍁', '❄️'])
    expect(calendarMood('2026-10-01').decorations).toEqual(['🍂', '🎃', '👻'])
    expect(calendarMood('2026-12-01').decorations).toEqual(['🎄', '🎅', '❄️'])
    expect(calendarMood('2026-11-01').decorations).toEqual(['🍂', '🍁', '🌰'])
  })

  it('repeats fixed celebrations every year without leaking into adjacent dates', () => {
    for (const year of [2026, 2027]) {
      const days = celebrationsFor(year)
      expect(days.get(`${String(year)}-10-31`)).toEqual({ name: 'Halloween', decorations: ['🎃', '👻'] })
      expect(days.get(`${String(year)}-12-25`)).toEqual({ name: 'Noël', decorations: ['🎄', '🎅'] })
      expect(days.has(`${String(year)}-10-30`)).toBe(false)
      expect(days.has(`${String(year)}-12-26`)).toBe(false)
    }
  })

  it('calculates Easter decorations from the movable holiday of each year', () => {
    expect(celebrationsFor(2026).get('2026-04-05')?.name).toBe('Pâques')
    expect(celebrationsFor(2026).get('2026-04-06')?.name).toBe('Lundi de Pâques')
    expect(celebrationsFor(2027).get('2027-03-28')?.name).toBe('Pâques')
    expect(celebrationsFor(2027).get('2027-03-29')?.name).toBe('Lundi de Pâques')
    expect(celebrationsFor(2027).has('2027-04-05')).toBe(false)
  })
})
