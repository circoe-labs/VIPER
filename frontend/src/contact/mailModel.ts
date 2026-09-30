// The mail editor's pure rules (Contact decisions 20-25, 29; backend state machine: doc/features/contact.md):
// - the form holds the operator's text; the saved version always comes from the server;
// - « Enregistrer » never validates; « Valider » and « Programmer » act on the saved version (no pending edit);
// - saving a validated or scheduled message puts it back to Brouillon (server rule, said before saving);
// - no default send time: date and time are typed, then sent as ISO 8601 with the browser's offset;
// - nothing here changes the prospect's state.
import { MESSAGE_STEPS, type Message, type MessageContent, type MessageSequence, type MessageStep } from '../api/contact'
import type { TrackingStatus } from '../api/prospection'
import { TRACKING_LABELS } from '../prospection/labels'
import { formatDateTime, MESSAGE_STATUS_LABELS, STEP_LABELS } from './labels'
import type { MailField } from './messages'

export interface MailForm {
  from: string
  to: string
  cc: string
  bcc: string
  subject: string
  body: string
}

// Addresses typed in one field, separated by commas, semicolons or line breaks; blanks ignored.
export function parseRecipients(value: string): string[] {
  return value
    .split(/[,;\n]/)
    .map((address) => address.trim())
    .filter(Boolean)
}

// The saved version shown in the editor; a step never written starts from the defaults (the configured sender and
// the prospect's primary e-mail).
export function formOf(message: Message | null, defaults: MessageSequence['defaults']): MailForm {
  if (!message) return { from: defaults.from_email ?? '', to: defaults.to.join(', '), cc: '', bcc: '', subject: '', body: '' }
  return {
    from: message.from_email ?? '',
    to: message.to.join(', '),
    cc: message.cc.join(', '),
    bcc: message.bcc.join(', '),
    subject: message.subject,
    body: message.body_text,
  }
}

function normalized(form: MailForm) {
  return {
    from: form.from.trim().toLowerCase(),
    to: parseRecipients(form.to.toLowerCase()),
    cc: parseRecipients(form.cc.toLowerCase()),
    bcc: parseRecipients(form.bcc.toLowerCase()),
    subject: form.subject,
    body: form.body,
  }
}

// Unsaved edits, compared on what would be sent (spaces, separators and case of addresses ignored).
export function isDirty(form: MailForm, saved: MailForm): boolean {
  return JSON.stringify(normalized(form)) !== JSON.stringify(normalized(saved))
}

// `PUT …/messages/{step}` body: without a revision it creates the step's message.
export function contentOf(form: MailForm, revision: number | null): MessageContent {
  const value = normalized(form)
  return {
    ...(revision === null ? {} : { expected_revision: revision }),
    from_email: form.from.trim() || null,
    subject: value.subject,
    body_text: value.body,
    to: parseRecipients(form.to),
    cc: parseRecipients(form.cc),
    bcc: parseRecipients(form.bcc),
  }
}

// A local look at the addresses, to point at the right field before the call (the server stays the authority).
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/

// The API's limits (backend contact_messages): 50 addresses per field, 320 characters per address, a 100 000-character
// body.
export const MAX_RECIPIENTS = 50
export const ADDRESS_MAX_LENGTH = 320
export const BODY_MAX_LENGTH = 100_000
// A recipients field holding 50 addresses of the maximum length and their separators.
export const RECIPIENTS_MAX_LENGTH = MAX_RECIPIENTS * (ADDRESS_MAX_LENGTH + 2)

export function localErrors(form: MailForm): Partial<Record<MailField, string>> {
  const errors: Partial<Record<MailField, string>> = {}
  if (form.from.trim() && !EMAIL.test(form.from.trim())) errors.from = 'Adresse d’expédition invalide.'
  for (const field of ['to', 'cc', 'bcc'] as const) {
    const addresses = parseRecipients(form[field])
    const bad = addresses.filter((address) => !EMAIL.test(address) || address.length > ADDRESS_MAX_LENGTH)
    if (bad.length > 0) errors[field] = `Adresse invalide : ${bad.join(', ')}.`
    else if (addresses.length > MAX_RECIPIENTS) errors[field] = `${String(MAX_RECIPIENTS)} adresses au plus dans ce champ.`
  }
  return errors
}

