import type { Company, CompanyInput, Establishment, EstablishmentInput } from '../api/companies'

// Form model of the Company editor (Task 07): the draft keeps what the user typed; `toInput` produces the API payload
// (trimmed, blank → null, whitespace collapsed like the server). Validation mirrors the server rules
// (backend/app/services/companies.py) to give immediate French feedback; the server remains the judge.

export interface EstablishmentDraft {
  // Stable React key: the id, or a local one for a new establishment.
  key: string
  id: string | null
  name: string
  kind: string
  siret: string
  address_line1: string
  address_line2: string
  postal_code: string
  city: string
  country: string
  is_primary: boolean
}

export interface CompanyDraft {
  display_name: string
  legal_name: string
  siren: string
  website_url: string
  email_domain: string
  size_label: string
  commercial_segment_id: string | null
  activity_category_ids: string[]
  project_done_with_circoe: string
  project_type: string
  circoe_references: string
  client_approach: string
  establishments: EstablishmentDraft[]
}

// Errors and warnings by field path, the same paths the API uses (`siren`, `establishments.1.siret`).
export type FieldMessages = Record<string, string>

let localKey = 0

export function newEstablishment(isPrimary: boolean): EstablishmentDraft {
  localKey += 1
  return {
    key: `nouveau-${String(localKey)}`,
    id: null,
    name: '',
    kind: '',
    siret: '',
    address_line1: '',
    address_line2: '',
    postal_code: '',
    city: '',
    country: '',
    is_primary: isPrimary,
  }
}

export function emptyDraft(): CompanyDraft {
  return {
    display_name: '',
    legal_name: '',
    siren: '',
    website_url: '',
    email_domain: '',
    size_label: '',
    commercial_segment_id: null,
    activity_category_ids: [],
    project_done_with_circoe: '',
    project_type: '',
    circoe_references: '',
    client_approach: '',
    establishments: [],
  }
}

function establishmentDraft(row: Establishment): EstablishmentDraft {
  return {
    key: row.id,
    id: row.id,
    name: row.name ?? '',
    kind: row.kind ?? '',
    siret: formatSiret(row.siret ?? ''),
    address_line1: row.address_line1 ?? '',
    address_line2: row.address_line2 ?? '',
    postal_code: row.postal_code ?? '',
    city: row.city ?? '',
    country: row.country ?? '',
    is_primary: row.is_primary,
  }
}

export function draftFromCompany(company: Company): CompanyDraft {
  return {
    display_name: company.display_name,
    legal_name: company.legal_name ?? '',
    siren: formatSiren(company.siren ?? ''),
    website_url: company.website_url ?? '',
    email_domain: company.email_domain ?? '',
    size_label: company.size_label ?? '',
    commercial_segment_id: company.commercial_segment?.id ?? null,
    activity_category_ids: company.activity_categories.map((category) => category.id),
    project_done_with_circoe: company.project_done_with_circoe ?? '',
    project_type: company.project_type ?? '',
    circoe_references: company.circoe_references ?? '',
    client_approach: company.client_approach ?? '',
    establishments: company.establishments.map(establishmentDraft),
  }
}

// One line: trimmed, inner whitespace collapsed; blank → null.
function line(value: string): string | null {
  return value.replace(/\s+/g, ' ').trim() || null
}

function paragraph(value: string): string | null {
  return value.trim() || null
}

function establishmentInput(draft: EstablishmentDraft): EstablishmentInput {
  return {
    id: draft.id,
    name: line(draft.name),
    kind: line(draft.kind),
    siret: digitsOf(draft.siret) || null,
    address_line1: line(draft.address_line1),
    address_line2: line(draft.address_line2),
    postal_code: line(draft.postal_code),
    city: line(draft.city),
    country: line(draft.country),
    is_primary: draft.is_primary,
  }
}

export function toInput(draft: CompanyDraft): CompanyInput {
  return {
    display_name: line(draft.display_name) ?? '',
    legal_name: line(draft.legal_name),
    siren: digitsOf(draft.siren) || null,
    website_url: draft.website_url.trim() || null,
    email_domain: draft.email_domain.trim() || null,
    size_label: line(draft.size_label),
    commercial_segment_id: draft.commercial_segment_id,
    activity_category_ids: draft.activity_category_ids,
    project_done_with_circoe: paragraph(draft.project_done_with_circoe),
    project_type: paragraph(draft.project_type),
    circoe_references: paragraph(draft.circoe_references),
    client_approach: paragraph(draft.client_approach),
    establishments: draft.establishments.map(establishmentInput),
  }
}

// Unsaved changes: the payloads differ (typing a space or reordering nothing is not a change).
export function isDirty(draft: CompanyDraft, baseline: CompanyDraft): boolean {
  return JSON.stringify(toInput(draft)) !== JSON.stringify(toInput(baseline))
}

// --- identifiers --------------------------------------------------------------------------------------------------

// Spaces (regular and no-break) are ignored in SIREN/SIRET.
export function digitsOf(value: string): string {
  return value.replace(/\s+/g, '')
}

// `digits` holds ASCII digits only (checked before).
export function luhnValid(digits: string): boolean {
  let total = 0
  for (let position = 0; position < digits.length; position += 1) {
    const digit = Number(digits.charAt(digits.length - 1 - position)) * (position % 2 ? 2 : 1)
    total += digit > 9 ? digit - 9 : digit
  }
  return total % 10 === 0
}

function digitSum(digits: string): number {
  let total = 0
  for (let position = 0; position < digits.length; position += 1) total += Number(digits.charAt(position))
  return total
}

// La Poste's establishments share SIREN 356000000; their SIRETs are checked by digit sum instead of the Luhn key.
const LA_POSTE_SIREN = '356000000'

