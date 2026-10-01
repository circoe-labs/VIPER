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

type Kind = 'text' | 'seconds' | 'integer' | 'interval'

const KINDS: Record<Exclude<IntegrationField, 'toolbox_mail_enabled'>, Kind> = {
  openai_model: 'text',
  openai_base_url: 'text',
  openai_timeout_ms: 'seconds',
  openai_max_retries: 'integer',
  contact_booking_url: 'text',
  default_outbound_email: 'text',
  toolbox_mcp_url: 'text',
  toolbox_oauth_redirect_uri: 'text',
  contact_dispatch_interval_ms: 'interval',
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
  if (kind === 'text') return text
  const number = Number(text.replace(',', '.'))
  if (text === '' || !Number.isFinite(number)) return new Error(FIELD_ERRORS[field])
  if (kind === 'seconds') return Math.round(number * 1000)
  if (!Number.isInteger(number)) return new Error(FIELD_ERRORS[field])
  return number
}

export const FIELD_ERRORS: Record<FormField | 'openai_api_key', string> = {
  openai_api_key: 'Saisissez une clé d’API OpenAI (elle commence en général par « sk- »).',
  openai_model: 'Indiquez le modèle OpenAI à utiliser : il est obligatoire dès qu’une clé est enregistrée.',
  openai_base_url: 'Adresse http(s) complète attendue, par exemple https://api.openai.com/v1.',
  openai_timeout_ms: 'Indiquez un délai entre 1 et 300 secondes.',
  openai_max_retries: 'Indiquez un nombre entier de 0 à 5.',
  contact_booking_url: 'Adresse http(s) complète attendue, ou laissez vide pour ne proposer aucun lien.',
  default_outbound_email: 'Adresse e-mail invalide.',
  toolbox_mcp_url: 'Adresse https attendue (http seulement sur localhost).',
  toolbox_oauth_redirect_uri:
    'Adresse https attendue (http seulement sur localhost) : ouvrez VIPER en https ou sur localhost pour vous connecter.',
  contact_dispatch_interval_ms: 'Choisissez une des fréquences proposées.',
  infomaniak_send_allowlist: 'Adresses e-mail ou règles « @domaine » séparées par des virgules.',
}

export const INTERVAL_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: 'Désactivé' },
  { value: 10_000, label: 'Toutes les 10 secondes' },
  { value: 30_000, label: 'Toutes les 30 secondes' },
  { value: 60_000, label: 'Toutes les minutes' },
  { value: 300_000, label: 'Toutes les 5 minutes' },
]

// The options of the frequency select; a value set elsewhere (not in the list) is kept as an option of its own.
export function intervalOptions(current: number): { value: number; label: string }[] {
  if (INTERVAL_OPTIONS.some((option) => option.value === current)) return INTERVAL_OPTIONS
  return [...INTERVAL_OPTIONS, { value: current, label: `Toutes les ${(current / 1000).toLocaleString('fr-FR')} s` }]
}

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
  if (field === 'contact_dispatch_interval_ms' && typeof fallback === 'number') {
    return intervalOptions(fallback).find((option) => option.value === fallback)?.label ?? String(fallback)
  }
  if (field === 'openai_timeout_ms' && typeof fallback === 'number') return `${String(fallback / 1000)} s`
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
    if (typeof detail === 'object' && detail !== null && 'code' in detail) {
      const refusal = detail as { code: string; field?: string }
      if (refusal.code === 'invalid' && refusal.field) {
        const message = (FIELD_ERRORS as Record<string, string>)[refusal.field] ?? 'Valeur refusée par le serveur.'
        return { field: refusal.field, message }
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
