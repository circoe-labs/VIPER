import type { Appointment } from '../api/agenda'
import { type ApiReply, stubApi } from './render'
import { SHELL_API } from './homeApi'

let counter = 0

// An appointment of Calendly on Monday 26 October 2026, 14:30 in Paris (UTC+1: summer time ended on the 25th).
export function appointment(overrides: Partial<Appointment> = {}): Appointment {
  counter += 1
  return {
    id: `01920000-0000-7000-8000-0000000009${String(counter).padStart(2, '0')}`,
    source: 'calendly',
    title: 'Échange avec Circoe',
    invitee_name: 'Jean Exemple',
    invitee_email: 'jean@alpha.example',
    company_name: 'Alpha SARL',
    host_name: 'Lucie Jerier',
    host_email: 'l.jerier@circoe.com',
    starts_at: '2026-10-26T14:30:00+01:00',
    ends_at: '2026-10-26T15:00:00+01:00',
    location: 'https://meet.example/abc',
    status: 'scheduled',
    reschedule_count: 0,
    notes: null,
    prospect: null,
    referent: null,
    last_mail: null,
    ...overrides,
  }
}

interface AgendaStub {
  items?: Appointment[]
  today?: Appointment[]
  tomorrow?: Appointment[]
  extra?: Record<string, ApiReply>
}

// The Agenda page's API: the month's appointments, the reminders, the referents, and the writes echoing the patch.
export function stubAgendaApi({ items = [], today = [], tomorrow = [], extra = {} }: AgendaStub = {}) {
  const known = [...items, ...today, ...tomorrow]
  const replies: Record<string, ApiReply> = {
    ...SHELL_API,
    'GET /api/agenda/appointments': [200, { items }],
    'GET /api/agenda/reminders': [200, { today, tomorrow }],
    'GET /api/settings/referents': [200, []],
  }
  for (const found of known) {
    replies[`PATCH /api/agenda/appointments/${found.id}`] = () => [200, found]
  }
  return stubApi({ ...replies, ...extra })
}

// The JSON bodies sent with `method` to a path ending with `suffix`.
export function sentBodies(fetchMock: ReturnType<typeof stubApi>, method: string, suffix: string): unknown[] {
  return fetchMock.mock.calls
    .filter(([url, init]) => url.endsWith(suffix) && (init?.method ?? 'GET') === method)
    .map(([, init]) => JSON.parse(typeof init?.body === 'string' ? init.body : 'null') as unknown)
}
