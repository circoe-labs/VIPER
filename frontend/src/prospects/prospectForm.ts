import type { ActivityStatus, ChannelVerification, TrackingStatus } from '../api/prospection'
import type {
  Civility,
  EmailInput,
  OriginType,
  PhoneInput,
  PhoneType,
  Prospect,
  ProspectCreateInput,
  ProspectInput,
  VerificationAction,
} from '../api/prospects'
import { formatPhone } from '../prospection/labels'

// Form model of the Prospect editor (Task 15): the draft keeps what the user typed; `toInput` produces the API payload.
// The server rules (backend/app/services/prospect_editor.py, contact_channels.py) are mirrored where the editor must
// show their effect before saving — normalized values, the one primary alias, the company-change rule (I-13) — and to
// give immediate French feedback; the server remains the judge.

export type AliasKind = 'emails' | 'phones'

export interface StoredAlias {
  value: string
  is_active: boolean
  verification_status: ChannelVerification
  last_verified_at: string | null
  origin_type: OriginType
  source_reference: string | null
  imported_unverified: boolean
}

export interface AliasDraft {
  // Stable React key: the id, or a local one for a new alias.
  key: string
  id: string | null
  value: string
  // Phones: the type, and whether the user chose it (until then it follows the number).
  type: PhoneType
  typeChosen: boolean
  is_primary: boolean
  is_active: boolean
  verification_status: ChannelVerification
  // The one-click « Vérifié », applied at the save (dated by the server).
  verified_now: boolean
  source_reference: string
  // As loaded; null for a new alias.
  stored: StoredAlias | null
}

export interface TrackingDraft {
  // '' = no contact tracking yet.
  status: TrackingStatus | ''
  // `YYYY-MM-DD` (date inputs) or ''.
  planned_contact_on: string
  response_received_on: string
  appointment_on: string
  // `HH:MM` or ''.
  appointment_time: string
  referent_id: string | null
}

export interface ProspectDraft {
  civility: Civility | ''
  first_name: string
  last_name: string
  company_id: string | null
  role_id: string | null
  // A role to create with the save (typed in the role picker).
  role_label: string | null
  exact_job_title: string
  activity_status: ActivityStatus
  verification: { action: VerificationAction; day: string }
  emails: AliasDraft[]
  phones: AliasDraft[]
  tracking: TrackingDraft
  // New prospect only: its provenance.
  legal_context: string
  source_reference: string
}

// Errors by field path — the API's paths (`emails.1.address`), with draft indexes.
export type FieldMessages = Record<string, string>

export const DEFAULT_COLLECTION_CONTEXT = 'Saisie manuelle — prospection B2B'

let localKey = 0

export function newAlias(kind: AliasKind, isPrimary: boolean): AliasDraft {
  localKey += 1
  return {
    key: `nouveau-${kind}-${String(localKey)}`,
    id: null,
    value: '',
    type: 'mobile',
    typeChosen: false,
    is_primary: isPrimary,
    is_active: true,
    verification_status: 'unverified',
    verified_now: false,
    source_reference: '',
    stored: null,
  }
}

const EMPTY_TRACKING: TrackingDraft = {
  status: '',
  planned_contact_on: '',
  response_received_on: '',
  appointment_on: '',
  appointment_time: '',
  referent_id: null,
}

export interface NewProspectDefaults {
  // Kept from the previous person by « Enregistrer et nouveau ».
  company_id?: string | null
  legal_context?: string
  source_reference?: string
}

export function emptyDraft(defaults: NewProspectDefaults = {}): ProspectDraft {
  return {
    civility: '',
    first_name: '',
    last_name: '',
    company_id: defaults.company_id ?? null,
    role_id: null,
    role_label: null,
    exact_job_title: '',
    activity_status: 'unknown',
    verification: { action: 'keep', day: '' },
    emails: [newAlias('emails', true)],
    phones: [newAlias('phones', true)],
    tracking: EMPTY_TRACKING,
    legal_context: defaults.legal_context ?? DEFAULT_COLLECTION_CONTEXT,
    source_reference: defaults.source_reference ?? '',
  }
}

