import type { Block } from './lifecycle'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { apiGet, apiRequest } from './client'
import type { IdentityDoubt } from './emailIdentity'
import { historyKeys } from './history'
import type { ActivityStatus, TrackingStatus } from './prospection'
import { refreshAfterWrite } from './refresh'
import { sequenceKeys } from './sequences'
import type { ToolboxState } from './toolbox'
import type { SendSituation } from './unsent'

// Mirrors backend/app/api/routes/contact.py (the Contact dashboard and list) and contact_messages.py (the mail
// sequence Contact / R1 / R2 of one prospect). Rules and refusal codes: doc/features/contact.md.

// One Contact category, across all cohorts: prospects with at least one recorded send.
export const CONTACTED = 'CONTACTES'
export const CONTACT_SECTIONS = [CONTACTED] as const
export type ContactSection = (typeof CONTACT_SECTIONS)[number]

// A sequence is three e-mails at most. The server may offer fewer (« max relances » lowered), and still lists an old
// R3/R4 kept in the history (read-only: nothing is prepared or scheduled beyond R2).
export const MESSAGE_STEPS = ['contact', 'r1', 'r2'] as const
// A step code of the sequence: `contact`, `r1`, `r2` (older history: `r3`, `r4`).
export type MessageStep = string
export type MessageStatus = 'draft' | 'validated' | 'scheduled' | 'sent' | 'cancelled'
// What the next action prepares: the step code of the sequence (`contact`, `r1`… up to R<max>).
export type NextStep = string

// Every Contact state can be filtered but `ignored` (terminal, outside Contact).
export type ContactState = Exclude<TrackingStatus, 'ignored'>

export interface ContactWeekOption {
  // `2026-W41`
  week: string
  year: number
  number: number
  count: number
}

// Why a scheduled message will not leave (S9, backend app/services/contact_dispatch_state.py): the person switched
// « Envoi automatique des mails programmés » off, or the CIRCOE Toolbox is not usable; `not_running` should not happen.
export type DispatchReason =
  | 'disabled'
  | 'toolbox_disabled'
  | 'toolbox_not_configured'
  | 'toolbox_disconnected'
  | 'toolbox_expired'
  | 'not_running'

export interface DispatchState {
  active: boolean
  reason: DispatchReason | null
  scheduled_count: number
  // Scheduled, not being sent, and their time has passed.
  overdue_count: number
}

export interface ContactDashboard {
  // Business day, `YYYY-MM-DD`.
  today: string
  // The server's « cette semaine », `2026-W41`.
  current_week: string
  // The campaign cohorts (`S37`…) with the prospects currently in each; `out_of_campaign` is S0.
  cohorts?: {
    code: string
    starts_on: string | null
    out_of_campaign: boolean
    prospects: number
    // Of those, the ones who took an appointment (listed under « RDV pris », not in the cohort).
    appointments?: number
  // Prospects of the cohort set aside: listed apart under « Écartés ».
  set_aside?: number
    // To send this week (overdue included), of which late, and the steps (`contact`, `r1`…) they are at.
    to_send?: number
    overdue?: number
    to_send_steps?: string[]
    // What has really left, by step: how many mails, between which business days (`YYYY-MM-DD`).
    sent_steps?: { step: string; label: string; count: number; first_on: string; last_on: string }[]
    // The mails scheduled and not sent yet, by step: how many, and the earliest and latest day they leave.
    scheduled_steps?: { step: string; label: string; count: number; first_on: string; last_on: string }[]
    // The steps coming up for the sequences with nothing due this week: how many, and the earliest day (`first_on`).
    next_steps?: { step: string; label: string; count: number; first_on: string; last_on: string }[]
  }[]
  // To send by the end of this week (overdue included) and by rank (0 = first contact); ContactDashboardOut.to_send.
  to_send?: { total: number; overdue: number; groups: { rank: number; count: number; overdue: number }[] }
  // The planning's categories with their count (`appointment_obtained` is « RDV pris »).
  categories?: { category: string; count: number }[]
  // ISO weeks present in the planning, oldest first.
  weeks: ContactWeekOption[]
  // S9: the page warns when scheduled messages will not leave.
  dispatch: DispatchState
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
  // An address of the person looks like someone else's.
  identity_doubt?: IdentityDoubt | null
  activity_status: ActivityStatus
  block?: Block | null
  tracking_status: TrackingStatus
  // The campaign cohort the prospect belongs to (`S39`), null without cohort.
  cohort_code?: string | null
  planned_contact_at: string | null
  next_action_week: string | null
  // Something is to send this week (or was before it).
  due: boolean
  next_step: NextStep | null
  // Status of each step's message by step code, null (or absent) when never created.
  messages: Record<string, MessageStatus | null>
  // When each step really left (`sent_at`) or is scheduled for (`scheduled_at`), by step code.
  message_dates?: Record<string, { sent_at: string | null; scheduled_at: string | null }>
  primary_phone?: string | null
  last_contact_at?: string | null
  last_email_sent_at?: string | null
  // The effective schedule, or why a scheduled mail did not leave (apart from `planned_contact_at`, the due date).
  send?: SendSituation | null
}

