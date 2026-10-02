import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import { contactKeys } from './contact'
import { historyKeys } from './history'
import { homeKeys } from './home'
import { prospectionKeys } from './prospection'
import type { CohortRef, PauseReason } from './prospects'
import { refreshAfterWrite } from './refresh'
import { settingsKeys } from './settings'

// Mirrors backend/app/api/routes/sequences.py (where a prospect stands, its sequences, the change of cohort, the quality
// alerts) and the « Marquer comme envoyé » route of contact_messages.py (sequences rework D1-D9). Rules and refusal
// codes: doc/features/prospect-editor.md (Séquence de contact), doc/features/contact.md.

export type SendSource = 'manual' | 'import' | 'migration' | 'worker'
export type MessageStatus = 'draft' | 'validated' | 'scheduled' | 'sent' | 'cancelled'
export type SequenceEndReason = 'cohort_changed' | 'cohort_removed' | 'completed'
export type AlertType = 'email_error' | 'function_to_check' | 'data_inconsistent' | 'company_to_check' | 'import_conflict'
export type AlertSource = 'human' | 'import' | 'ai'

// Where the prospect stands (derived): its cohort and open sequence, the real sends, the step to send next and when.
// `level` is the key the UI words (levelLabel); `level_label` names the next step (« R2 », « Relance terminée »).
export interface Place {
  cohort: CohortRef | null
  sequence_id: string | null
  sequence_open: boolean
  sent_count: number
  level_label: string | null
  level: string | null
  // `contact`, `r1`…; null when finished or without cohort.
  next_step: string | null
  finished: boolean
  next_due_at: string | null
  next_due_on: string | null
  next_due_week: string | null
  pause_reason: PauseReason | null
  email_error: boolean
  max_follow_ups: number
}

export interface SequenceMessage {
  message_id: string
  rank: number
  step: string
  // « Contact », « R1 »…
  step_label: string
  status: MessageStatus
  sent_at: string | null
  sent_source: SendSource | null
  has_content: boolean
}

export interface Sequence {
  id: string
  cohort: CohortRef
  is_current: boolean
  opened_at: string
  closed_at: string | null
  end_reason: SequenceEndReason | null
  sent_count: number
  // By rank, every status (a cancelled or draft message is part of what happened).
  messages: SequenceMessage[]
}

export interface ProspectSequences {
  prospect_id: string
  place: Place
  // Current first, then newest first: a change of cohort never erases anything.
  sequences: Sequence[]
}

export interface CohortChange {
  place: Place
  // False when the cohort asked for already was the open sequence's.
  changed: boolean
  // The state the new cohort put back to « En séquence » (R-11); null when the state was kept.
  resumed_from: string | null
  cancelled_messages: number
  in_flight_messages: number
}

// `detail` of an alert: structured, value-light context. An import conflict carries the field, both values and where
// the file said it (R-18).
export interface AlertDetail {
  field?: string
  viper_value?: unknown
  file_value?: unknown
  reason?: string
  import_batch_id?: string
  file?: string
  sheet?: string
  row?: number
  [key: string]: unknown
}

export interface QualityAlert {
  id: string
  prospect_id: string | null
  company_id: string | null
  type: AlertType
  source: AlertSource
  note: string | null
  detail: AlertDetail
  raised_by_type: 'human' | 'import' | 'system' | 'agent'
  raised_by: string
  raised_at: string
  open: boolean
  resolved_at: string | null
  resolved_by: string | null
  resolution_note: string | null
}

interface AlertPage {
  items: QualityAlert[]
  total: number
  limit: number
  offset: number
}

export interface MarkSentResult {
  message: { id: string; rank: number; step: string; status: MessageStatus; sent_at: string | null }
  created: boolean
  changed: boolean
}

export const sequenceKeys = {
  // Invalidate after any prospect write: a state, the opposition or a send moves the place.
  all: ['sequences'] as const,
  prospect: (id: string) => ['sequences', id] as const,
}

export const alertKeys = {
  all: ['alerts'] as const,
  prospect: (id: string) => ['alerts', 'prospect', id] as const,
}

function prospectPath(id: string): `/${string}` {
  return `/prospects/${encodeURIComponent(id)}`
}

export function useProspectSequences(prospectId: string) {
  return useQuery({
    queryKey: sequenceKeys.prospect(prospectId),
    queryFn: ({ signal }) => apiGet<ProspectSequences>(`${prospectPath(prospectId)}/sequences`, signal),
  })
}

// Every alert of the prospect, open and resolved (newest first; at most 100: a prospect has a handful).
export function useProspectAlerts(prospectId: string) {
  return useQuery({
    queryKey: alertKeys.prospect(prospectId),
    queryFn: ({ signal }) =>
      apiGet<AlertPage>(`/alerts?prospect=${encodeURIComponent(prospectId)}&state=all&limit=100`, signal),
  })
}

// Writes on a prospect's sequence or alerts: the prospect (its version and derived contact), its sequences and alerts,
// its history, and every list that shows a level or a pause (Prospection, Contact, Home, the cohorts' counts) are read
// again.
export function useSequenceMutations(prospectId: string) {
  const queryClient = useQueryClient()
  const refresh = () =>
    refreshAfterWrite(queryClient, [
      ['prospects', prospectId],
      sequenceKeys.prospect(prospectId),
      alertKeys.prospect(prospectId),
      historyKeys.subject('prospects', prospectId),
      prospectionKeys.all,
      contactKeys.all,
      homeKeys.all,
      settingsKeys.cohorts,
    ])
  return {
    changeCohort: useMutation({
      mutationFn: (cohortId: string | null) =>
        apiRequest<CohortChange>('PUT', `${prospectPath(prospectId)}/cohort`, { body: { cohort_id: cohortId } }),
      onSuccess: refresh,
    }),
    // `rank` and `sequenceId` are what the person saw: a replay answers the recorded send, a sequence changed since is
    // refused (409 `sequence_changed`).
    markSent: useMutation({
      mutationFn: ({ rank, sequenceId, sentAt }: { rank: number; sequenceId: string; sentAt: string | null }) =>
        apiRequest<MarkSentResult>('POST', `${prospectPath(prospectId)}/messages/mark-sent`, {
          body: { rank, sequence_id: sequenceId, ...(sentAt ? { sent_at: sentAt } : {}) },
        }),
      onSuccess: refresh,
    }),
    raiseAlert: useMutation({
      mutationFn: ({ type, note }: { type: AlertType; note: string | null }) =>
        apiRequest<QualityAlert>('POST', '/alerts', { body: { type, prospect_id: prospectId, note } }),
      onSuccess: refresh,
    }),
    resolveAlert: useMutation({
      mutationFn: ({ id, note }: { id: string; note: string | null }) =>
        apiRequest<QualityAlert>('POST', `/alerts/${encodeURIComponent(id)}/resolve`, { body: { note } }),
      onSuccess: refresh,
    }),
  }
}
