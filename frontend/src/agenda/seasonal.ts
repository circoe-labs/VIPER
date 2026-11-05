import { addDays } from './dates'
import { frenchHolidays } from './holidays'

export type Season = 'spring' | 'summer' | 'autumn' | 'winter'

interface CalendarMood {
  season: Season
  name: string
  title: string
  symbol: string
  decorations: readonly string[]
}

const SEASONS: Record<Season, CalendarMood> = {
  spring: { season: 'spring', name: 'Printemps', title: 'Le printemps s’invite', symbol: '🌸', decorations: ['🌷', '🦋', '🌼'] },
  summer: { season: 'summer', name: 'Été', title: 'Un air d’été', symbol: '☀️', decorations: ['🌻', '☀️', '🏖️'] },
  autumn: { season: 'autumn', name: 'Automne', title: 'Les couleurs de l’automne', symbol: '🍁', decorations: ['🍂', '🍁', '🌰'] },
  winter: { season: 'winter', name: 'Hiver', title: 'Un hiver tout en douceur', symbol: '❄️', decorations: ['❄️', '☃️', '❄️'] },
}

// Meteorological seasons in France: March–May, June–August, September–November, December–February.
// The atmosphere follows the displayed period, including when browsing another year.
export function calendarMood(day: string): CalendarMood {
  const month = Number(day.slice(5, 7))
  const season = month >= 3 && month <= 5 ? 'spring' : month >= 6 && month <= 8 ? 'summer' : month >= 9 && month <= 11 ? 'autumn' : 'winter'
  const mood = SEASONS[season]
  if (month === 10) return { ...mood, title: 'Un air d’Halloween', decorations: ['🍂', '🎃', '👻'] }
  if (month === 12) return { ...mood, title: 'Décembre en fête', decorations: ['🎄', '🎅', '❄️'] }
  return mood
}

export interface Celebration {
  name: string
  decorations: readonly string[]
}

// Decorative occasions only: they do not create appointments or additional public holidays.
const OCCASIONS: Record<string, Celebration> = {
  '01-01': { name: 'Jour de l’an', decorations: ['🎉', '✨'] },
  '02-02': { name: 'Chandeleur', decorations: ['🥞', '✨'] },
  '02-14': { name: 'Saint-Valentin', decorations: ['💌', '💕'] },
  '04-01': { name: 'Poisson d’avril', decorations: ['🐟', '🫧'] },
  '05-01': { name: 'Fête du Travail', decorations: ['🌿', '💐'] },
  '06-21': { name: 'Fête de la musique', decorations: ['🎵', '🎶'] },
  '07-14': { name: 'Fête nationale', decorations: ['🎆', '🇫🇷'] },
  '10-31': { name: 'Halloween', decorations: ['🎃', '👻'] },
  '12-24': { name: 'Réveillon de Noël', decorations: ['🎄', '🌟'] },
  '12-25': { name: 'Noël', decorations: ['🎄', '🎅'] },
  '12-31': { name: 'Saint-Sylvestre', decorations: ['🎉', '🥂'] },
}

export function celebrationsFor(year: number): Map<string, Celebration> {
  const days = new Map(Object.entries(OCCASIONS).map(([day, occasion]) => [`${String(year)}-${day}`, occasion]))
  const easterMonday = frenchHolidays(year).find((holiday) => holiday.name === 'Lundi de Pâques')
  if (easterMonday) {
    days.set(addDays(easterMonday.day, -1), { name: 'Pâques', decorations: ['🐣', '🥚'] })
    days.set(easterMonday.day, { name: 'Lundi de Pâques', decorations: ['🐰', '🥚'] })
  }
  return days
}