export interface ContactPage {
  items: ContactRow[]
  total: number
  limit: number
  offset: number
}

// Already contacted prospects, alphabetical by company; `q` narrows the list.
export interface ContactListCriteria {
  section: ContactSection | null
  q: string
  status?: string | null
  company?: string | null
  // The prospect's validation box (`verification_box` of the API): validated, uncertain, todo, ignored.
  validation?: string | null
}

export interface ContactChartBar {
  slot: number
  label: string
  count: number
  send_date: string | null
}

export interface ContactOverview {
  today: string
  total: number
  bars: ContactChartBar[]
  companies: { id: string; label: string }[]
  statuses: { value: string; label: string }[]
  dispatch: DispatchState
}

function contactFilterParams(criteria: ContactListCriteria): URLSearchParams {
  const params = new URLSearchParams()
  if (criteria.q.trim()) params.set('q', criteria.q.trim())
  if (criteria.company) params.set('company', criteria.company)
  if (criteria.validation) params.set('verification_box', criteria.validation)
  if (criteria.status?.startsWith('state:')) params.set('tracking_status', criteria.status.slice(6))
  if (criteria.status?.startsWith('level:')) params.set('level', criteria.status.slice(6))
  return params
}

export function useContactOverview(criteria: ContactListCriteria) {
  return useQuery({
    queryKey: [...contactKeys.all, 'overview', criteria],
    queryFn: ({ signal }) => apiGet<ContactOverview>(`/contact/overview?${contactFilterParams(criteria).toString()}`, signal),
    placeholderData: keepPreviousData,
  })
}

export function useChartDateMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ slot, date }: { slot: number; date: string | null }) =>
      apiRequest<{ send_date: string | null }>('PUT', `/contact/chart-dates/${String(slot)}`, { body: { send_date: date } }),
    onSuccess: async () => { await refreshAfterWrite(client, [[...contactKeys.all, 'overview']]) },
  })
}

// The API caps a page at 200; the category provides pagination.
export const CONTACT_PAGE_SIZE = 200

export type ReviewVerdict = 'correct' | 'to_revise'

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
  // A person's verdict on this very text (« relu »); null when none was given or the text changed since.
  review_verdict: ReviewVerdict | null
  reviewed_at: string | null
  reviewed_by: string | null
  scheduled_at: string | null
  sent_at: string | null
  cancelled_at: string | null
  // `manual` | `prospect_state:<state>` | `do_not_contact` | a lifecycle block (`prospect_departed`…)
  cancel_reason: string | null
  generation_model: string | null
  generation_prompt_version: string | null
  generated_at: string | null
  has_remote_draft: boolean
  // Scheduled sending (S7): the dispatcher's claim (a send running, or unconfirmed) and the attempts of this schedule.
  dispatch_claimed_at: string | null
  dispatch_attempts: number
  // `toolbox_*`: the Infomaniak draft could not be created (S6); `send_*` / `dispatch_*`: the scheduled send (S7).
  last_error_code: string | null
  last_error_at: string | null
  // A send moment that did not end in a send, why (a code) and when.
  missed_scheduled_at?: string | null
  missed_reason?: string | null
  missed_at?: string | null
  // Scheduled, and its Infomaniak draft was not found by the last check.
  draft_missing?: boolean
  // Scheduling it again needs the person's confirmation that they looked in the sent items.
  needs_sent_check?: boolean
  created_at: string
  updated_at: string
}

