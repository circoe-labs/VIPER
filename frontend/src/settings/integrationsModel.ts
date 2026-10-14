import { ApiError } from '../api/client'
import {
  type IntegrationField,
  type IntegrationSetting,
  KEY_CHECK_DEADLINE_MS,
  type KeyCheck,
  SAVE_DEADLINE_MS,
  type SettingValue,
} from '../api/integrations'
import { formatDateTime } from '../contact/labels'

// Paramètres › Connexions (Contact port S8): the form values of the integration settings, their French refusals and
// where each value comes from. Pure functions; the cards are in IntegrationCards.tsx.

type Kind = 'text' | 'seconds' | 'integer'

// The switches (`toolbox_mail_enabled`, `contact_dispatch_enabled`) are saved as they are toggled: not form fields.
const KINDS: Record<Exclude<IntegrationField, 'toolbox_mail_enabled' | 'contact_dispatch_enabled'>, Kind> = {
  openai_model: 'text',
  openai_base_url: 'text',
  openai_timeout_ms: 'seconds',
  openai_max_retries: 'integer',
  contact_booking_url: 'text',
  contact_initial_prompt: 'text',
  default_outbound_email: 'text',
  toolbox_mcp_url: 'text',
  toolbox_oauth_redirect_uri: 'text',
  contact_dispatch_interval_ms: 'seconds',
  infomaniak_send_allowlist: 'text',
}

export type FormField = keyof typeof KINDS

// What the input shows for a server value (`null` = empty; a timeout in seconds).
export function toDraft(field: FormField, value: SettingValue): string {
  if (value === null || typeof value === 'boolean') return ''
  if (KINDS[field] === 'seconds' && typeof value === 'number') return String(value / 1000)
  return String(value)
}

// The value sent for an input: trimmed text (empty = « none »), or a number; `Error` when it is not a number.
export function fromDraft(field: FormField, draft: string): SettingValue | Error {
  const text = draft.trim()
  const kind = KINDS[field]
  // An emptied text goes back to the default (S8 QA M2): never a typed "".
  if (kind === 'text') return text === '' ? null : text
  const number = Number(text.replace(',', '.'))
  if (text === '' || !Number.isFinite(number)) return new Error(FIELD_ERRORS[field])
  if (kind === 'seconds') return Math.round(number * 1000)
  if (!Number.isInteger(number)) return new Error(FIELD_ERRORS[field])
  return number
}

// The key is never sent to another API address than the one it was saved with (S8 QA M1).
export const KEY_REQUIRED_WITH_BASE_URL =
  'Changer l’adresse de l’API demande de saisir la clé à nouveau : une clé n’est jamais envoyée à une autre adresse que celle avec laquelle elle a été enregistrée.'

export const FIELD_ERRORS: Record<FormField | 'openai_api_key', string> = {
  openai_api_key: 'Saisissez une clé d’API OpenAI (elle commence en général par « sk- »).',
  openai_model: 'Indiquez le modèle OpenAI à utiliser : il est obligatoire dès qu’une clé est enregistrée.',
  openai_base_url: 'Adresse http(s) complète attendue, par exemple https://api.openai.com/v1.',
  openai_timeout_ms: 'Indiquez un délai entre 1 et 300 secondes.',
  openai_max_retries: 'Indiquez un nombre entier de 0 à 5.',
  contact_booking_url: 'Adresse http(s) complète attendue, ou laissez vide pour ne proposer aucun lien.',
  contact_initial_prompt: 'Le prompt initial est limité à 8 000 caractères.',
  default_outbound_email: 'Adresse e-mail invalide.',
  toolbox_mcp_url: 'Adresse https attendue (http seulement sur localhost).',
  toolbox_oauth_redirect_uri:
    'Adresse https attendue (http seulement sur localhost) : ouvrez VIPER en https ou sur localhost pour vous connecter.',
  contact_dispatch_interval_ms: 'Indiquez un délai entre 1 et 3 600 secondes.',
  infomaniak_send_allowlist: 'Adresses e-mail ou règles « @domaine » séparées par des virgules.',
}

// The « Délai maximal avant envoi » (S9): the dispatcher's period, 1 s to 1 h (0 is the switch's « off »).
export const DISPATCH_DELAY_MIN_MS = 1000
// The server's default delay (backend `contact_dispatch_interval_ms`).
export const DEFAULT_DISPATCH_INTERVAL_MS = 30_000
export const DISPATCH_DELAY_MAX_MS = 3_600_000

