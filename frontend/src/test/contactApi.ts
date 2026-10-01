import { vi } from 'vitest'

import type {
  ContactCounter,
  ContactDashboard,
  ContactRow,
  GenerateRequest,
  Message,
  MessageContent,
  MessageSequence,
  MessageStatus,
  MessageStep,
} from '../api/contact'
import type { Prospect } from '../api/prospects'
import { stubProspectsApi } from './prospectsApi'
import type { RecordedRequest } from './settingsApi'

// In-memory stand-in for the Contact API (backend/app/api/routes/contact.py, contact_messages.py) for component
// tests: the dashboard and list answer the given rows (filtered by `counter`/`state` only — the definitions are tested
// in the backend), and the messages follow the backend state machine closely enough for the editor (revision, edit ⇒
// back to draft, validate/schedule/unschedule/cancel/reopen, closed sequence, incomplete message). The prospect
// detail and its PATCH come from the Prospects fake. Synthetic values only.

export const TODAY = '2026-09-30'
export const CURRENT_WEEK = '2026-W40'
const STAMP = '2026-09-30T08:00:00+00:00'

export function contactDashboard(overrides: Partial<ContactDashboard> = {}): ContactDashboard {
  return {
    today: TODAY,
    current_week: CURRENT_WEEK,
    counts: { to_handle: 0, first_contact: 0, follow_up: 0, review: 0, appointments: 0 },
    weeks: [],
    ...overrides,
  }
}

let sequence = 0

export function contactRow(first_name: string, last_name: string, fields: Partial<ContactRow> = {}): ContactRow {
  sequence += 1
  return {
    id: `00000000-0000-7000-d000-${String(sequence).padStart(12, '0')}`,
    civility: null,
    first_name,
    last_name,
    exact_job_title: null,
    role_label: null,
    company_id: null,
    company_name: 'Transports Exemple SARL',
    primary_email: `${first_name.toLowerCase()}@exemple.example`,
    activity_status: 'active',
    tracking_status: 'neutral',
    planned_contact_at: '2026-09-27T22:00:00Z',
    next_action_week: CURRENT_WEEK,
    due: true,
    next_step: 'contact',
    messages: { contact: null, r1: null, r2: null },
    ...fields,
  }
}

export function message(step: MessageStep, status: MessageStatus, fields: Partial<Message> = {}): Message {
  return {
    id: `message-${step}`,
    prospect_id: 'prospect',
    step,
    status,
    from_email: 'prospection@exemple.example',
    to: ['jean@exemple.example'],
    cc: [],
    bcc: [],
    subject: `Objet ${step}`,
    body_text: `Corps ${step}`,
    revision: 1,
    validated_revision: status === 'draft' ? null : 1,
    validated_at: status === 'draft' ? null : STAMP,
    validated_by: status === 'draft' ? null : 'Pilote Test',
    scheduled_at: status === 'scheduled' ? '2026-10-06T07:30:00Z' : null,
    sent_at: status === 'sent' ? STAMP : null,
    cancelled_at: status === 'cancelled' ? STAMP : null,
    cancel_reason: status === 'cancelled' ? 'manual' : null,
    generation_model: null,
    generation_prompt_version: null,
    generated_at: null,
    has_remote_draft: false,
    last_error_code: null,
    last_error_at: null,
    created_at: STAMP,
    updated_at: STAMP,
    ...fields,
  }
}

interface ContactStubOptions {
  dashboard?: ContactDashboard | 'error'
  rows?: ContactRow[]
  // Prospect details (left panel), by id.
  details?: Prospect[]
  // Existing messages per prospect id.
  messages?: Record<string, Partial<Record<MessageStep, Message>>>
  // Sequence state per prospect id (open by default).
  sequences?: Record<string, Partial<MessageSequence['sequence']>>
  defaults?: MessageSequence['defaults']
  // The answer of `POST …/generate` (S5): a fake AI draft by default, else a refusal, or a request that never ends.
  generation?: { status: number; code: string } | 'hang'
}