export interface MessageSequence {
  // The recipients (of any step) that look like someone else's: nothing can be prepared or sent to them.
  identity_doubts?: IdentityDoubt[]
  sequence: {
    prospect_id: string
    state: TrackingStatus | null
    do_not_contact: boolean
    // A lifecycle block besides the opposition (departed, archived, excluded).
    block?: Block | null
    // No message may be created, edited, validated, scheduled or reopened.
    closed: boolean
    // The step to send next (`contact`, `r1`…), derived from the real sends; null when finished or without cohort.
    next_step?: string | null
    // « Max relances » (2 at most): the last step that can be prepared.
    max_follow_ups?: number
  }
  // `generation_available`: the AI drafting is configured on the server (S5). `toolbox_connected`: the CIRCOE Toolbox
  // is connected (S6) — a validation creates the Infomaniak draft, sent from the account's default mailbox;
  // `toolbox_state` tells an enabled but unconnected (or expired) Toolbox from a disabled one.
  defaults: {
    from_email: string | null
    to: string[]
    generation_available: boolean
    humanizer?: HumanizerDefaults
    toolbox_connected: boolean
    toolbox_state: ToolboxState
    // S7: a scheduled message really leaves (the dispatcher runs on the server and the Toolbox is connected).
    automatic_sending_active: boolean
    // S9: why not (null when active).
    dispatch_reason: DispatchReason | null
    // A scheduled message more late than this goes back to Validé instead of leaving.
    dispatch_max_lateness_minutes: number
    // After this long, a claimed send nobody finished counts as unconfirmed.
    dispatch_claim_ttl_seconds: number
  }
  steps: { rank?: number; step: MessageStep; label?: string; message: Message | null }[]
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
      'disabled' | 'not_connected' | 'not_applicable' | 'already_present' | 'created' | 'recovered' | 'stale' | 'failed'
    code: string | null
  }
}

// `POST …/messages/{step}/generate` (S5): the AI draft of the step, always a draft. `replace` confirms that a saved
// subject/body is replaced; `instruction` is the person's « consigne » (≤ 1000 characters).
export interface GenerateRequest {
  expected_revision?: number
  instruction?: string
  replace?: boolean
  // Tone 0 (strictly professional) … 5 (friendly) and sender (« as the AI » / « as a person »); null = automatic.
  options?: { tone: number | null; sender: 'ai' | 'person' | null }
}

// The humanizer (HumanGPT score check a message must reach before it is validated): global server settings.
export interface HumanizerDefaults {
  enabled: boolean
  configured: boolean
  min_score: number
}

