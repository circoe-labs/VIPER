import { readStorage, writeStorage } from '../lib/storage'

// Couleur d'accent choisie par la personne, gardée dans ce navigateur (tokens et variantes dans accent.css).
export const ACCENTS = [
  { id: 'green', label: 'Vert VIPER', swatch: 'var(--nc-viper-green)' },
  { id: 'blue', label: 'Bleu', swatch: 'var(--nc-accent-blue)' },
  { id: 'violet', label: 'Violet', swatch: 'var(--nc-accent-violet)' },
  { id: 'orange', label: 'Orange', swatch: 'var(--nc-accent-orange)' },
  { id: 'pink', label: 'Rose', swatch: 'var(--nc-accent-pink)' },
  { id: 'teal', label: 'Turquoise', swatch: 'var(--nc-accent-teal)' },
] as const

export type AccentId = (typeof ACCENTS)[number]['id']

export const ACCENT_STORAGE_KEY = 'viper.accent'

export function readStoredAccent(): AccentId {
  const stored = readStorage(ACCENT_STORAGE_KEY)
  return ACCENTS.find((accent) => accent.id === stored)?.id ?? 'green'
}

export function applyAccent(accent: AccentId): void {
  document.documentElement.dataset.accent = accent
}

export function saveAccent(accent: AccentId): void {
  writeStorage(ACCENT_STORAGE_KEY, accent)
  applyAccent(accent)
}