function aliasDraft(
  id: string,
  value: string,
  type: PhoneType,
  alias: Omit<StoredAlias, 'value'> & { is_primary: boolean },
): AliasDraft {
  return {
    key: id,
    id,
    value,
    type,
    typeChosen: true,
    is_primary: alias.is_primary,
    is_active: alias.is_active,
    verification_status: alias.verification_status,
    verified_now: false,
    source_reference: alias.source_reference ?? '',
    stored: { ...alias, value },
  }
}

export function draftFromProspect(prospect: Prospect): ProspectDraft {
  const tracking = prospect.tracking
  return {
    civility: prospect.civility ?? '',
    first_name: prospect.first_name ?? '',
    last_name: prospect.last_name ?? '',
    company_id: prospect.company?.id ?? null,
    role_id: prospect.role?.id ?? null,
    role_label: null,
    exact_job_title: prospect.exact_job_title ?? '',
    activity_status: prospect.activity_status,
    verification: { action: 'keep', day: '' },
    emails: prospect.emails.map((email) => aliasDraft(email.id, email.address, 'other', email)),
    phones: prospect.phones.map((phone) => aliasDraft(phone.id, formatPhone(phone.number), phone.type, phone)),
    tracking: tracking
      ? {
          status: tracking.status,
          planned_contact_on: tracking.planned_contact_on ?? '',
          response_received_on: tracking.response_received_on ?? '',
          appointment_on: tracking.appointment_on ?? '',
          appointment_time: tracking.appointment_time?.slice(0, 5) ?? '',
          referent_id: tracking.referent?.id ?? null,
        }
      : EMPTY_TRACKING,
    legal_context: '',
    source_reference: '',
  }
}

// --- values -------------------------------------------------------------------------------------------------------

// `  Jean@Exemple.FR ` → `jean@exemple.fr` (server: contact_channels.normalize_email_address).
export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase().replace(/^mailto:/, '')
}

const EMAIL = /^[a-z0-9!#$%&'*+=?^_`{}~-]+(?:\.[a-z0-9!#$%&'*+=?^_`{}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/

// `06 12 34 56 78`, `+33 (0)6…`, `0033 6…` → `+33612345678`; other international numbers keep their digits; null when
// the text is not a phone number (server: imports.normalize.normalize_phone).
export function normalizePhone(value: string): string | null {
  let cleaned = value.replace('(0)', '').replace(/[\s.\-()]/g, '')
  if (!/^\+?\d+$/.test(cleaned)) return null
  if (cleaned.startsWith('00')) cleaned = `+${cleaned.slice(2)}`
  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1)
    if (digits.startsWith('33')) {
      const national = digits.slice(2).replace(/^0/, '')
      return /^[1-9]\d{8}$/.test(national) ? `+33${national}` : null
    }
    return digits.length >= 4 && digits.length <= 20 ? cleaned : null
  }
  if (/^0[1-9]\d{8}$/.test(cleaned)) return `+33${cleaned.slice(1)}`
  return !cleaned.startsWith('0') && cleaned.length >= 4 && cleaned.length <= 20 ? cleaned : null
}

// French numbering plan: 06/07 mobile, 08 other, 01-05/09 landline; unknown numbers stay as they are.
export function suggestedPhoneType(value: string): PhoneType | null {
  const number = normalizePhone(value)
  if (!number?.startsWith('+33')) return null
  const prefix = number.charAt(3)
  if (prefix === '6' || prefix === '7') return 'mobile'
  return prefix === '8' ? 'other' : 'landline'
}

function normalized(kind: AliasKind, value: string): string {
  return kind === 'emails' ? normalizeEmail(value) : (normalizePhone(value) ?? value.trim())
}

export function valueChanged(kind: AliasKind, alias: AliasDraft): boolean {
  return alias.stored !== null && normalized(kind, alias.value) !== normalized(kind, alias.stored.value)
}

