import { afterEach, describe, expect, it, vi } from 'vitest'

import type { MessageSequence } from '../api/contact'
import { message } from '../test/contactApi'
import {
  cancelReasonLabel,
  closedReason,
  contentOf,
  formOf,
  isDirty,
  localErrors,
  mailActions,
  orderWarning,
  parseRecipients,
  scheduleToIso,
  statusLine,
  utcOffset,
} from './mailModel'

const OPEN = { state: 'neutral' as const, doNotContact: false, closed: false }
const DEFAULTS = { from_email: 'prospection@exemple.example', to: ['jean@exemple.example'], generation_available: false }

function sequence(steps: Partial<Record<'contact' | 'r1' | 'r2', ReturnType<typeof message>>>): MessageSequence {
  return {
    sequence: { prospect_id: 'p', state: 'neutral', do_not_contact: false, closed: false },
    defaults: DEFAULTS,
    steps: (['contact', 'r1', 'r2'] as const).map((step) => ({ step, message: steps[step] ?? null })),
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('mail form', () => {
  it('starts a never-written step from the defaults, a written one from its message', () => {
    expect(formOf(null, DEFAULTS)).toEqual({
      from: 'prospection@exemple.example',
      to: 'jean@exemple.example',
      cc: '',
      bcc: '',
      subject: '',
      body: '',
    })
    expect(formOf(message('r1', 'draft', { cc: ['a@x.example', 'b@x.example'] }), DEFAULTS).cc).toBe('a@x.example, b@x.example')
  })

  it('ignores spacing, separators and address case when telling unsaved edits', () => {
    const saved = formOf(message('contact', 'draft', { to: ['a@x.example', 'b@x.example'] }), DEFAULTS)
    expect(isDirty({ ...saved, to: ' A@x.example ; b@x.example ' }, saved)).toBe(false)
    expect(isDirty({ ...saved, subject: 'Autre' }, saved)).toBe(true)
  })

  it('builds the PUT body: create without revision, edit with it', () => {
    const form = { from: ' ', to: 'a@x.example,\nb@x.example', cc: '', bcc: 'c@x.example', subject: 'Objet', body: 'Corps' }
    expect(contentOf(form, null)).toEqual({
      from_email: null,
      subject: 'Objet',
      body_text: 'Corps',
      to: ['a@x.example', 'b@x.example'],
      cc: [],
      bcc: ['c@x.example'],
    })
    expect(contentOf(form, 3).expected_revision).toBe(3)
    expect(parseRecipients(' ; ,a@x.example;; ')).toEqual(['a@x.example'])
  })

  it('points at a malformed address before calling the server', () => {
    const errors = localErrors({ from: 'moi', to: 'ok@x.example, faux', cc: '', bcc: '', subject: '', body: '' })
    expect(errors).toEqual({ from: 'Adresse d’expédition invalide.', to: 'Adresse invalide : faux.' })
  })
})

describe('mail actions by status', () => {
  it('offers creation on an empty step and validation on a draft', () => {
    expect(mailActions(null, OPEN)).toMatchObject({ editable: true, save: 'create', validate: false, cancel: false })
    expect(mailActions(message('contact', 'draft'), OPEN)).toMatchObject({ editable: true, save: 'save', validate: true, schedule: false, cancel: true })
  })

  it('offers scheduling once validated, unscheduling once scheduled', () => {
    expect(mailActions(message('contact', 'validated'), OPEN)).toMatchObject({ editable: true, schedule: true, validate: false })
    expect(mailActions(message('contact', 'scheduled'), OPEN)).toMatchObject({ editable: true, unschedule: true, schedule: false })
  })

  it('keeps a sent message read-only, and a cancelled one reopenable while the sequence is open', () => {
    const sent = mailActions(message('contact', 'sent'), OPEN)
    expect(sent).toMatchObject({ editable: false, save: null, cancel: false, reopen: false })
    expect(sent.lock).toContain('ne peut plus être modifié')
    expect(mailActions(message('contact', 'cancelled'), OPEN)).toMatchObject({ editable: false, reopen: true })
  })

  it('locks a closed sequence (state or opposition) but still lets a planned send be taken back', () => {
    const closed = { state: 'response_received' as const, doNotContact: false, closed: true }
    const scheduled = mailActions(message('contact', 'scheduled'), closed)
    expect(scheduled).toMatchObject({ editable: false, save: null, unschedule: true, cancel: true, validate: false })
    expect(scheduled.lock).toContain('« Réponse reçue »')
    expect(mailActions(null, closed)).toMatchObject({ editable: false, save: null, cancel: false })
    expect(mailActions(message('r1', 'cancelled'), closed)).toMatchObject({ reopen: false })
    expect(closedReason({ state: 'neutral', doNotContact: true, closed: true })).toContain('opposition')
    expect(closedReason(OPEN)).toBeNull()
  })
})

describe('status wording', () => {
  it('says where each message stands', () => {
    expect(statusLine(null, false)).toContain('créé au premier enregistrement')
    expect(statusLine(message('contact', 'validated'), false)).toBe('Validé par Pilote Test : prêt à être programmé.')
    expect(statusLine(message('contact', 'cancelled', { cancel_reason: 'prospect_state:appointment_obtained' }), true)).toContain(
      '(passage à « RDV pris »)',
    )
    expect(cancelReasonLabel('manual')).toBe('à la main')
    expect(cancelReasonLabel('do_not_contact')).toBe('opposition « Ne pas contacter »')
    expect(cancelReasonLabel('prospect_state:inconnu')).toBeNull()
  })

  it('reminds, without blocking, that R1 may leave before Contact', () => {
    expect(orderWarning('contact', sequence({}), null)).toBeNull()
    expect(orderWarning('r1', sequence({}), null)).toBe('Le message Contact n’existe pas encore : vérifiez que R1 ne partira pas avant lui.')
    expect(orderWarning('r1', sequence({ contact: message('contact', 'draft') }), null)).toContain('est « Brouillon »')
    expect(orderWarning('r1', sequence({ contact: message('contact', 'sent') }), null)).toBeNull()
    const later = message('r1', 'scheduled', { scheduled_at: '2026-10-10T08:00:00Z' })
    expect(orderWarning('r2', sequence({ r1: later }), new Date('2026-10-09T08:00:00Z'))).toContain('R2 partirait avant lui')
    expect(orderWarning('r2', sequence({ r1: later }), new Date('2026-10-12T08:00:00Z'))).toBeNull()
  })
})

function errorOf(parsed: ReturnType<typeof scheduleToIso>): string | null {
  return parsed.ok ? null : parsed.error
}

describe('send moment', () => {
  const now = new Date(2026, 8, 30, 10, 0)

  it('needs a date and a time — no default', () => {
    expect(scheduleToIso('', '', now)).toEqual({ ok: false, error: 'Choisissez la date et l’heure d’envoi.' })
    expect(errorOf(scheduleToIso('2026-10-01', '', now))).toContain('aucune heure')
    expect(scheduleToIso('', '09:30', now)).toEqual({ ok: false, error: 'Choisissez la date d’envoi.' })
  })

  it('refuses the past and more than a year ahead', () => {
    expect(errorOf(scheduleToIso('2026-09-30', '09:59', now))).toContain('futur')
    expect(errorOf(scheduleToIso('2027-12-01', '09:00', now))).toContain('plus d’un an')
  })

  it('answers the local moment with its UTC offset', () => {
    const parsed = scheduleToIso('2026-10-01', '09:30', now)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.iso).toMatch(/^2026-10-01T09:30:00[+-]\d{2}:\d{2}$/)
    expect(new Date(parsed.iso).getTime()).toBe(new Date(2026, 9, 1, 9, 30).getTime())
    expect(utcOffset(120)).toBe('+02:00')
    expect(utcOffset(-330)).toBe('-05:30')
  })
})
