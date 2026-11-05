import type { ProspectNote } from '../api/prospectNotes'

// « Connaît Robin » : l'état est porté par une note du prospect (texte fixe), la plus récente fait foi. Ainsi il reste
// visible dans l'éditeur (onglet Suivi) et dans l'historique, sans nouvelle colonne.
export const KNOWS_ROBIN = 'Connaît Robin'
export const DOES_NOT_KNOW_ROBIN = 'Ne connaît pas Robin'

export type RobinState = 'knows' | 'unknown'

export function robinStateOf(note: ProspectNote): RobinState | null {
  if (note.fact_text === KNOWS_ROBIN) return 'knows'
  if (note.fact_text === DOES_NOT_KNOW_ROBIN) return 'unknown'
  return null
}

// `notes` come newest first (the API's order): the first Robin note decides, the first other note is the last remark.
export function readNotes(notes: readonly ProspectNote[]): { state: RobinState | null; remark: ProspectNote | null } {
  let state: RobinState | null = null
  let remark: ProspectNote | null = null
  for (const note of notes) {
    const robin = robinStateOf(note)
    if (robin) state ??= robin
    else remark ??= note
  }
  return { state, remark }
}

// Today's local calendar day, `YYYY-MM-DD` (a note is dated the day it is written).
export function todayIso(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${String(now.getFullYear())}-${month}-${day}`
}