export interface SequenceContext {
  state: TrackingStatus | null
  doNotContact: boolean
  closed: boolean
}

// Why nothing can be prepared, validated or scheduled any more; null while the sequence is open.
export function closedReason({ state, doNotContact, closed }: SequenceContext): string | null {
  if (doNotContact) {
    return 'Prospect en opposition (« Ne pas contacter ») : aucun message ne peut être préparé, validé ni programmé.'
  }
  if (!closed) return null
  const label = state ? TRACKING_LABELS[state] : 'close'
  return `Séquence close par l’état « ${label} » : aucun message ne peut être préparé, validé ni programmé. Les messages non envoyés ont été annulés.`
}

export interface MailActions {
  // The fields can be edited (otherwise a read-only view).
  editable: boolean
  // « Créer le brouillon » (never written) or « Enregistrer ».
  save: 'create' | 'save' | null
  validate: boolean
  schedule: boolean
  unschedule: boolean
  cancel: boolean
  reopen: boolean
  // Why the message is read-only, when it is.
  lock: string | null
}

const NONE: MailActions = {
  editable: false,
  save: null,
  validate: false,
  schedule: false,
  unschedule: false,
  cancel: false,
  reopen: false,
  lock: null,
}

// The actions a message offers in its status (which ones are enabled also depends on pending edits and on a request
// in flight: the editor decides that).
export function mailActions(message: Message | null, sequence: SequenceContext): MailActions {
  const status = message?.status ?? null
  const closed = closedReason(sequence)
  if (status === 'sent') {
    return { ...NONE, lock: 'Message envoyé : il reste consultable mais ne peut plus être modifié.' }
  }
  if (status === 'cancelled') {
    return closed
      ? { ...NONE, lock: `Message annulé. ${closed}` }
      : { ...NONE, reopen: true, lock: 'Message annulé : il ne partira pas. « Rouvrir » le repasse en Brouillon, à revalider.' }
  }
  if (closed) {
    // Taking a planned send back stays possible: it goes the way of the closed sequence.
    return { ...NONE, unschedule: status === 'scheduled', cancel: status !== null, lock: closed }
  }
  return {
    ...NONE,
    editable: true,
    save: status === null ? 'create' : 'save',
    validate: status === 'draft',
    schedule: status === 'validated',
    unschedule: status === 'scheduled',
    cancel: status !== null,
  }
}

// The sentence under the tab: where the message stands, without jargon.
export function statusLine(message: Message | null, closed: boolean): string {
  if (!message) {
    return closed
      ? 'Aucun message pour cette étape.'
      : 'Aucun message pour cette étape : le brouillon est créé au premier enregistrement.'
  }
  switch (message.status) {
    case 'draft':
      return 'Brouillon : à relire puis valider. Il ne peut pas partir tel quel.'
    case 'validated':
      return `Validé${message.validated_by ? ` par ${message.validated_by}` : ''} : prêt à être programmé.`
    case 'scheduled':
      return `Programmé pour le ${formatDateTime(message.scheduled_at ?? '')}.`
    case 'sent':
      return `Envoyé le ${formatDateTime(message.sent_at ?? '')}.`
    case 'cancelled': {
      const reason = cancelReasonLabel(message.cancel_reason)
      return `Annulé le ${formatDateTime(message.cancelled_at ?? '')}${reason ? ` (${reason})` : ''}.`
    }
  }
}

// `manual`, `prospect_state:<state>` or `do_not_contact` (decision 29 and the opposition).
export function cancelReasonLabel(reason: string | null): string | null {
  if (reason === 'manual') return 'à la main'
  if (reason === 'do_not_contact') return 'opposition « Ne pas contacter »'
  const state = reason?.startsWith('prospect_state:') ? reason.slice('prospect_state:'.length) : null
  return state && state in TRACKING_LABELS ? `passage à « ${TRACKING_LABELS[state as TrackingStatus]} »` : null
}

