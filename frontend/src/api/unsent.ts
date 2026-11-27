import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import type { MessageStatus } from './contact'
import { refreshAfterWrite } from './refresh'

// Where a prospect's send really stands (backend app/services/contact_send_state.py), and the scheduled mails that did
// not leave with their recovery by a person (app/services/contact_unsent.py).

// `doubt`: not scheduled and may have left; a person checks the sent items.
export type SendState = 'unconfirmed' | 'doubt' | 'missed' | 'scheduled' | 'unscheduled'

export interface SendSituation {
  state: SendState
  rank: number
  step: string
  step_label: string
  // The effective send moment, or the one that was missed.
  scheduled_at: string | null
  // A code (why), and when it happened.
  reason: string | null
  at: string | null
  draft_missing: boolean
  // The mail may have left: a person checks the sent items before it is scheduled again.
  needs_sent_check: boolean
}

export interface UnsentItem {
  message_id: string
  // In the prospect's open current sequence: only those can be scheduled again.
  current: boolean
  prospect_id: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  cohort_code: string | null
  status: MessageStatus
  revision: number
  kind: 'unconfirmed' | 'doubt' | 'missed' | 'draft_missing'
  send: SendSituation
}

export interface Unsent {
  items: UnsentItem[]
  // Scheduled mails whose Infomaniak draft could not be checked (more than 100 drafts in the mailbox).
  unverified_drafts: number
}

export interface RecoveryTarget {
  prospect_id: string
  rank: number
  expected_revision: number
  sent_check_confirmed: boolean
}

export interface RecoveryResult {
  done: number
  refused: { prospect_id: string; rank: number; code: string }[]
  remote_draft_failures: number
}

// Drafts are created one by one after a bulk recovery: long, but never endless.
export const RECOVERY_DEADLINE_MS = 180_000
const BATCH_MAX = 500

export const unsentKey = ['contact', 'unsent'] as const

export function useUnsent() {
  return useQuery({
    queryKey: unsentKey,
    queryFn: ({ signal }) => apiGet<Unsent>('/contact/unsent', signal),
    // The dispatcher changes these by itself.
    refetchInterval: 60_000,
  })
}

export function useRecoveryMutations() {
  const queryClient = useQueryClient()
  const refresh = () => refreshAfterWrite(queryClient, [['contact'], ['prospection'], ['sequences']])
  const post = <T,>(path: `/${string}`, body?: unknown) =>
    apiRequest<T>('POST', path, { body, signal: AbortSignal.timeout(RECOVERY_DEADLINE_MS) })
  return {
    reschedule: useMutation({
      mutationFn: ({ at, items }: { at: string; items: RecoveryTarget[] }) =>
        post<RecoveryResult>('/contact/unsent/reschedule', { scheduled_at: at, items: items.slice(0, BATCH_MAX) }),
      onSettled: refresh,
    }),
    recreate: useMutation({
      mutationFn: (items: RecoveryTarget[]) =>
        post<RecoveryResult>('/contact/unsent/recreate-drafts', { items: items.slice(0, BATCH_MAX) }),
      onSettled: refresh,
    }),
    // « Pas parti » : the person looked in the sent items; nothing is scheduled.
    confirm: useMutation({
      mutationFn: (items: { message_id: string; expected_revision: number }[]) =>
        post<Omit<RecoveryResult, 'remote_draft_failures'>>('/contact/unsent/confirm-not-sent', { items: items.slice(0, BATCH_MAX) }),
      onSettled: refresh,
    }),
    // « Marquer comme envoyé » on an existing mail the sheet cannot mark (beyond R2, or locked in a former contact
    // week): history only, nothing is sent.
    recordSent: useMutation({
      mutationFn: (item: { message_id: string; expected_revision: number }) => post<unknown>('/contact/unsent/record-sent', item),
      onSettled: refresh,
    }),
    check: useMutation({
      mutationFn: () => post<{ present: number; missing: number; unverified: number }>('/contact/unsent/check-drafts'),
      onSettled: refresh,
    }),
  }
}