function json(status: number, body?: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

function refusal(status: number, code: string, extra: object = {}): Promise<Response> {
  return json(status, { detail: { code, message: code, ...extra } })
}

const COUNTER_STATES: Record<ContactCounter, string[]> = {
  to_handle: ['neutral', 'contacted', 'r1', 'r2'],
  first_contact: ['neutral'],
  follow_up: ['contacted', 'r1'],
  review: ['r2'],
  appointments: ['appointment_obtained'],
}

export function stubContactApi(options: ContactStubOptions = {}) {
  const prospects = stubProspectsApi({ details: options.details ?? [] })
  const prospectsFetch = globalThis.fetch
  const rows = options.rows ?? []
  const store = new Map<string, Partial<Record<MessageStep, Message>>>(
    Object.entries(options.messages ?? {}).map(([id, steps]) => [id, structuredClone(steps)]),
  )
  const requests: RecordedRequest[] = []
  // Replaces the answer of the next message write (a refusal the fake would not produce).
  const next: { reply: [number, unknown] | null } = { reply: null }
  const defaults = options.defaults ?? { from_email: 'prospection@exemple.example', to: ['jean@exemple.example'], generation_available: false }

  function sequenceOf(id: string): MessageSequence['sequence'] {
    const detail = prospects.store.get(id)
    const state = detail?.tracking?.status ?? null
    const doNotContact = detail?.contactability_status === 'do_not_contact'
    return {
      prospect_id: id,
      state,
      do_not_contact: doNotContact,
      closed: doNotContact || ['response_received', 'appointment_obtained', 'ignored'].includes(state ?? ''),
      ...options.sequences?.[id],
    }
  }

  function messages(id: string): MessageSequence {
    const steps = store.get(id) ?? {}
    return {
      sequence: sequenceOf(id),
      defaults,
      steps: (['contact', 'r1', 'r2'] as const).map((step) => ({ step, message: steps[step] ?? null })),
    }
  }

  function write(id: string, step: MessageStep, updated: Message, created = false, changed = true, unvalidated = false) {
    store.set(id, { ...store.get(id), [step]: updated })
    return json(created ? 201 : 200, { message: updated, created, changed, unvalidated })
  }

  function handleMessages(method: string, id: string, step: MessageStep | undefined, action: string | undefined, body: unknown) {
    if (method === 'GET') return json(200, messages(id))
    if (next.reply) {
      const [status, detail] = next.reply
      next.reply = null
      return json(status, { detail })
    }
    if (!step) return json(405, { detail: 'Method Not Allowed' })
    const current = store.get(id)?.[step]
    const seq = sequenceOf(id)
    const closedCode = seq.do_not_contact ? 'prospect_do_not_contact' : 'prospect_sequence_closed'
    const revision = (body as { expected_revision?: number } | undefined)?.expected_revision
    if (action === 'generate') return generate(id, step, current, seq, closedCode, body as GenerateRequest)
    if (method === 'PUT') {
      const content = body as MessageContent
      if (seq.closed) return refusal(409, closedCode)
      if (!current) {
        if (revision !== undefined) return refusal(404, 'message_not_found')
        return write(id, step, message(step, 'draft', { ...fromContent(content), prospect_id: id }), true)
      }
      if (revision === undefined) return refusal(409, 'message_exists')
      if (revision !== current.revision) return refusal(409, 'revision_conflict')
      if (current.status === 'sent') return refusal(409, 'message_sent_immutable')
      const edited = { ...current, ...fromContent(content) }
      const changed = JSON.stringify(edited) !== JSON.stringify(current)
      if (!changed) return write(id, step, current, false, false)
      const unvalidated = current.status !== 'draft'
      return write(
        id,
        step,
        { ...edited, status: 'draft', revision: current.revision + 1, validated_revision: null, validated_at: null, validated_by: null, scheduled_at: null },
        false,
        true,
        unvalidated,
      )
    }
    if (!current) return refusal(404, 'message_not_found')
    if (revision !== current.revision) return refusal(409, 'revision_conflict')
    if (seq.closed && ['validate', 'schedule', 'reopen'].includes(action ?? '')) return refusal(409, closedCode)
    switch (action) {
      case 'validate': {
        const missing = [
          !current.from_email && 'from_email',
          current.to.length === 0 && 'to',
          !current.subject && 'subject',
          !current.body_text && 'body_text',
        ].filter(Boolean)
        if (missing.length > 0) return refusal(422, 'message_incomplete', { fields: missing })
        if (current.status !== 'draft') return refusal(409, 'invalid_transition', { status: current.status })
        return write(id, step, { ...current, status: 'validated', validated_revision: current.revision, validated_by: 'Pilote Test', validated_at: STAMP })
      }
      case 'schedule': {
        if (current.status !== 'validated') return refusal(409, 'invalid_transition', { status: current.status })
        const at = (body as { scheduled_at: string }).scheduled_at
        return write(id, step, { ...current, status: 'scheduled', scheduled_at: at })
      }
      case 'unschedule':
        if (current.status !== 'scheduled') return refusal(409, 'invalid_transition', { status: current.status })
        return write(id, step, { ...current, status: 'validated', scheduled_at: null })
      case 'cancel':
        if (current.status === 'sent' || current.status === 'cancelled') return refusal(409, 'invalid_transition')
        return write(id, step, { ...current, status: 'cancelled', cancelled_at: STAMP, cancel_reason: 'manual', scheduled_at: null })
      case 'reopen':
        if (current.status !== 'cancelled') return refusal(409, 'invalid_transition')
        return write(id, step, { ...current, status: 'draft', revision: current.revision + 1, cancelled_at: null, cancel_reason: null, validated_revision: null })
      default:
        return json(405, { detail: 'Method Not Allowed' })
    }
  }

  let generated = 0
  function generate(
    id: string,
    step: MessageStep,
    current: Message | undefined,
    seq: MessageSequence['sequence'],
    closedCode: string,
    request: GenerateRequest,
  ): Promise<Response> {
    if (options.generation === 'hang') return new Promise<Response>(() => undefined)
    if (options.generation) return refusal(options.generation.status, options.generation.code)
    if (seq.closed) return refusal(409, closedCode)
    if (!current && request.expected_revision !== undefined) return refusal(404, 'message_not_found')
    if (current) {
      if (request.expected_revision === undefined) return refusal(409, 'message_exists')
      if (request.expected_revision !== current.revision) return refusal(409, 'revision_conflict')
      if (current.status === 'scheduled') return refusal(409, 'invalid_transition', { status: 'scheduled' })
      if ((current.subject || current.body_text) && !request.replace) return refusal(409, 'replace_confirmation_required')
    }
    generated += 1
    const ai: Partial<Message> = {
      subject: `Objet IA ${String(generated)}`,
      body_text: `Bonjour,\n\nCorps IA ${String(generated)}.`,
      generation_model: 'fake-model',
      generation_prompt_version: 'contact-mail-fr-2026-09-v1',
      generated_at: STAMP,
    }
    const base = current ?? message(step, 'draft', { prospect_id: id, from_email: defaults.from_email, to: defaults.to })
    const draft: Message = {
      ...base,
      ...ai,
      status: 'draft',
      revision: current ? current.revision + 1 : 1,
      validated_revision: null,
      validated_at: null,
      validated_by: null,
      scheduled_at: null,
    }
    store.set(id, { ...store.get(id), [step]: draft })
    return json(current ? 200 : 201, {
      message: draft,
      created: !current,
      changed: true,
      unvalidated: current?.status === 'validated',
      generation: { model: 'fake-model', prompt_version: 'contact-mail-fr-2026-09-v1' },
    })
  }

  function listed(url: URL): ContactRow[] {
    const counter = url.searchParams.get('counter') as ContactCounter | null
    const state = url.searchParams.get('state')
    const week = url.searchParams.get('week')
    return rows.filter(
      (row) =>
        (!counter || (COUNTER_STATES[counter].includes(row.tracking_status) && (counter === 'appointments' || row.due))) &&
        (!state || row.tracking_status === state) &&
        (!week || row.next_action_week === week),
    )
  }

  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const url = new URL(input, 'http://localhost')
    const method = init?.method ?? 'GET'
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    if (url.pathname === '/api/contact/dashboard') {
      requests.push({ method, path: url.pathname, search: url.search, body })
      if (options.dashboard === 'error') return json(500, { detail: 'boom' })
      return json(200, options.dashboard ?? contactDashboard())
    }
    if (url.pathname === '/api/contact/prospects') {
      requests.push({ method, path: url.pathname, search: url.search, body })
      const all = listed(url)
      const limit = Number(url.searchParams.get('limit') ?? 50)
      const offset = Number(url.searchParams.get('offset') ?? 0)
      return json(200, { items: all.slice(offset, offset + limit), total: all.length, limit, offset })
    }
    const found = /^\/api\/prospects\/([^/]+)\/messages(?:\/(contact|r1|r2))?(?:\/(\w+))?$/.exec(url.pathname)
    if (found?.[1]) {
      requests.push({ method, path: url.pathname, search: url.search, body })
      return handleMessages(method, found[1], found[2] as MessageStep | undefined, found[3], body)
    }
    return prospectsFetch(input, init)
  })
  vi.stubGlobal('fetch', fetchMock)
  return { store, requests, next, prospects }
}

function fromContent(content: MessageContent): Partial<Message> {
  return {
    from_email: content.from_email,
    subject: content.subject,
    body_text: content.body_text,
    to: content.to,
    cc: content.cc,
    bcc: content.bcc,
  }
}

// The requests sent to a path (method + path, query string excluded).
export function sent(requests: RecordedRequest[], method: string, path: string): RecordedRequest[] {
  return requests.filter((request) => request.method === method && request.path === path)
}
