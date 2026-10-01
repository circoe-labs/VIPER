import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import { historyKeys } from './history'
import type { ActivityStatus, TrackingStatus } from './prospection'
import { refreshAfterWrite } from './refresh'
import type { ToolboxState } from './toolbox'

// Mirrors backend/app/api/routes/contact.py (the Contact dashboard and list) and contact_messages.py (the mail
// sequence Contact / R1 / R2 of one prospect). Rules and refusal codes: doc/features/contact.md.

export const CONTACT_COUNTERS = ['to_handle', 'first_contact', 'follow_up', 'review', 'appointments'] as const
export type ContactCounter = (typeof CONTACT_COUNTERS)[number]

export const MESSAGE_STEPS = ['contact', 'r1', 'r2'] as const
export type MessageStep = (typeof MESSAGE_STEPS)[number]
export type MessageStatus = 'draft' | 'validated' | 'scheduled' | 'sent' | 'cancelled'
// What the next action prepares: a step's mail, or the human review after R2.
export type NextStep = MessageStep | 'review'

// Every Contact state can be filtered but `ignored` (terminal, outside Contact).
export type ContactState = Exclude<TrackingStatus, 'ignored'>

export interface ContactWeekOption {
  // `2026-W41`
  week: string
  year: number
  number: number
  count: number
}

export interface ContactDashboard {
  // Business day, `YYYY-MM-DD`.
  today: string
  // The server's « cette semaine », `2026-W41`.
  current_week: string
  counts: Record<ContactCounter, number>
  // ISO weeks present in the planning, oldest first.
  weeks: ContactWeekOption[]
}

export interface ContactRow {
  id: string
  civility: 'mr' | 'ms' | null
  first_name: string | null
  last_name: string | null
  exact_job_title: string | null
  role_label: string | null
  company_id: string | null
  company_name: string | null
  primary_email: string | null
  activity_status: ActivityStatus
  tracking_status: TrackingStatus
  planned_contact_at: string | null
  next_action_week: string | null
  // In « À traiter cette semaine ».
  due: boolean
  next_step: NextStep | null
  // Status of each step's message, null when never created.
  messages: Record<MessageStep, MessageStatus | null>
}

export interface ContactPage {
  items: ContactRow[]
  total: number
  limit: number
  offset: number
}

export interface ContactListCriteria {
  counter: ContactCounter | null
  // `2026-W41`, or null for every week.
  week: string | null
  state: ContactState | null
  q: string
}

export const CONTACT_PAGE_SIZE = 50

export interface Message {
  id: string
  prospect_id: string
  step: MessageStep
  status: MessageStatus
  from_email: string | null
  to: string[]
  cc: string[]
  bcc: string[]
  subject: string
  body_text: string
  // Changes with the content (and a reopening), never with validate/schedule/unschedule/cancel.
  revision: number
  validated_revision: number | null
  validated_at: string | null
  // Display name of the person who validated.
  validated_by: string | null
  scheduled_at: string | null
  sent_at: string | null
  cancelled_at: string | null
  // `manual` | `prospect_state:<state>` | `do_not_contact`
  cancel_reason: string | null
  generation_model: string | null
  generation_prompt_version: string | null
  generated_at: string | null
  has_remote_draft: boolean
  last_error_code: string | null
  last_error_at: string | null
  created_at: string
  updated_at: string
}

export interface MessageSequence {
  sequence: {
    prospect_id: string
    state: TrackingStatus | null
    do_not_contact: boolean
    // No message may be created, edited, validated, scheduled or reopened.
    closed: boolean
  }
  // `generation_available`: the AI drafting is configured on the server (S5). `toolbox_connected`: the CIRCOE Toolbox
  // is connected (S6) — a validation creates the Infomaniak draft, sent from the account's default mailbox;
  // `toolbox_state` tells an enabled but unconnected (or expired) Toolbox from a disabled one.
  defaults: {
    from_email: string | null
    to: string[]
    generation_available: boolean
    toolbox_connected: boolean
    toolbox_state: ToolboxState
  }
  steps: { step: MessageStep; message: Message | null }[]
}

export interface MessageResult {
  message: Message
  created: boolean
  changed: boolean
  // An edit put a validated/scheduled message back to draft.
  unvalidated: boolean
  // validate / schedule / remote-draft (S6): what happened to the Infomaniak draft. `failed` carries a `toolbox_*` code.
  remote_draft?: {
    status:
      | 'disabled'
      | 'not_connected'
      | 'not_applicable'
      | 'already_present'
      | 'created'
      | 'recovered'
      | 'stale'
      | 'failed'
    code: string | null
  }
}

// `POST …/messages/{step}/generate` (S5): the AI draft of the step, always a draft. `replace` confirms that a saved
// subject/body is replaced; `instruction` is the person's « consigne » (≤ 1000 characters).
export interface GenerateRequest {
  expected_revision?: number
  instruction?: string
  replace?: boolean
}

export interface GenerationResult extends MessageResult {
  generation: { model: string; prompt_version: string }
}

// `PUT …/messages/{step}` body: without `expected_revision` it creates the step's message.
export interface MessageContent {
  expected_revision?: number
  from_email: string | null
  subject: string
  body_text: string
  to: string[]
  cc: string[]
  bcc: string[]
}

// `remote-draft` (S6): create again the Infomaniak draft of a validated message (« Réessayer »).
export type MessageAction = 'validate' | 'unschedule' | 'cancel' | 'reopen' | 'remote-draft'

