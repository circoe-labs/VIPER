import { afterEach, describe, expect, it, vi } from 'vitest'

import { DISPATCH_LATE_WATCH_MS, DISPATCH_WATCH_MS, dispatchWatchInterval, type MessageSequence } from '../api/contact'
import { message } from '../test/contactApi'
import {
  cancelReasonLabel,
  closedReason,
  contentOf,
  dispatchLine,
  dispatchState,
  formOf,
  isDirty,
  latenessLabel,
  localErrors,
  mailActions,
  orderWarning,
  parseRecipients,
  releaseAvailableAt,
  remoteDraftLine,
  scheduleToIso,
  sendErrorLabel,
  statusLine,
  utcOffset,
} from './mailModel'

const OPEN = { state: 'neutral' as const, doNotContact: false, closed: false }
const DEFAULTS = { from_email: 'prospection@exemple.example', to: ['jean@exemple.example'], generation_available: false, toolbox_connected: false, toolbox_state: 'disabled' as const, automatic_sending_active: false, dispatch_max_lateness_minutes: 360, dispatch_claim_ttl_seconds: 600 }

function sequence(steps: Partial<Record<'contact' | 'r1' | 'r2', ReturnType<typeof message>>>): MessageSequence {
  return {
    sequence: { prospect_id: 'p', state: 'contacted', do_not_contact: false, closed: false },
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
    expect(closedReason({ state: 'contacted', doNotContact: true, closed: true })).toContain('opposition')
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

describe('remoteDraftLine (S6)', () => {
  it('says the Infomaniak draft of a validated or scheduled message only', () => {
    expect(remoteDraftLine(message('contact', 'draft'), 'connected')).toBeNull()
    expect(remoteDraftLine(message('contact', 'validated', { has_remote_draft: true }), 'disabled')).toEqual({
      tone: 'ok',
      text: 'Brouillon créé dans Infomaniak.',
      retry: false,
    })
    expect(remoteDraftLine(message('contact', 'scheduled', { last_error_code: 'toolbox_outbound_blocked' }), 'connected')).toEqual({
      tone: 'warning',
      text: 'Brouillon Infomaniak non créé : un destinataire n’est pas autorisé par la liste d’envoi de la Toolbox.',
      retry: true,
    })
    expect(remoteDraftLine(message('contact', 'validated', { last_error_code: 'toolbox_outcome_unknown' }), 'connected')?.text).toContain(
      'création non confirmée par la Toolbox',
    )
    expect(remoteDraftLine(message('contact', 'validated'), 'connected')?.tone).toBe('muted')
    // Toolbox off or not configured: nothing (everything stays local).
    expect(remoteDraftLine(message('contact', 'validated'), 'disabled')).toBeNull()
    expect(remoteDraftLine(message('contact', 'validated'), 'not_configured')).toBeNull()
    // Enabled but not connected, or expired: said, no retry.
    for (const state of ['disconnected', 'expired'] as const) {
      expect(remoteDraftLine(message('contact', 'validated'), state)).toEqual({
        tone: 'muted',
        text: 'Brouillon Infomaniak non créé : Toolbox à reconnecter.',
        retry: false,
      })
    }
    expect(remoteDraftLine(message('contact', 'validated', { last_error_code: 'toolbox_auth_expired' }), 'expired')?.text).toBe(
      'Brouillon Infomaniak non créé : Toolbox à reconnecter.',
    )
    // A dispatch error (S7) is not a remote draft failure.
    expect(remoteDraftLine(message('contact', 'validated', { last_error_code: 'send_failed' }), 'disabled')).toBeNull()
  })
})

describe('scheduled sending (S7)', () => {
  const claimed = '2026-10-06T07:30:05Z'
  const clock = { now: new Date('2026-10-06T07:31:00Z').getTime(), claimTtlSeconds: 600 }
  const active = { ...DEFAULTS, automatic_sending_active: true, toolbox_state: 'connected' as const }

  it('tells a running send from an unconfirmed one', () => {
    expect(dispatchState(message('contact', 'scheduled'), clock)).toBe('none')
    expect(dispatchState(message('contact', 'scheduled', { dispatch_claimed_at: claimed }), clock)).toBe('sending')
    expect(
      dispatchState(message('contact', 'scheduled', { dispatch_claimed_at: claimed, last_error_code: 'send_outcome_unknown' }), clock),
    ).toBe('unconfirmed')
    // A claim older than the TTL: its process died.
    expect(dispatchState(message('contact', 'scheduled', { dispatch_claimed_at: claimed }), { ...clock, now: clock.now + 600_000 })).toBe(
      'unconfirmed',
    )
  })

  it('locks a claimed message and offers the settlement only when unconfirmed', () => {
    const sending = mailActions(message('contact', 'scheduled', { dispatch_claimed_at: claimed }), OPEN, clock)
    expect(sending).toMatchObject({ editable: false, unschedule: false, cancel: false, settle: false })
    expect(sending.lock).toMatch(/Envoi en cours/)
    const unconfirmed = mailActions(
      message('contact', 'scheduled', { dispatch_claimed_at: claimed, last_error_code: 'send_reconcile_inconclusive' }),
      OPEN,
      clock,
    )
    expect(unconfirmed).toMatchObject({ editable: false, settle: true })
  })

  it('words the scheduled status by whether the server really sends', () => {
    const scheduled = message('contact', 'scheduled')
    expect(statusLine(scheduled, false, true)).toMatch(/^Programmé : le mail partira automatiquement le .* déprogrammable jusqu’à l’envoi\.$/)
    expect(statusLine(scheduled, false, false)).toMatch(/^Programmé pour le /)
    expect(dispatchLine(scheduled, DEFAULTS, 'none')?.text).toMatch(/Envoi automatique inactif : la Toolbox n’est pas connectée/)
    expect(dispatchLine(scheduled, { ...DEFAULTS, toolbox_state: 'connected' }, 'none')?.text).toMatch(
      /l’envoi programmé n’est pas actif sur ce serveur/,
    )
    expect(dispatchLine(scheduled, active, 'none')).toBeNull()
  })

  it('says each outcome without jargon', () => {
    expect(dispatchLine(message('contact', 'scheduled'), active, 'sending')).toMatchObject({ tone: 'progress' })
    expect(dispatchLine(message('contact', 'scheduled'), active, 'unconfirmed')?.text).toMatch(/ne le renverra jamais/)
    expect(dispatchLine(message('contact', 'scheduled', { last_error_code: 'send_unavailable' }), active, 'none')?.text).toBe(
      'Dernière tentative d’envoi échouée : la Toolbox ne répondait pas. Nouvel essai automatique.',
    )
    expect(dispatchLine(message('contact', 'validated', { last_error_code: 'dispatch_overdue' }), active, 'none')?.text).toMatch(
      /dépassée de plus de 6 heures .* reprogrammez-le pour réessayer\.$/,
    )
    expect(
      dispatchLine(message('contact', 'validated', { last_error_code: 'send_recipient_not_allowed' }), active, 'none')?.text,
    ).toMatch(/liste d’adresses autorisées/)
    expect(dispatchLine(message('contact', 'validated', { last_error_code: 'send_previous_step_pending' }), active, 'none')?.text).toMatch(
      /message précédent/,
    )
    expect(dispatchLine(message('contact', 'validated', { last_error_code: 'send_released_by_person' }), active, 'none')?.tone).toBe('muted')
    expect(dispatchLine(message('contact', 'validated', { last_error_code: 'dispatch_held' }), active, 'none')?.text).toMatch(/restaurée/)
    expect(dispatchLine(message('contact', 'sent', { last_error_code: 'send_reconciled_draft_absent' }), active, 'none')?.text).toMatch(
      /^Envoi déduit/,
    )
    expect(dispatchLine(message('contact', 'sent'), active, 'none')).toBeNull()
    // A remote draft failure (S6) is not a send failure.
    expect(dispatchLine(message('contact', 'validated', { last_error_code: 'toolbox_unavailable' }), active, 'none')).toBeNull()
    expect(sendErrorLabel('send_something_new', 360)).toBe('erreur inattendue (send_something_new)')
    expect([latenessLabel(60), latenessLabel(360), latenessLabel(90)]).toEqual(['1 heure', '6 heures', '90 minutes'])
  })

  it('watches a sequence about to leave while the server sends', () => {
    const now = new Date('2026-10-06T07:29:00Z').getTime()
    const soon = message('contact', 'scheduled', { scheduled_at: '2026-10-06T07:30:00Z' })
    const later = message('contact', 'scheduled', { scheduled_at: '2026-10-07T07:30:00Z' })
    const watched = (steps: Parameters<typeof sequence>[0], defaults: MessageSequence['defaults'] = active) => dispatchWatchInterval({ ...sequence(steps), defaults }, now)
    expect(watched({ contact: soon })).toBe(DISPATCH_WATCH_MS)
    expect(watched({ contact: later })).toBe(false)
    expect(watched({ contact: { ...later, dispatch_claimed_at: claimed } })).toBe(DISPATCH_WATCH_MS)
    expect(watched({ contact: soon }, DEFAULTS)).toBe(false)
    // Past its time without being taken: slower.
    expect(watched({ contact: { ...soon, scheduled_at: '2026-10-06T07:00:00Z' } })).toBe(DISPATCH_LATE_WATCH_MS)
    // Unconfirmed or stuck: a person settles it, nothing to poll.
    expect(watched({ contact: { ...later, dispatch_claimed_at: claimed, last_error_code: 'send_outcome_unknown' } })).toBe(false)
    expect(watched({ contact: { ...later, dispatch_claimed_at: '2026-10-06T07:00:00Z' } })).toBe(false)
    // The quickest need wins.
    expect(watched({ contact: { ...soon, scheduled_at: '2026-10-06T07:00:00Z' }, r1: soon })).toBe(DISPATCH_WATCH_MS)
  })

  it('opens « Remettre en Validé » only after the claim’s delay', () => {
    const at = new Date('2026-10-06T07:30:00Z').getTime()
    const unconfirmed = message('contact', 'scheduled', { dispatch_claimed_at: '2026-10-06T07:30:00Z', last_error_code: 'send_outcome_unknown' })
    expect(releaseAvailableAt(unconfirmed, 600, at + 60_000)).toBe(at + 600_000)
    expect(releaseAvailableAt(unconfirmed, 600, at + 600_000)).toBeNull()
    expect(releaseAvailableAt(message('contact', 'scheduled'), 600, at)).toBeNull()
  })

  it('says a send not confirmed with its draft still there, and a probable send', () => {
    expect(dispatchLine(message('contact', 'validated', { last_error_code: 'send_not_confirmed' }), active, 'none')?.text).toMatch(
      /^Envoi non confirmé, brouillon toujours présent dans Infomaniak : vérifiez les éléments envoyés/,
    )
    expect(
      dispatchLine(message('contact', 'scheduled', { dispatch_claimed_at: claimed, last_error_code: 'send_probably_sent' }), active, 'unconfirmed')
        ?.text,
    ).toMatch(/^Probablement envoyé/)
  })
})