// Non-blocking: R1 (R2) scheduled while Contact (R1) has not left yet — nothing enforces the order (no step ordering
// in the API), the operator is only reminded. Null when nothing to say.
export function orderWarning(step: MessageStep, sequence: MessageSequence, at: Date | null): string | null {
  const index = MESSAGE_STEPS.indexOf(step)
  const previous = index > 0 ? MESSAGE_STEPS[index - 1] : undefined
  if (!previous) return null
  const before = sequence.steps.find((entry) => entry.step === previous)?.message ?? null
  if (before?.status === 'sent') return null
  const name = STEP_LABELS[previous]
  if (before?.status === 'scheduled' && before.scheduled_at && at && new Date(before.scheduled_at) >= at) {
    return `Le message ${name} est programmé plus tard (le ${formatDateTime(before.scheduled_at)}) : ${STEP_LABELS[step]} partirait avant lui.`
  }
  if (before?.status === 'scheduled') return null
  const where = before ? `est « ${MESSAGE_STATUS_LABELS[before.status]} »` : 'n’existe pas encore'
  return `Le message ${name} ${where} : vérifiez que ${STEP_LABELS[step]} ne partira pas avant lui.`
}

// --- the send moment: explicit local date + time → ISO 8601 with the browser's offset ---

const pad = (value: number) => String(Math.abs(value)).padStart(2, '0')

// `+02:00` from minutes east of UTC.
export function utcOffset(minutesEast: number): string {
  return `${minutesEast < 0 ? '-' : '+'}${pad(Math.trunc(minutesEast / 60))}:${pad(minutesEast % 60)}`
}

// « Europe/Paris, UTC+02:00 », shown beside the picker.
export function localZoneLabel(at: Date = new Date()): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const offset = `UTC${utcOffset(-at.getTimezoneOffset())}`
  return zone ? `${zone}, ${offset}` : offset
}

// `YYYY-MM-DD` of the local day (the picker's minimum).
export function localDay(at: Date): string {
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

export type ScheduleParse = { ok: true; iso: string; at: Date } | { ok: false; error: string }

const YEAR_MS = 366 * 24 * 60 * 60 * 1000

// The typed date and time (browser time) as an ISO moment. No default: a missing date or time is refused, so is a
// time that does not exist locally (spring-forward), a past moment and one more than a year ahead (server rule).
export function scheduleToIso(date: string, time: string, now: Date): ScheduleParse {
  if (!date && !time) return { ok: false, error: 'Choisissez la date et l’heure d’envoi.' }
  if (!date) return { ok: false, error: 'Choisissez la date d’envoi.' }
  if (!time) return { ok: false, error: 'Choisissez l’heure d’envoi (aucune heure n’est proposée par défaut).' }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const clock = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(time)
  if (!day || !clock) return { ok: false, error: 'Date ou heure illisible.' }
  const [year, month, dayOfMonth, hour, minute] = [day[1], day[2], day[3], clock[1], clock[2]].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ]
  const at = new Date(year, month - 1, dayOfMonth, hour, minute, 0, 0)
  const same =
    at.getFullYear() === year &&
    at.getMonth() === month - 1 &&
    at.getDate() === dayOfMonth &&
    at.getHours() === hour &&
    at.getMinutes() === minute
  if (!same) return { ok: false, error: 'Cette heure n’existe pas ce jour-là (changement d’heure) : choisissez-en une autre.' }
  if (at.getTime() <= now.getTime()) return { ok: false, error: 'La date et l’heure d’envoi doivent être dans le futur.' }
  if (at.getTime() - now.getTime() > YEAR_MS) return { ok: false, error: 'L’envoi ne peut pas être programmé à plus d’un an.' }
  return { ok: true, iso: `${date}T${pad(hour)}:${pad(minute)}:00${utcOffset(-at.getTimezoneOffset())}`, at }
}