export interface HumanizerCheck {
  human_score: number
  verdict: string
  passed: boolean
  min_score: number
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

// `remote-draft` (S6): create again the Infomaniak draft of a validated message (« Réessayer »). `mark-sent` /
// `release` (S7): a person settles a send the dispatcher could not confirm.
export type MessageAction = 'validate' | 'unschedule' | 'cancel' | 'reopen' | 'remote-draft' | 'mark-sent' | 'release'

export const contactKeys = {
  // Invalidate after any prospect or message write: the counters, the list's state and message chips move.
  all: ['contact'] as const,
  dashboard: (q: string) => ['contact', 'dashboard', q] as const,
  page: (criteria: ContactListCriteria, page: number) => ['contact', 'page', criteria, page] as const,
  messages: (prospectId: string) => ['contact', 'messages', prospectId] as const,
  versions: (prospectId: string, step: MessageStep) => ['contact', 'versions', prospectId, step] as const,
  saved: (prospectId: string) => ['contact', 'saved', prospectId] as const,
}

// What the sequences-rework API answers for a row (backend/app/api/routes/contact.py); `toRow` turns it into the shape
// the list reads. A row already in that shape goes through unchanged.
interface ApiRow extends Omit<ContactRow, 'planned_contact_at' | 'next_action_week' | 'due' | 'messages'> {
  next_due_at?: string | null
  next_due_week?: string | null
  to_send?: boolean
  messages: { step: string; status: MessageStatus; sent_at?: string | null; scheduled_at?: string | null }[]
}

export function toRow(raw: ContactRow | ApiRow): ContactRow {
  if (!Array.isArray(raw.messages)) return raw as ContactRow
  const { next_due_at, next_due_week, to_send, messages, ...row } = raw as ApiRow
  return {
    ...row,
    planned_contact_at: next_due_at ?? null,
    next_action_week: next_due_week ?? null,
    due: to_send ?? false,
    messages: Object.fromEntries(messages.map((item) => [item.step, item.status])),
    message_dates: Object.fromEntries(
      messages.map((item) => [item.step, { sent_at: item.sent_at ?? null, scheduled_at: item.scheduled_at ?? null }]),
    ),
  }
}

function toPage(raw: ContactPage): ContactPage {
  return { ...raw, items: raw.items.map(toRow) }
}

export function useContactDashboard(q: string) {
  return useQuery({
    queryKey: contactKeys.dashboard(q.trim()),
    queryFn: async ({ signal }) => {
      const params = new URLSearchParams()
      if (q.trim()) params.set('q', q.trim())
      return apiGet<ContactDashboard>(`/contact/dashboard?${params.toString()}`, signal)
    },
    placeholderData: keepPreviousData,
  })
}

// « Suivi des envois programmés » (GET /contact/scheduling): what is scheduled by step and day, what still has to be
// validated or scheduled, and the prospects with something to send this week whose mail is not scheduled.
export interface SchedulingStep {
  rank: number
  step: string
  step_label: string
  drafts: number
  validated: number
  scheduled: number
  due: number
  forgotten: number
  forgotten_none: number
  forgotten_draft: number
  forgotten_validated: number
}

export interface SchedulingDay {
  day: string
  total: number
  by_step: Record<string, number>
  // Before today: those mails should have left.
  past: boolean
}

export type ForgottenState = 'none' | 'draft' | 'validated'

export interface ForgottenProspect {
  id: string
  first_name: string | null
  last_name: string | null
  civility: string | null
  company_name: string | null
  cohort_code: string | null
  step: string
  step_label: string
  rank: number
  state: ForgottenState
  due_at: string | null
  overdue: boolean
  send?: SendSituation | null
}

// A draft, validated or scheduled message and whose it is: what a click on a tile lists.
export interface PreparedMessage {
  prospect_id: string
  first_name: string | null
  last_name: string | null
  company_name: string | null
  cohort_code: string | null
  step: string
  step_label: string
  rank: number
  status: 'draft' | 'validated' | 'scheduled'
  scheduled_at: string | null
  last_error_code: string | null
  missed_scheduled_at?: string | null
  missed_reason?: string | null
}

export interface Scheduling {
  today: string
  week: string
  current_week: string
  max_follow_ups: number
  totals: {
    scheduled: number
    validated: number
    drafts: number
    due: number
    forgotten: number
    scheduled_past: number
    scheduled_with_error: number
    scheduled_with_draft_error: number
  }
  steps: SchedulingStep[]
  days: SchedulingDay[]
  forgotten: ForgottenProspect[]
  messages: PreparedMessage[]
}

export function useContactScheduling() {
  return useQuery({
    // Under `contactKeys.all`: every message write refreshes it.
    queryKey: [...contactKeys.all, 'scheduling'] as const,
    queryFn: ({ signal }) => apiGet<Scheduling>('/contact/scheduling', signal),
    placeholderData: keepPreviousData,
  })
}

function listPath(criteria: ContactListCriteria, limit: number, offset: number): `/${string}` {
  const params = contactFilterParams(criteria)
  params.set('category', 'contacted')
  params.set('sort', 'company')
  params.set('limit', String(limit))
  params.set('offset', String(offset))
  return `/contact/prospects?${params.toString()}`
}

function pagePath(criteria: ContactListCriteria, page: number): `/${string}` {
  return listPath(criteria, CONTACT_PAGE_SIZE, (page - 1) * CONTACT_PAGE_SIZE)
}

// `page` is 1-based. `enabled` false while the section is closed (nothing is read before it is opened).
export function useContactPage(criteria: ContactListCriteria, page: number, enabled = true) {
  return useQuery({
    queryKey: contactKeys.page(criteria, page),
    queryFn: async ({ signal }) => toPage(await apiGet<ContactPage>(pagePath(criteria, page), signal)),
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

// The dispatcher's codes of a send that ended without a known outcome (backend contact_dispatch.UNCONFIRMED): a person
// settles it, nothing changes by itself before the claim's delay.
export const UNCONFIRMED_SEND_CODES: ReadonlySet<string> = new Set([
  'send_outcome_unknown',
  'send_reconcile_inconclusive',
  'send_probably_sent',
])

// While the server sends automatically (S7), a scheduled message about to leave (within 2 minutes) or being sent is
// read again every 3 s, so « Envoyé » (or the failure) shows up without a reload; once past its time without being
// taken (Toolbox busy, backoff) every 30 s; an unconfirmed or stuck send is not polled (a person settles it). TanStack
// Query runs the interval only while the editor is mounted and the browser tab visible.
export const DISPATCH_WATCH_MS = 3000
export const DISPATCH_LATE_WATCH_MS = 30_000
const DISPATCH_WATCH_AHEAD_MS = 2 * 60 * 1000

function watchOf(message: Message | null, now: number, claimTtlMs: number): number | false {
  if (message?.status !== 'scheduled') return false
  if (message.dispatch_claimed_at) {
    const stuck =
      (message.last_error_code !== null && UNCONFIRMED_SEND_CODES.has(message.last_error_code)) ||
      now - new Date(message.dispatch_claimed_at).getTime() >= claimTtlMs
    return stuck ? false : DISPATCH_WATCH_MS
  }
  if (message.scheduled_at === null) return false
  const until = new Date(message.scheduled_at).getTime() - now
  if (until < 0) return DISPATCH_LATE_WATCH_MS
  return until <= DISPATCH_WATCH_AHEAD_MS ? DISPATCH_WATCH_MS : false
}

export function dispatchWatchInterval(sequence: MessageSequence | undefined, now: number): number | false {
  if (!sequence?.defaults.automatic_sending_active) return false
  const ttl = sequence.defaults.dispatch_claim_ttl_seconds * 1000
  const intervals = sequence.steps
    .map(({ message }) => watchOf(message, now, ttl))
    .filter((value): value is number => value !== false)
  return intervals.length > 0 ? Math.min(...intervals) : false
}

export function useMessageSequence(prospectId: string) {
  return useQuery({
    queryKey: contactKeys.messages(prospectId),
    queryFn: ({ signal }) => apiGet<MessageSequence>(messagesPath(prospectId), signal),
    // The editor keeps its own unsaved drafts; a refetch under it never overwrites them (MailSequence.tsx).
    refetchOnWindowFocus: false,
    refetchInterval: (query) => dispatchWatchInterval(query.state.data, Date.now()),
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
      ['contact', 'scheduling'],
      // The sheet beside the editor says the effective schedule: an edit or a schedule changes it.
      sequenceKeys.prospect(prospectId),
      // Every text a write leaves is a kept version.
      ['contact', 'versions', prospectId],
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
    // A draft that was never validated is removed: the step is empty again.
    remove: useMutation({
      mutationFn: ({ step, revision, sentCheckConfirmed }: { step: MessageStep; revision: number; sentCheckConfirmed?: boolean }) =>
        apiRequest<{ deleted: boolean; step: string }>('POST', path(step, 'delete'), {
          body: { expected_revision: revision, ...(sentCheckConfirmed ? { sent_check_confirmed: true } : {}) },
        }),
      onSuccess: () =>
        refreshAfterWrite(queryClient, [
          contactKeys.messages(prospectId),
          ['contact', 'page'],
          ['contact', 'dashboard'],
          ['contact', 'scheduling'],
          historyKeys.subject('prospects', prospectId),
        ]),
    }),
    act: useMutation({
      mutationFn: ({ step, action, revision }: { step: MessageStep; action: MessageAction; revision: number }) =>
        apiRequest<MessageResult>('POST', path(step, action), {
          body: { expected_revision: revision },
        }),
      onSuccess: saved,
    }),
    // The AI draft (S5). Bounded wait: the browser gives up after `deadline` ms (the server keeps its own bound). The
    // result lands in the cache even when the editor that asked is gone (tab switched).
    generate: useMutation({
      mutationFn: ({ step, request, deadline }: { step: MessageStep; request: GenerateRequest; deadline: number }) =>
        apiRequest<GenerationResult>('POST', path(step, 'generate'), {
          body: request,
          signal: AbortSignal.timeout(deadline),
        }),
      onSuccess: saved,
    }),
    // « Versions »: a kept version's text becomes the current draft (itself recorded as a version).
    restore: useMutation({
      mutationFn: ({ step, versionId, revision }: { step: MessageStep; versionId: string; revision: number }) =>
        apiRequest<MessageResult>('POST', path(step, `versions/${versionId}/restore`), {
          body: { expected_revision: revision },
        }),
      onSuccess: saved,
    }),
    // « Sauvegarder »: the current text, with its generation config, a rating 0-10 and a comment, kept as a saved mail.
    keep: useMutation({
      mutationFn: ({ step, note }: { step: MessageStep; note: SavedMailNote }) =>
        apiRequest<MessageVersion>('POST', path(step, 'saved'), { body: note }),
      onSuccess: () =>
        refreshAfterWrite(queryClient, [
          contactKeys.saved(prospectId),
          ['contact', 'versions', prospectId],
          historyKeys.subject('prospects', prospectId),
        ]),
    }),
    schedule: useMutation({
      mutationFn: ({ step, revision, at, sentCheckConfirmed }: { step: MessageStep; revision: number; at: string; sentCheckConfirmed?: boolean }) =>
        apiRequest<MessageResult>('POST', path(step, 'schedule'), {
          body: { expected_revision: revision, scheduled_at: at, ...(sentCheckConfirmed ? { sent_check_confirmed: true } : {}) },
        }),
      onSuccess: saved,
    }),
  }
}

// One kept state of a step's text: an AI generation, a manual state or a restoration. The saved facet (`saved_at`…)
// makes it a « mail sauvegardé » with its human note.
export interface MessageVersion {
  id: string
  step: MessageStep
  step_label: string
  revision: number
  created_at: string
  updated_at: string
  source: 'ai' | 'manual' | 'restore'
  from_email: string | null
  to: string[]
  subject: string
  body_text: string
  // tone 0..5, sender `ai` / `person`, instruction, model, prompt_version, humanizer_score, restored_from.
  config: {
    tone?: number
    sender?: 'ai' | 'person'
    instruction?: string
    model?: string
    prompt_version?: string
    humanizer_score?: number
    restored_from?: string
  }
  actor: string
  saved_at: string | null
  saved_by: string | null
  // 0 = « ne fais plus jamais ça » … 10 = « super, garde ce style ».
  rating: number | null
  comment: string | null
}

export interface SavedMailNote {
  rating: number
  comment: string | null
  humanizer_score?: number
}

export function useMessageVersions(prospectId: string, step: MessageStep, enabled = true) {
  return useQuery({
    queryKey: contactKeys.versions(prospectId, step),
    queryFn: ({ signal }) => apiGet<{ versions: MessageVersion[] }>(`${messagesPath(prospectId)}/${step}/versions`, signal),
    enabled,
    refetchOnWindowFocus: false,
  })
}

// The prospect's saved mails, newest first (the « Suivi de contact » list).
export function useSavedMails(prospectId: string) {
  return useQuery({
    queryKey: contactKeys.saved(prospectId),
    queryFn: ({ signal }) => apiGet<{ saved: MessageVersion[] }>(`${messagesPath(prospectId)}/saved`, signal),
    refetchOnWindowFocus: false,
  })
}

// « Vérifier maintenant »: the HumanGPT score of a text (nothing is saved).
export function useHumanizerCheck() {
  return useMutation({
    mutationFn: (text: string) =>
      apiRequest<HumanizerCheck>('POST', '/contact/humanizer-check', { body: { text }, signal: AbortSignal.timeout(60_000) }),
  })
}

// « Programmer une série »: one send moment for the validated mails of a step, for every prospect of the chosen
// cohorts (POST /contact/schedule-cohorts). Drafts are left alone and counted.
export interface ScheduleCohortsResult {
  scheduled: number
  validated: number
  refused: number
  missing: number
  remote_draft_failures: number
  // Of the refused: an earlier send may have left, to check and reschedule from « Envois à reprendre ».
  to_check?: number
  // Of the refused: a recipient looks like someone else's.
  doubtful?: number
}

export function useScheduleCohorts() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: { cohorts: string[]; step: string; scheduled_at: string }) =>
      apiRequest<ScheduleCohortsResult>('POST', '/contact/schedule-cohorts', {
        body: request,
      }),
    onSuccess: () =>
      refreshAfterWrite(queryClient, [
        ['contact', 'page'],
        ['contact', 'dashboard'],
        ['contact', 'scheduling'],
        ['contact', 'messages'],
      ]),
  })
}
