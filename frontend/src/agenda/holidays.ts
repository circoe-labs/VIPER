import { addDays } from './dates'

interface Holiday {
  day: string
  name: string
}

// National French public holidays (regional additions are not included):
// https://www.service-public.gouv.fr/particuliers/vosdroits/F2405
export function frenchHolidays(year: number): Holiday[] {
  // Gregorian Easter, using the Meeus/Jones/Butcher algorithm. All day arithmetic is UTC.
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const value = h + l - 7 * m + 114
  const month = Math.floor(value / 31)
  const day = (value % 31) + 1
  const easter = `${String(year)}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  return [
    { day: `${String(year)}-01-01`, name: 'Jour de l’an' },
    { day: addDays(easter, 1), name: 'Lundi de Pâques' },
    { day: `${String(year)}-05-01`, name: 'Fête du Travail' },
    { day: `${String(year)}-05-08`, name: 'Victoire 1945' },
    { day: addDays(easter, 39), name: 'Ascension' },
    { day: addDays(easter, 50), name: 'Lundi de Pentecôte' },
    { day: `${String(year)}-07-14`, name: 'Fête nationale' },
    { day: `${String(year)}-08-15`, name: 'Assomption' },
    { day: `${String(year)}-11-01`, name: 'Toussaint' },
    { day: `${String(year)}-11-11`, name: 'Armistice 1918' },
    { day: `${String(year)}-12-25`, name: 'Noël' },
  ]
}