// A new alias with nothing typed is left out of the save.
function isBlankNew(alias: AliasDraft): boolean {
  return alias.id === null && alias.value.trim() === ''
}

// The status the save will record, the rules of the server applied: a verification is explicit (`verified_now`); a
// changed value was never verified; a company change sends verified active aliases back to « non vérifié » (I-13).
export function effectiveStatus(kind: AliasKind, alias: AliasDraft, companyMoved: boolean): ChannelVerification {
  if (alias.verified_now) return 'verified'
  if (alias.verification_status !== 'verified') return alias.verification_status
  if (!alias.stored || valueChanged(kind, alias)) return 'unverified'
  return companyMoved && alias.stored.is_active ? 'unverified' : 'verified'
}

// --- payload ------------------------------------------------------------------------------------------------------

function line(value: string): string | null {
  return value.replace(/\s+/g, ' ').trim() || null
}

// Draft index of every alias the payload carries (blank new ones are left out), to place server refusals.
export function payloadIndexes(aliases: AliasDraft[]): number[] {
  return aliases.flatMap((alias, index) => (isBlankNew(alias) ? [] : [index]))
}

function aliasFields(kind: AliasKind, alias: AliasDraft, companyMoved: boolean) {
  return {
    id: alias.id,
    is_primary: alias.is_primary,
    is_active: alias.is_active,
    verification_status: effectiveStatus(kind, alias, companyMoved),
    verified_now: alias.verified_now,
    // A stored alias's source is not editable here: sent back exactly as stored (e.g. an import reference keeps the
    // sheet name's own spacing), so a save never rewrites it.
    source_reference: alias.stored ? alias.stored.source_reference : line(alias.source_reference),
  }
}

function trackingInput(tracking: TrackingDraft) {
  const dates = {
    planned_contact_on: tracking.planned_contact_on || null,
    response_received_on: tracking.response_received_on || null,
    appointment_on: tracking.appointment_on || null,
    appointment_time: tracking.appointment_time || null,
    referent_id: tracking.referent_id,
  }
  const anything = Object.values(dates).some((value) => value !== null)
  if (tracking.status === '' && !anything) return null
  return { status: tracking.status || 'to_contact', ...dates }
}

// `baselineCompany`: the company when the prospect was loaded (null for a new one).
export function toInput(draft: ProspectDraft, baselineCompany: string | null): ProspectInput {
  const moved = baselineCompany !== null && draft.company_id !== baselineCompany
  return {
    civility: draft.civility || null,
    first_name: line(draft.first_name),
    last_name: line(draft.last_name),
    company_id: draft.company_id,
    role_id: draft.role_label ? null : draft.role_id,
    role_label: draft.role_label,
    exact_job_title: line(draft.exact_job_title),
    activity_status: draft.activity_status,
    employment_verification: {
      action: draft.verification.action,
      day: draft.verification.action === 'verified_on' ? draft.verification.day || null : null,
    },
    emails: draft.emails
      .filter((alias) => !isBlankNew(alias))
      .map((alias): EmailInput => ({ address: alias.value.trim(), ...aliasFields('emails', alias, moved) })),
    phones: draft.phones
      .filter((alias) => !isBlankNew(alias))
      .map((alias): PhoneInput => ({ number: alias.value.trim(), type: alias.type, ...aliasFields('phones', alias, moved) })),
    tracking: trackingInput(draft.tracking),
  }
}

export function toCreateInput(draft: ProspectDraft): ProspectCreateInput {
  return {
    ...toInput(draft, null),
    provenance: {
      legal_basis_or_collection_context: draft.legal_context.trim(),
      source_reference: line(draft.source_reference),
    },
  }
}

// Unsaved changes: the payloads differ (typing a space or reformatting a number is not a change).
export function isDirty(draft: ProspectDraft, baseline: ProspectDraft, isNew: boolean): boolean {
  const payload = (value: ProspectDraft) =>
    JSON.stringify(isNew ? toCreateInput(value) : toInput(value, baseline.company_id))
  return payload(draft) !== payload(baseline)
}