export const contactKeys = {
  // Invalidate after any prospect or message write: the counters, the list's state and message chips move.
  all: ['contact'] as const,
  dashboard: (q: string) => ['contact', 'dashboard', q] as const,
  page: (criteria: ContactListCriteria, page: number) => ['contact', 'page', criteria, page] as const,
  messages: (prospectId: string) => ['contact', 'messages', prospectId] as const,
}

export function useContactDashboard(q: string) {
  return useQuery({
    queryKey: contactKeys.dashboard(q.trim()),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      return apiGet<ContactDashboard>(`/contact/dashboard?${params.toString()}`, signal)
    },
    placeholderData: keepPreviousData,
  })
}

function listPath(criteria: ContactListCriteria, limit: number, offset: number): `/${string}` {
  const params = new URLSearchParams()
  if (criteria.counter) params.set('counter', criteria.counter)
  if (criteria.week) params.set('week', criteria.week)
  if (criteria.state) params.set('state', criteria.state)
  if (criteria.q.trim()) params.set('q', criteria.q.trim())
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  return `/contact/prospects?${params.toString()}`
}

function pagePath(criteria: ContactListCriteria, page: number): `/${string}` {
  return listPath(criteria, CONTACT_PAGE_SIZE, (page - 1) * CONTACT_PAGE_SIZE)
}

// `page` is 1-based. `enabled` false while the page does not know yet which week « cette semaine » is.
export function useContactPage(criteria: ContactListCriteria, page: number, enabled = true) {
  return useQuery({
    queryKey: contactKeys.page(criteria, page),
    queryFn: ({ signal }) => apiGet<ContactPage>(pagePath(criteria, page), signal),
    placeholderData: keepPreviousData,
    enabled,
  })
}

// The list's order, every page, read once when the workbench opens and kept while it stays open: « Précédent » /
// « Suivant » walk it past a page and are not reshuffled when a save moves the person out of the filtered list. Kept
// outside `contactKeys.all` (no refresh after writes); dropped as soon as the workbench closes (gcTime 0).
const WALK_PAGE = 200
const WALK_MAX = 2000

export function useContactWalk(criteria: ContactListCriteria | null, enabled: boolean) {
  return useQuery({
    queryKey: ['contact-walk', criteria],
    queryFn: async ({ signal }) => {
      const ids: string[] = []
      for (let offset = 0; offset < WALK_MAX; offset += WALK_PAGE) {
        if (!criteria) break
        const page = await apiGet<ContactPage>(listPath(criteria, WALK_PAGE, offset), signal)
        ids.push(...page.items.map((row) => row.id))
        if (offset + WALK_PAGE >= page.total) break
      }
      return ids
    },
    enabled: enabled && criteria !== null,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  })
}

function messagesPath(prospectId: string): `/${string}` {
  return `/prospects/${encodeURIComponent(prospectId)}/messages`
}

export function useMessageSequence(prospectId: string) {
  return useQuery({
    queryKey: contactKeys.messages(prospectId),
    queryFn: ({ signal }) => apiGet<MessageSequence>(messagesPath(prospectId), signal),
    // The editor keeps its own unsaved drafts; a refetch under it never overwrites them (MailSequence.tsx).
    refetchOnWindowFocus: false,
  })
}

// The sequence with one step's message replaced by a write's answer.
function withMessage(sequence: MessageSequence, message: Message): MessageSequence {
  return {
    ...sequence,
    steps: sequence.steps.map((entry) => (entry.step === message.step ? { ...entry, message } : entry)),
  }
}

// Message writes answer the step's message: it replaces the cached one at once, then the list (message chips), the
// counters and the prospect's history are read again.
export function useMessageMutations(prospectId: string) {
  const queryClient = useQueryClient()
  const saved = (result: MessageResult) => {
    queryClient.setQueryData<MessageSequence>(contactKeys.messages(prospectId), (current) =>
      current ? withMessage(current, result.message) : current,
    )
    void refreshAfterWrite(queryClient, [
      ['contact', 'page'],
      ['contact', 'dashboard'],
      historyKeys.subject('prospects', prospectId),
    ])
  }
  const path = (step: MessageStep, action?: string): `/${string}` =>
    `${messagesPath(prospectId)}/${step}${action ? `/${action}` : ''}`
  return {
    save: useMutation({
      mutationFn: ({ step, content }: { step: MessageStep; content: MessageContent }) =>
        apiRequest<MessageResult>('PUT', path(step), { body: content }),
      onSuccess: saved,
    }),
    act: useMutation({
      mutationFn: ({ step, action, revision }: { step: MessageStep; action: MessageAction; revision: number }) =>
        apiRequest<MessageResult>('POST', path(step, action), { body: { expected_revision: revision } }),
      onSuccess: saved,
    }),
    // The AI draft (S5). Bounded wait: the browser gives up after `deadline` ms (the server keeps its own bound). The
    // result lands in the cache even when the editor that asked is gone (tab switched).
    generate: useMutation({
      mutationFn: ({ step, request, deadline }: { step: MessageStep; request: GenerateRequest; deadline: number }) =>
        apiRequest<GenerationResult>('POST', path(step, 'generate'), { body: request, signal: AbortSignal.timeout(deadline) }),
      onSuccess: saved,
    }),
    schedule: useMutation({
      mutationFn: ({ step, revision, at }: { step: MessageStep; revision: number; at: string }) =>
        apiRequest<MessageResult>('POST', path(step, 'schedule'), {
          body: { expected_revision: revision, scheduled_at: at },
        }),
      onSuccess: saved,
    }),
  }
}