export function siretKeyValid(siret: string): boolean {
  if (siret.startsWith(LA_POSTE_SIREN)) return digitSum(siret) % 5 === 0
  return luhnValid(siret)
}

// "123456782" → "123 456 782", "12345678200011" → "123 456 782 00011" (display only; other values unchanged).
export function formatSiren(siren: string): string {
  return siren.replace(/^(\d{3})(\d{3})(\d{3})$/, '$1 $2 $3')
}

export function formatSiret(siret: string): string {
  return siret.replace(/^(\d{3})(\d{3})(\d{3})(\d{5})$/, '$1 $2 $3 $4')
}

// --- web values ---------------------------------------------------------------------------------------------------

const HOSTNAME = /^(?:[\p{L}\p{N}](?:[\p{L}\p{N}_-]{0,61}[\p{L}\p{N}])?\.)+[\p{L}\p{N}](?:[\p{L}\p{N}_-]{0,61}[\p{L}\p{N}])?$/u
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

export function websiteHost(value: string): string | null {
  const text = value.trim()
  if (!text || /\s/.test(text)) return null
  try {
    const url = new URL(SCHEME.test(text) ? text : `https://${text}`)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || !HOSTNAME.test(url.hostname)) return null
    return url.hostname
  } catch {
    return null
  }
}

// Same rule as the server: `@Exemple.fr`, `jean@exemple.fr`, `https://www.exemple.fr/` → `exemple.fr`.
export function normalizeEmailDomain(value: string): string {
  const afterAt = value.trim().toLowerCase().split('@').at(-1) ?? ''
  return (afterAt.replace(SCHEME, '').split('/')[0] ?? '').replace(/^www\./, '').replace(/\.+$/, '')
}

// Suggested e-mail domain for a company whose website is known: its host without `www.`.
export function suggestedEmailDomain(draft: CompanyDraft): string | null {
  if (draft.email_domain.trim()) return null
  return websiteHost(draft.website_url)?.replace(/^www\./, '') ?? null
}

// --- validation ---------------------------------------------------------------------------------------------------

const LIMITS = { display_name: 255, legal_name: 255, size_label: 100 } as const

function tooLong(value: string, max: number): string | null {
  return (line(value)?.length ?? 0) > max ? `${String(max)} caractères au plus.` : null
}

// Format always; check digit only when the value differs from the stored one (imported values never block an edit).
function identifierError(label: 'SIREN' | 'SIRET', value: string, stored: string | null): string | null {
  const digits = digitsOf(value)
  const length = label === 'SIREN' ? 9 : 14
  if (!digits) return null
  if (!new RegExp(`^\\d{${String(length)}}$`).test(digits)) return `Le ${label} comporte ${String(length)} chiffres.`
  const valid = label === 'SIREN' ? luhnValid(digits) : siretKeyValid(digits)
  if (!valid && digits !== stored) return `Ce ${label} n’est pas valide : un chiffre est sans doute erroné (clé de contrôle).`
  return null
}

function storedKeyWarning(label: 'SIREN' | 'SIRET', value: string): string | null {
  const digits = digitsOf(value)
  const valid = label === 'SIREN' ? luhnValid(digits) : siretKeyValid(digits)
  return digits && !valid ? `Le ${label} enregistré ne respecte pas la clé de contrôle : vérifiez-le.` : null
}

export interface Validation {
  errors: FieldMessages
  warnings: FieldMessages
}

// `baseline` is the saved state (identifiers kept unchanged are not re-checked).
export function validate(draft: CompanyDraft, baseline: CompanyDraft): Validation {
  const errors: FieldMessages = {}
  const warnings: FieldMessages = {}
  const set = (target: FieldMessages, field: string, message: string | null) => {
    if (message) target[field] = message
  }

  set(errors, 'display_name', line(draft.display_name) ? tooLong(draft.display_name, LIMITS.display_name) : 'Saisissez le nom de l’entreprise.')
  set(errors, 'legal_name', tooLong(draft.legal_name, LIMITS.legal_name))
  set(errors, 'size_label', tooLong(draft.size_label, LIMITS.size_label))

  const siren = digitsOf(draft.siren)
  const storedSiren = digitsOf(baseline.siren) || null
  set(errors, 'siren', identifierError('SIREN', draft.siren, storedSiren))
  if (!errors.siren && siren === storedSiren) set(warnings, 'siren', storedKeyWarning('SIREN', draft.siren))

  if (draft.website_url.trim() && !websiteHost(draft.website_url)) {
    errors.website_url = 'Adresse de site invalide (ex. www.exemple.fr).'
  }
  const domain = normalizeEmailDomain(draft.email_domain)
  if (domain && !HOSTNAME.test(domain)) errors.email_domain = 'Domaine invalide : saisissez par exemple exemple.fr.'

  const storedSirets = new Map(baseline.establishments.map((row) => [row.id, digitsOf(row.siret)]))
  const seen = new Set<string>()
  draft.establishments.forEach((row, index) => {
    const field = `establishments.${String(index)}.siret`
    const siret = digitsOf(row.siret)
    const stored = row.id ? (storedSirets.get(row.id) ?? null) : null
    set(errors, field, identifierError('SIRET', row.siret, stored))
    if (!errors[field] && siret && seen.has(siret)) errors[field] = 'Ce SIRET est déjà saisi pour un autre établissement.'
    if (siret) seen.add(siret)
    if (errors[field] || !siret) return
    if (siret === stored) set(warnings, field, storedKeyWarning('SIRET', row.siret))
    if (/^\d{9}$/.test(siren) && !siret.startsWith(siren)) {
      warnings[field] = `Ce SIRET ne commence pas par le SIREN de l’entreprise (${formatSiren(siren)}) : vérifiez-le.`
    }
  })
  return { errors, warnings }
}
