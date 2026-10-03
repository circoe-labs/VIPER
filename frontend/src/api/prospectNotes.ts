import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import { historyKeys } from './history'
import { prospectKeys } from './prospects'
import { refreshAfterWrite } from './refresh'

// Mirrors the notes routes of backend/app/api/routes/prospects.py (prospect-contact-ux S1): short dated facts about a
// prospect, optionally carrying a score delta. They are written on their own, outside the editor's aggregate `version`.
// Rules: doc/features/prospect-editor.md (Notes and score).

export const NOTE_SOURCE_TYPES = ['linkedin', 'email', 'phone', 'meeting', 'web', 'other'] as const
export type NoteSourceType = (typeof NOTE_SOURCE_TYPES)[number]

// Same bounds as the backend (models/prospects.py).
export const NOTE_TEXT_MAX_LENGTH = 1000
export const NOTE_SCORE_DELTA_MIN = -50
export const NOTE_SCORE_DELTA_MAX = 50

export interface ProspectNote {
  id: string
  prospect_id: string
  fact_text: string
  // Business day `YYYY-MM-DD`, null when the fact is undated.
  noted_on: string | null
  source_type: NoteSourceType | null
  source_label: string | null
  // Manual score contribution, signed; null = none.
  score_delta: number | null
  created_at: string
  updated_at: string
}

export interface NoteInput {
  fact_text: string
  noted_on?: string | null
  source_type?: NoteSourceType | null
  source_label?: string | null
  score_delta?: number | null
}

// PATCH: a field left out is kept, `null` clears an optional one (not `fact_text`).
export type NotePatch = Partial<NoteInput>

export const noteKeys = {
  list: (prospectId: string) => ['prospects', prospectId, 'notes'] as const,
}

function notesPath(prospectId: string): `/${string}` {
  return `/prospects/${encodeURIComponent(prospectId)}/notes`
}

export function useProspectNotes(prospectId: string) {
  return useQuery({
    queryKey: noteKeys.list(prospectId),
    queryFn: ({ signal }) => apiGet<ProspectNote[]>(notesPath(prospectId), signal),
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
}

// A note write refreshes the list, the prospect's history (the write is audited) and the prospect's view (its `score`
// changes with a delta; the editor keeps its own form, only the score reader follows).
export function useNoteMutations(prospectId: string) {
  const queryClient = useQueryClient()
  const written = () =>
    refreshAfterWrite(queryClient, [noteKeys.list(prospectId), historyKeys.subject('prospects', prospectId), prospectKeys.detail(prospectId)])
  return {
    create: useMutation({
      mutationFn: (input: NoteInput) => apiRequest<ProspectNote>('POST', notesPath(prospectId), { body: input }),
      onSuccess: written,
    }),
    update: useMutation({
      mutationFn: ({ id, patch }: { id: string; patch: NotePatch }) =>
        apiRequest<ProspectNote>('PATCH', `${notesPath(prospectId)}/${encodeURIComponent(id)}`, { body: patch }),
      onSuccess: written,
    }),
    remove: useMutation({
      mutationFn: (id: string) => apiRequest<undefined>('DELETE', `${notesPath(prospectId)}/${encodeURIComponent(id)}`),
      onSuccess: written,
    }),
  }
}
