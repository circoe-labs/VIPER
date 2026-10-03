import {
  NOTE_SCORE_DELTA_MAX,
  NOTE_SCORE_DELTA_MIN,
  NOTE_TEXT_MAX_LENGTH,
  type NoteInput,
  type NoteSourceType,
  type ProspectNote,
} from '../api/prospectNotes'
import { settingsRefusal } from '../api/settings'

// Draft, validation and copy of the Notes list of the Prospect editor (ProspectNotes.tsx). The server applies the same
// bounds (backend/app/services/prospect_notes.py); the form only says them before the request.

export const SOURCE_LABELS: Record<NoteSourceType, string> = {
  linkedin: 'LinkedIn',
  email: 'E-mail',
  phone: 'Téléphone',
  meeting: 'Rendez-vous',
  web: 'Web',
  other: 'Autre',
}

export interface NoteDraft {
  fact: string
  // `YYYY-MM-DD`, '' = undated.
  day: string
  // The typed delta ('' = none); a string so a half-typed sign is not lost.
  delta: string
  source_type: NoteSourceType | ''
  source_label: string
}

export function newNoteDraft(today: string): NoteDraft {
  return { fact: '', day: today, delta: '', source_type: '', source_label: '' }
}

export function draftFromNote(note: ProspectNote): NoteDraft {
  return {
    fact: note.fact_text,
    day: note.noted_on ?? '',
    delta: note.score_delta === null ? '' : String(note.score_delta),
    source_type: note.source_type ?? '',
    source_label: note.source_label ?? '',
  }
}

// `null` when the field is empty; NaN-free: an invalid text is reported by `validateNote`.
export function parseDelta(text: string): number | null {
  const trimmed = text.trim()
  return trimmed === '' || !/^[+-]?\d+$/.test(trimmed) ? null : Number(trimmed)
}

export type NoteErrors = Partial<Record<'fact' | 'delta', string>>

export function validateNote(draft: NoteDraft): NoteErrors {
  const errors: NoteErrors = {}
  const fact = draft.fact.trim()
  if (!fact) errors.fact = 'Saisissez le fait.'
  else if (fact.length > NOTE_TEXT_MAX_LENGTH) errors.fact = `${String(NOTE_TEXT_MAX_LENGTH)} caractères au plus.`
  const delta = draft.delta.trim()
  if (delta !== '') {
    const value = parseDelta(delta)
    if (value === null || value < NOTE_SCORE_DELTA_MIN || value > NOTE_SCORE_DELTA_MAX) {
      errors.delta = `Un entier de ${String(NOTE_SCORE_DELTA_MIN)} à +${String(NOTE_SCORE_DELTA_MAX)}.`
    }
  }
  return errors
}

// The write payload: empty optional fields are sent as null (a PATCH then clears them).
export function toNoteInput(draft: NoteDraft): Required<NoteInput> {
  return {
    fact_text: draft.fact.trim(),
    noted_on: draft.day || null,
    source_type: draft.source_type || null,
    source_label: draft.source_label.trim() || null,
    score_delta: parseDelta(draft.delta),
  }
}

// `+5`, `-10`, `0`: the sign is text, so the badge never relies on its colour.
export function formatDelta(delta: number): string {
  return delta > 0 ? `+${String(delta)}` : String(delta)
}

// A failed note write, in French, from the server's own refusal when it names one.
export function noteRefusalMessage(error: unknown): string {
  const refusal = settingsRefusal(error)
  if (refusal?.code === 'not_found') return 'Cette note ou ce prospect n’existe plus : rechargez la fiche.'
  if (refusal?.code === 'invalid') {
    if (refusal.field === 'fact_text') {
      return refusal.reason === 'blank' ? 'Saisissez le fait.' : `${String(NOTE_TEXT_MAX_LENGTH)} caractères au plus.`
    }
    if (refusal.field === 'score_delta') return `Impact sur le score : un entier de ${String(NOTE_SCORE_DELTA_MIN)} à +${String(NOTE_SCORE_DELTA_MAX)}.`
    if (refusal.field === 'source_label') return 'Source trop longue (200 caractères au plus).'
  }
  return 'L’opération sur la note a échoué. Vérifiez la connexion puis réessayez.'
}
