// The mail editor's pure rules (Contact decisions 20-25, 29; backend state machine: doc/features/contact.md):
// - the form holds the operator's text; the saved version always comes from the server;
// - « Enregistrer » never validates; « Valider » and « Programmer » act on the saved version (no pending edit);
// - saving a validated or scheduled message puts it back to Brouillon (server rule, said before saving);
// - no default send time: date and time are typed, then sent as ISO 8601 with the browser's offset;
// - nothing here changes the prospect's state;
// - the scheduled send (S7) belongs to the server's dispatcher: a claimed message is locked; a send it could not confirm
//   is settled by a person (« Marquer envoyé » / « Remettre en Validé »), after checking the Infomaniak mailbox.
import {
  MESSAGE_STEPS,
  type Message,
  type MessageContent,
  type MessageSequence,
  type MessageStep,
  UNCONFIRMED_SEND_CODES,
} from '../api/contact'
import type { TrackingStatus } from '../api/prospection'
import type { ToolboxState } from '../api/toolbox'
import { TRACKING_LABELS } from '../prospection/labels'
import { toolboxErrorLabel } from '../settings/toolboxCopy'
import { inactiveSentence } from './dispatchCopy'
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
  // A send the dispatcher could not confirm: « Marquer envoyé… » / « Remettre en Validé… » (S7).
  settle: boolean
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
  settle: false,
  editable: false,
  save: null,
  validate: false,
  schedule: false,
  unschedule: false,
  cancel: false,
  reopen: false,
  lock: null,
}

// --- the scheduled send (S7) ---

// The dispatcher's codes saying a send ended without a known outcome: a person may settle it at once.
const UNCONFIRMED_CODES = UNCONFIRMED_SEND_CODES

export type DispatchState = 'none' | 'sending' | 'unconfirmed'

export interface DispatchClock {
  now: number
  // `defaults.dispatch_claim_ttl_seconds`: a claim older than this is unconfirmed (its process died).
  claimTtlSeconds: number
}

// `sending` while the dispatcher holds the message (the send may be running); `unconfirmed` once the send ended without
// a known outcome, or its claim outlived the TTL.
export function dispatchState(message: Message | null, clock?: DispatchClock): DispatchState {
  if (message?.status !== 'scheduled' || !message.dispatch_claimed_at) return 'none'
  if (message.last_error_code && UNCONFIRMED_CODES.has(message.last_error_code)) return 'unconfirmed'
  if (clock && clock.now - new Date(message.dispatch_claimed_at).getTime() >= clock.claimTtlSeconds * 1000) {
    return 'unconfirmed'
  }
  return 'sending'
}

// The actions a message offers in its status (which ones are enabled also depends on pending edits and on a request
// in flight: the editor decides that).
export function mailActions(message: Message | null, sequence: SequenceContext, clock?: DispatchClock): MailActions {
  const status = message?.status ?? null
  const closed = closedReason(sequence)
  const dispatch = dispatchState(message, clock)
  if (dispatch === 'sending') {
    return { ...NONE, lock: 'Envoi en cours : le message est verrouillé le temps de l’envoi.' }
  }
  if (dispatch === 'unconfirmed') {
    return { ...NONE, settle: true, lock: 'Message verrouillé tant que son envoi n’est pas tranché.' }
  }
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

// The sentence under the tab: where the message stands, without jargon. `automatic` = the server really sends
// scheduled messages (`defaults.automatic_sending_active`).
export function statusLine(message: Message | null, closed: boolean, automatic = false): string {
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
      return automatic
        ? `Programmé : le mail partira automatiquement le ${formatDateTime(message.scheduled_at ?? '')} depuis la boîte Infomaniak connectée, déprogrammable jusqu’à l’envoi.`
        : `Programmé pour le ${formatDateTime(message.scheduled_at ?? '')}.`
    case 'sent':
      return `Envoyé le ${formatDateTime(message.sent_at ?? '')}.`
    case 'cancelled': {
      const reason = cancelReasonLabel(message.cancel_reason)
      return `Annulé le ${formatDateTime(message.cancelled_at ?? '')}${reason ? ` (${reason})` : ''}.`
    }
  }
}

export interface RemoteDraftLine {
  tone: 'ok' | 'warning' | 'muted'
  text: string
  // « Réessayer » is offered (the Toolbox is connected and the draft is missing).
  retry: boolean
}