// --- validation ---------------------------------------------------------------------------------------------------

const LIMITS = { name: 100, title: 255, context: 2000 } as const

function tooLong(value: string, max: number): string | null {
  return (line(value)?.length ?? 0) > max ? `${String(max)} caractères au plus.` : null
}

function aliasErrors(kind: AliasKind, aliases: AliasDraft[], errors: FieldMessages) {
  const field = kind === 'emails' ? 'address' : 'number'
  const seen = new Set<string>()
  aliases.forEach((alias, index) => {
    if (isBlankNew(alias)) return
    const path = `${kind}.${String(index)}.${field}`
    if (!alias.value.trim()) {
      errors[path] = kind === 'emails' ? 'Saisissez l’adresse ou retirez la ligne.' : 'Saisissez le numéro ou retirez la ligne.'
      return
    }
    const value = kind === 'emails' ? normalizeEmail(alias.value) : normalizePhone(alias.value)
    if (value === null || (kind === 'emails' && !EMAIL.test(value))) {
      errors[path] =
        kind === 'emails'
          ? 'Adresse e-mail invalide (ex. prenom.nom@exemple.fr).'
          : 'Numéro invalide : 10 chiffres pour la France (06 12 34 56 78), ou +indicatif.'
      return
    }
    if (seen.has(value)) errors[path] = kind === 'emails' ? 'Cette adresse est déjà saisie.' : 'Ce numéro est déjà saisi.'
    seen.add(value)
  })
}

// `today`: business day `YYYY-MM-DD` (a verification cannot be later).
export function validate(draft: ProspectDraft, { isNew, today }: { isNew: boolean; today: string }): FieldMessages {
  const errors: FieldMessages = {}
  const set = (field: string, message: string | null) => {
    if (message) errors[field] = message
  }
  set('first_name', tooLong(draft.first_name, LIMITS.name))
  set('last_name', tooLong(draft.last_name, LIMITS.name))
  if (!line(draft.first_name) && !line(draft.last_name)) errors.last_name = 'Saisissez au moins un prénom ou un nom.'
  if (!draft.company_id) errors.company_id = 'Choisissez l’entreprise, ou créez-la depuis ce champ.'
  set('exact_job_title', tooLong(draft.exact_job_title, LIMITS.title))
  const { action, day } = draft.verification
  if (action === 'verified_on') {
    if (!day) errors['employment_verification.day'] = 'Choisissez la date de vérification.'
    else if (day > today) errors['employment_verification.day'] = 'La date de vérification ne peut pas être dans le futur.'
  }
  aliasErrors('emails', draft.emails, errors)
  aliasErrors('phones', draft.phones, errors)
  const { tracking } = draft
  if (tracking.appointment_time && !tracking.appointment_on) {
    errors['tracking.appointment_time'] = 'Indiquez aussi le jour du rendez-vous.'
  }
  if (isNew) {
    if (!draft.legal_context.trim()) {
      errors['provenance.legal_basis_or_collection_context'] = 'Indiquez le contexte de collecte (ou la base légale).'
    } else {
      set('provenance.legal_basis_or_collection_context', tooLong(draft.legal_context, LIMITS.context))
    }
  }
  return errors
}

// --- small helpers ------------------------------------------------------------------------------------------------

// ISO 8601 week of a `YYYY-MM-DD` day, e.g. « S38 » (the backend's planned-contact week, business time).
export function isoWeekLabel(day: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!match) return null
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7))
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1)
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7)
  return `S${String(week)}`
}

// Domain of an e-mail address (`jean@exemple.fr` → `exemple.fr`).
export function emailDomain(value: string): string | null {
  const at = normalizeEmail(value).lastIndexOf('@')
  return at < 0 ? null : normalizeEmail(value).slice(at + 1) || null
}
