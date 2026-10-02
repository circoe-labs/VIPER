import { ApiError } from '../api/client'
import type { Integrations } from '../api/integrations'
import { TOOLBOX_DEADLINE_MS, type ToolboxState, type ToolboxStatus } from '../api/toolbox'
import { reasonCopy } from '../contact/dispatchCopy'
import { FIELD_ERRORS } from './integrationsModel'
import type { StatusTone } from '../ui/Badge'

// French copy of the CIRCOE Toolbox connection (Contact port S6): the `toolbox_*` codes of
// backend/app/services/toolbox/errors.py, shared by Paramètres › Connexions and the Contact mail editor.

const ERROR_LABELS: Record<string, string> = {
  toolbox_not_configured: 'la Toolbox n’est pas connectée (Paramètres › Connexions)',
  toolbox_not_connected: 'la Toolbox n’est pas connectée',
  toolbox_auth_expired: 'la connexion à la Toolbox a expiré ou a été refusée : reconnectez-la',
  toolbox_unavailable: 'la Toolbox ne répond pas',
  toolbox_timeout: 'la Toolbox n’a pas répondu à temps',
  toolbox_invalid_response: 'la réponse de la Toolbox est illisible',
  toolbox_rejected: 'la Toolbox a refusé l’opération',
  toolbox_outbound_blocked: 'un destinataire n’est pas autorisé par la liste d’envoi de la Toolbox',
  toolbox_invalid_input: 'le message dépasse les limites de la Toolbox (objet de 500 caractères au plus, adresses valides)',
  toolbox_draft_not_found: 'brouillon introuvable dans Infomaniak',
  toolbox_connection_interrupted: 'connexion interrompue par un changement de réglage de la Toolbox : recommencez',
  toolbox_state_invalid: 'tentative de connexion inconnue, expirée ou commencée par une autre personne : recommencez',
  toolbox_access_denied: 'connexion refusée dans la Toolbox ou chez Infomaniak',
  toolbox_authorization_failed: 'la Toolbox n’a pas accordé la connexion',
  toolbox_issuer_mismatch: 'la réponse ne vient pas de la Toolbox attendue',
  toolbox_token_exchange_failed: 'la Toolbox n’a pas délivré d’accès',
  toolbox_scope_missing: 'la Toolbox n’a pas accordé l’accès au mail',
  toolbox_outcome_unknown: 'création non confirmée par la Toolbox (« Réessayer » cherche d’abord le brouillon dans Infomaniak)',
}

export function toolboxErrorLabel(code: string): string {
  return ERROR_LABELS[code] ?? `erreur inattendue (${code})`
}

// The refusal code of a failed Toolbox call, or a transport description.
export function toolboxFailure(error: unknown): string {
  if (error instanceof ApiError) {
    const { detail } = error
    if (typeof detail === 'object' && detail !== null && 'code' in detail && typeof detail.code === 'string') {
      // A refused setting while connecting (S8 QA M3), e.g. the page opened over http on the LAN: the field's rule.
      const field = 'field' in detail && typeof detail.field === 'string' ? detail.field : null
      const rule = field ? (FIELD_ERRORS as Record<string, string>)[field] : undefined
      if (detail.code === 'invalid' && rule) return `${rule.charAt(0).toLowerCase()}${rule.slice(1).replace(/\.$/, '')}`
      return toolboxErrorLabel(detail.code)
    }
    return `le serveur VIPER a répondu ${String(error.status)}`
  }
  // `leaveFor` refused the address the server answered (not an http(s) URL).
  if (error instanceof Error && error.message.startsWith('Adresse de redirection')) {
    return `${error.message.charAt(0).toLowerCase()}${error.message.slice(1).replace(/\.$/, '')}`
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return `aucune réponse après ${String(TOOLBOX_DEADLINE_MS / 1000)} s`
  }
  return 'le serveur VIPER est injoignable'
}