// The Infomaniak draft of a validated or scheduled message (CIRCOE Toolbox, S6), said discreetly under the status.
// Nothing while the Toolbox is off or not configured and no draft exists (everything stays local, as before S6);
// enabled but not connected (or expired), the person learns that no draft is created.
export function remoteDraftLine(message: Message | null, toolboxState: ToolboxState): RemoteDraftLine | null {
  if (!message || (message.status !== 'validated' && message.status !== 'scheduled')) return null
  if (message.has_remote_draft) return { tone: 'ok', text: 'Brouillon créé dans Infomaniak.', retry: false }
  const connected = toolboxState === 'connected'
  const code = message.last_error_code
  if (code?.startsWith('toolbox_') && (connected || code !== 'toolbox_auth_expired')) {
    return { tone: 'warning', text: `Brouillon Infomaniak non créé : ${toolboxErrorLabel(code)}.`, retry: connected }
  }
  if (toolboxState === 'disconnected' || toolboxState === 'expired') {
    return { tone: 'muted', text: 'Brouillon Infomaniak non créé : Toolbox à reconnecter.', retry: false }
  }
  if (!connected) return null
  return { tone: 'muted', text: 'Brouillon Infomaniak pas encore créé.', retry: true }
}

// « 6 heures », « 90 minutes ».
export function latenessLabel(minutes: number): string {
  if (minutes === 60) return '1 heure'
  return minutes >= 120 && minutes % 60 === 0 ? `${String(minutes / 60)} heures` : `${String(minutes)} minutes`
}

// The dispatcher's `send_*` / `dispatch_*` codes (backend app/services/contact_dispatch.py), in French. `toolbox_*`
// codes belong to the Infomaniak draft (remoteDraftLine).
export function sendErrorLabel(code: string, latenessMinutes: number): string {
  const labels: Record<string, string> = {
    send_unavailable: 'la Toolbox ne répondait pas',
    send_timeout: 'la Toolbox n’a pas répondu à temps',
    send_not_configured: 'la Toolbox n’est pas connectée (Paramètres › Connexions)',
    send_not_connected: 'la Toolbox n’était pas connectée',
    send_auth_expired: 'la connexion à la Toolbox a expiré : reconnectez-la (Paramètres › Connexions)',
    send_rejected: 'la Toolbox a refusé l’envoi',
    send_outbound_blocked: 'un destinataire n’est pas autorisé par la liste d’envoi de la Toolbox',
    send_invalid_input: 'la Toolbox a refusé le message (champ invalide)',
    send_draft_not_found:
      'le brouillon n’existait plus dans Infomaniak (supprimé, ou envoyé depuis le webmail : vérifiez les éléments envoyés)',
    send_invalid_response: 'la réponse de la Toolbox était illisible',
    send_not_confirmed:
      'envoi non confirmé, brouillon toujours présent dans Infomaniak : vérifiez les éléments envoyés de la boîte',
    send_missing_recipients: 'le message n’a aucun destinataire',
    send_recipient_not_allowed:
      'un destinataire ne figure pas dans la liste d’adresses autorisées (Paramètres › Connexions › Envoi programmé)',
    send_previous_step_pending: 'le message précédent de la séquence n’est pas encore parti : il doit partir avant',
    send_draft_not_created: 'le brouillon Infomaniak n’a pas pu être créé avant l’envoi',
    dispatch_overdue: `l’heure prévue était dépassée de plus de ${latenessLabel(latenessMinutes)} (serveur arrêté ou Toolbox déconnectée) : il n’est pas parti en retard`,
    dispatch_internal_error: 'erreur inattendue du serveur (voir ses journaux)',
  }
  return labels[code] ?? `erreur inattendue (${code})`
}

export interface DispatchLine {
  tone: 'ok' | 'warning' | 'muted' | 'progress'
  text: string
}