// Where the value comes from, in one short sentence.
export function sourceText(setting: Pick<IntegrationSetting, 'source' | 'updated_at' | 'updated_by'>): string {
  switch (setting.source) {
    case 'ui': {
      const who = setting.updated_by ? ` par ${setting.updated_by}` : ''
      const when = setting.updated_at ? `, le ${formatDateTime(setting.updated_at)}` : ''
      return `Défini ici${who}${when}.`
    }
    case 'env':
      return 'Valeur fournie par la configuration du serveur.'
    case 'default':
      return 'Valeur par défaut.'
  }
}

export function fallbackText(field: FormField, fallback: SettingValue): string {
  if (fallback === null || fallback === '') return 'aucune valeur'
  if (KINDS[field] === 'seconds' && typeof fallback === 'number') return `${String(fallback / 1000)} s`
  return String(fallback)
}

export interface SaveRefusal {
  // The field to show the message under, when the server named one.
  field?: string
  message: string
  // The settings changed meanwhile: they were read again.
  reload?: boolean
}

// A failed save, in French: the field's own rule, a conflict, or what kept the request from the server.
export function saveRefusal(error: unknown): SaveRefusal {
  if (error instanceof ApiError) {
    const detail = error.detail
    // FastAPI's own 422 (a malformed value, e.g. a key too long): the field it names.
    if (Array.isArray(detail)) {
      const location = (detail[0] as { loc?: unknown[] } | undefined)?.loc
      const field = Array.isArray(location) ? String(location[location.length - 1]) : undefined
      const message = field ? (FIELD_ERRORS as Record<string, string | undefined>)[field] : undefined
      if (field && message) return { field, message }
    }
    if (typeof detail === 'object' && detail !== null && 'code' in detail) {
      const refusal = detail as { code: string; field?: string; reason?: string }
      if (refusal.code === 'invalid' && refusal.field) {
        if (refusal.reason === 'required_with_base_url') return { field: refusal.field, message: KEY_REQUIRED_WITH_BASE_URL }
        const message = (FIELD_ERRORS as Record<string, string>)[refusal.field] ?? 'Valeur refusée par le serveur.'
        return { field: refusal.field, message }
      }
      if (refusal.code === 'settings_storage_unavailable') {
        return {
          message: 'Le fichier des réglages ne peut pas être écrit sur le serveur (droits, disque) : rien n’a été enregistré ni appliqué.',
        }
      }
      if (refusal.code === 'conflict') {
        return {
          message: 'Les réglages ont été modifiés entre-temps (autre onglet ou autre personne) : ils ont été relus, vérifiez-les puis enregistrez à nouveau.',
          reload: true,
        }
      }
      if (refusal.code === 'human_actor_required') return { message: 'Seule une personne connectée peut modifier ces réglages.' }
    }
    return { message: `Le serveur VIPER a refusé l’enregistrement (HTTP ${String(error.status)}).` }
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return { message: `Pas de réponse du serveur après ${String(SAVE_DEADLINE_MS / 1000)} s : rechargez la page pour voir ce qui a été enregistré.` }
  }
  return { message: 'Le serveur VIPER est injoignable : rien n’a été enregistré.' }
}

const CHECK_FAILURES: Record<string, string> = {
  ai_not_configured: 'enregistrez d’abord une clé et un modèle',
  ai_auth_failed: 'la clé a été refusée par OpenAI',
  ai_model_not_found: 'la clé est acceptée, mais ce modèle est inconnu ou inaccessible avec elle',
  ai_rate_limited: 'limite de requêtes atteinte ou quota OpenAI épuisé',
  ai_timeout: 'le service d’IA n’a pas répondu à temps',
  ai_upstream_error: 'le service d’IA a échoué ou est injoignable (vérifiez l’adresse de l’API)',
  ai_invalid_output: 'la réponse du service d’IA est illisible (vérifiez l’adresse de l’API)',
}

// The outcome of « Tester la clé », in one sentence.
export function checkText(check: KeyCheck): string {
  const seconds = (check.elapsed_ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })
  if (check.ok) return `Clé acceptée : le modèle « ${check.model ?? ''} » est disponible (réponse en ${seconds} s).`
  const reason = (check.code && CHECK_FAILURES[check.code]) ?? `erreur inattendue (${check.code ?? 'inconnue'})`
  return `Test échoué : ${reason}.`
}

export function checkFailure(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `Test interrompu : pas de réponse après ${String(KEY_CHECK_DEADLINE_MS / 1000)} s.`
  }
  if (error instanceof ApiError) return `Test impossible : le serveur VIPER a répondu ${String(error.status)}.`
  return 'Test impossible : le serveur VIPER est injoignable.'
}
