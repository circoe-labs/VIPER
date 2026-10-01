import { ApiError } from '../api/client'
import { TOOLBOX_DEADLINE_MS, type ToolboxState, type ToolboxStatus } from '../api/toolbox'
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

// The scheduled sending (S7) in one badge and one sentence. `intervalMs`: the frequency chosen on this page (0 = off).
export function dispatchBadge(status: ToolboxStatus, intervalMs: number): { tone: StatusTone; label: string } {
  if (status.dispatch.active) return { tone: 'success', label: 'Actif' }
  if (intervalMs > 0) return { tone: 'warning', label: 'En attente' }
  return { tone: 'neutral', label: 'Désactivé' }
}

export function dispatchSentence(status: ToolboxStatus, intervalMs: number): string {
  const { dispatch } = status
  if (dispatch.active) {
    return `Les messages programmés partent automatiquement à l’heure choisie (vérification toutes les ${String(dispatch.interval_seconds)} s), tant que le serveur VIPER est en marche.`
  }
  if (intervalMs > 0) {
    return 'L’envoi programmé démarrera dès que CIRCOE Toolbox sera connectée : aucun message programmé ne part pour l’instant.'
  }
  return 'L’envoi programmé est désactivé : les dates d’envoi sont enregistrées, aucun mail ne part. Choisissez une fréquence pour l’activer, de préférence après un premier envoi vérifié.'
}

export const LIMITATIONS = [
  'Expéditeur : la boîte Infomaniak par défaut du compte connecté. Le champ « De » de VIPER n’est pas transmis à la Toolbox.',
  'La connexion dure 30 jours, sans renouvellement automatique : il faut la refaire à l’échéance.',
  'Une seule connexion pour tout VIPER, celle de la personne qui l’a établie.',
  '« Se déconnecter » efface l’accès dans VIPER seulement : la Toolbox ne propose pas de révocation, l’accès expire de lui-même.',
]
