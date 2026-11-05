import { describe, expect, it } from 'vitest'

import { frenchHolidays } from './holidays'

describe('French national public holidays', () => {
  it('matches the eleven official holidays for 2026, including movable dates', () => {
    expect(frenchHolidays(2026)).toEqual([
      { day: '2026-01-01', name: 'Jour de l’an' },
      { day: '2026-04-06', name: 'Lundi de Pâques' },
      { day: '2026-05-01', name: 'Fête du Travail' },
      { day: '2026-05-08', name: 'Victoire 1945' },
      { day: '2026-05-14', name: 'Ascension' },
      { day: '2026-05-25', name: 'Lundi de Pentecôte' },
      { day: '2026-07-14', name: 'Fête nationale' },
      { day: '2026-08-15', name: 'Assomption' },
      { day: '2026-11-01', name: 'Toussaint' },
      { day: '2026-11-11', name: 'Armistice 1918' },
      { day: '2026-12-25', name: 'Noël' },
    ])
  })

  it('recalculates movable holidays for the next year', () => {
    expect(frenchHolidays(2027)).toEqual(expect.arrayContaining([
      { day: '2027-03-29', name: 'Lundi de Pâques' },
      { day: '2027-05-06', name: 'Ascension' },
      { day: '2027-05-17', name: 'Lundi de Pentecôte' },
    ]))
  })

  it('preserves two holidays falling on the same day', () => {
    expect(frenchHolidays(2008).filter(({ day }) => day === '2008-05-01')).toEqual([
      { day: '2008-05-01', name: 'Fête du Travail' },
      { day: '2008-05-01', name: 'Ascension' },
    ])
  })
})