// What the scheduled send (S7) says under the status sentence, or null. `automatic` / `toolboxState` /
// `latenessMinutes` come from the sequence's defaults.
export function dispatchLine(
  message: Message | null,
  defaults: Pick<MessageSequence['defaults'], 'automatic_sending_active' | 'toolbox_state' | 'dispatch_max_lateness_minutes'>,
  state: DispatchState,
): DispatchLine | null {
  if (!message) return null
  const code = message.last_error_code
  const lateness = defaults.dispatch_max_lateness_minutes
  if (message.status === 'sent') {
    if (code === 'send_reconciled_draft_absent') {
      return {
        tone: 'muted',
        text: 'Envoi déduit : la Toolbox n’a pas confirmé l’envoi, mais le brouillon a quitté la boîte Infomaniak. Vérifiez au besoin dans ses éléments envoyés.',
      }
    }
    if (code === 'send_marked_by_person') {
      return { tone: 'muted', text: 'Envoi confirmé par une personne après vérification dans la boîte Infomaniak.' }
    }
    return null
  }
  if (message.status === 'scheduled') {
    if (state === 'sending') return { tone: 'progress', text: 'Envoi en cours par la Toolbox…' }
    if (state === 'unconfirmed' && code === 'send_probably_sent') {
      return {
        tone: 'warning',
        text: 'Probablement envoyé : une tentative précédente n’avait pas été confirmée et le brouillon a maintenant quitté Infomaniak. VIPER ne le renverra pas ; il le déduira envoyé à la vérification suivante. Après avoir vérifié les éléments envoyés de la boîte, vous pouvez trancher :',
      }
    }
    if (state === 'unconfirmed') {
      return {
        tone: 'warning',
        text: 'Envoi non confirmé : la Toolbox n’a pas donné de réponse sûre. VIPER ne le renverra jamais de lui-même et vérifie dans Infomaniak (brouillon disparu = envoyé). Après avoir vérifié les éléments envoyés de la boîte, vous pouvez trancher :',
      }
    }
    // Inactive sending (S9): the editor shows « Ne partira pas » with its reason and link (inactiveScheduleText).
    if (!defaults.automatic_sending_active) return null
    if (code && (code.startsWith('send_') || code.startsWith('dispatch_'))) {
      return {
        tone: 'warning',
        text: `Dernière tentative d’envoi échouée : ${sendErrorLabel(code, lateness)}. Nouvel essai automatique.`,
      }
    }
    return null
  }
  if (message.status === 'validated' && code) {
    if (code === 'send_released_by_person') {
      return {
        tone: 'muted',
        text: 'Remis en Validé par une personne après un envoi non confirmé : vérifiez la boîte Infomaniak avant de le reprogrammer.',
      }
    }
    if (code === 'send_not_confirmed') {
      return {
        tone: 'warning',
        text: 'Envoi non confirmé, brouillon toujours présent dans Infomaniak : vérifiez les éléments envoyés de la boîte, puis reprogrammez-le si le mail n’est pas parti. VIPER ne le renvoie jamais de lui-même.',
      }
    }
    if (code === 'dispatch_overdue') {
      return {
        tone: 'warning',
        text: `Pas envoyé : l’heure prévue était dépassée de plus de ${latenessLabel(lateness)} quand l’envoi automatique a pu le traiter (envoi désactivé, Toolbox déconnectée ou serveur arrêté). VIPER n’envoie jamais un mail en retard : le message est revenu à « Validé ». Choisissez une nouvelle date dans « Programmer l’envoi » pour le reprogrammer.`,
      }
    }
    if (code === 'dispatch_held') {
      return {
        tone: 'warning',
        text: 'Programmation retirée par l’exploitation du serveur (sauvegarde restaurée ou maintenance) : reprogrammez-le si l’envoi est toujours voulu.',
      }
    }
    if (code.startsWith('send_') || code.startsWith('dispatch_')) {
      return {
        tone: 'warning',
        text: `Envoi programmé non effectué : ${sendErrorLabel(code, lateness)}. Le message reste validé : reprogrammez-le pour réessayer.`,
      }
    }
  }
  return null
}

// « Remettre en Validé » of an unconfirmed send waits for the claim's delay (the Toolbox may still be finishing it):
// the moment it becomes possible, or null when it already is (or nothing to release).
export function releaseAvailableAt(message: Message | null, claimTtlSeconds: number, now: number): number | null {
  if (message?.status !== 'scheduled' || !message.dispatch_claimed_at) return null
  const at = new Date(message.dispatch_claimed_at).getTime() + claimTtlSeconds * 1000
  return at > now ? at : null
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

// « Ne partira pas » (S9): what the editor says under a scheduled message the server will not send. `now` in ms.
export function inactiveScheduleText(
  message: Message,
  defaults: Pick<MessageSequence['defaults'], 'dispatch_reason' | 'dispatch_max_lateness_minutes'>,
  now: number,
): string {
  const late = message.scheduled_at !== null && new Date(message.scheduled_at).getTime() < now
  const overdue = late
    ? ` L’heure prévue est passée : s’il ne peut pas partir dans les ${latenessLabel(defaults.dispatch_max_lateness_minutes)} qui la suivent, il reviendra à « Validé » sans partir.`
    : ''
  return `${inactiveSentence(defaults.dispatch_reason)}${overdue}`
}