export const STATE_BADGES: Record<ToolboxState, { tone: StatusTone; label: string }> = {
  disabled: { tone: 'neutral', label: 'Désactivée' },
  not_configured: { tone: 'warning', label: 'Non configurée' },
  disconnected: { tone: 'neutral', label: 'Non connectée' },
  connected: { tone: 'success', label: 'Connectée' },
  expired: { tone: 'warning', label: 'À reconnecter' },
}

// The missing setting, named as the page names it (never an environment variable).
const MISSING_LABELS: Record<string, string> = {
  VIPER_TOOLBOX_MCP_URL: 'l’adresse du serveur CIRCOE Toolbox',
  VIPER_TOOLBOX_OAUTH_REDIRECT_URI: 'l’adresse de retour',
}

// What the state means for the Contact messages, in one sentence.
export function stateSentence(status: ToolboxStatus): string {
  switch (status.state) {
    case 'disabled':
      return 'Connectez VIPER à CIRCOE Toolbox pour que chaque message validé crée un brouillon dans votre boîte Infomaniak. Sans connexion, les messages restent dans VIPER.'
    case 'not_configured': {
      const missing = status.missing.map((name) => MISSING_LABELS[name] ?? name).join(' et ')
      return `Il manque ${missing || 'un réglage'} (Paramètres avancés ci-dessous) : rien n’est créé dans Infomaniak.`
    }
    case 'disconnected':
      return 'Connectez la Toolbox pour que chaque message validé crée un brouillon dans la boîte Infomaniak liée. Sans connexion, les messages restent dans VIPER.'
    case 'connected':
      return 'Chaque message validé crée un brouillon dans la boîte Infomaniak liée ; une modification ou une annulation le supprime.'
    case 'expired':
      return 'La connexion a expiré ou a été refusée par la Toolbox : reconnectez-la. En attendant, aucun brouillon n’est créé dans Infomaniak.'
  }
}

// The scheduled sending (S7, switch since S9) in one badge and one sentence, from the integration settings.
export function dispatchOn(data: Integrations): boolean {
  return data.fields.contact_dispatch_enabled.value === true && Number(data.fields.contact_dispatch_interval_ms.value ?? 0) > 0
}

export function dispatchBadge(data: Integrations): { tone: StatusTone; label: string } {
  if (data.dispatch.active) return { tone: 'success', label: 'Actif' }
  if (dispatchOn(data)) return { tone: 'warning', label: 'En attente' }
  return { tone: 'neutral', label: 'Désactivé' }
}

export function dispatchSentence(data: Integrations): string {
  if (data.dispatch.active) {
    return 'Actif : chaque mail programmé part à l’heure choisie, tant que le serveur VIPER est en marche.'
  }
  if (dispatchOn(data)) {
    return `En attente : ${reasonCopy(data.dispatch.reason).why}. Aucun mail programmé ne part pour l’instant ; l’envoi démarre dès que c’est réglé.`
  }
  return 'Désactivé : les dates d’envoi sont enregistrées, mais aucun mail programmé ne part.'
}

// S9: the scheduled messages waiting while the sending is inactive (null when there are none, or when it is active).
export function dispatchBacklog(data: Integrations): string | null {
  const { active, scheduled_count: count, overdue_count: overdue } = data.dispatch
  if (active || count === 0) return null
  const head = count > 1 ? `${String(count)} messages programmés ne partiront pas` : '1 message programmé ne partira pas'
  const late = overdue > 0 ? ` (${overdue > 1 ? `${String(overdue)} ont déjà dépassé leur heure` : '1 a déjà dépassé son heure'})` : ''
  return `${head}${late} tant que l’envoi automatique est inactif.`
}

export const LIMITATIONS = [
  'Expéditeur : la boîte Infomaniak par défaut du compte connecté. Le champ « De » de VIPER n’est pas transmis à la Toolbox.',
  'La connexion dure 30 jours, sans renouvellement automatique : il faut la refaire à l’échéance.',
  'Une seule connexion pour tout VIPER, celle de la personne qui l’a établie.',
  '« Se déconnecter » efface l’accès dans VIPER seulement : la Toolbox ne propose pas de révocation, l’accès expire de lui-même.',
]
