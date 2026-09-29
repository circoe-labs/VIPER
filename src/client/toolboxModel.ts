// Modèle pur du panneau « CIRCOE Toolbox » des Paramètres (Task 15) : libellés d'état, explication, action possible, lecture du
// retour OAuth (`/?toolbox=connected|error&code=`). Aucun secret ne transite par le client : seulement états et codes.

export type ToolboxUiState = 'disabled' | 'not_configured' | 'disconnected' | 'connected' | 'expired';
export type ToolboxStatusView = {
  enabled: boolean;
  state: ToolboxUiState;
  missing: string[];
  toolboxOrigin: string | null;
  connection: { connectedAt: string | null; connectedBy: string | null; expiresAt: string | null; refreshable: boolean; scope: string | null } | null;
  cleanups: { pending: number; failing: number };
};

export type ToolboxPanelModel = {
  label: string;
  tone: 'off' | 'warn' | 'ok';
  explanation: string;
  /** Bouton principal : connecter (ou reconnecter) ; absent si désactivée/non configurée. */
  connectLabel: string | null;
  canDisconnect: boolean;
};

export function toolboxPanelModel(status: ToolboxStatusView): ToolboxPanelModel {
  switch (status.state) {
    case 'disabled':
      return { label: 'Désactivée', tone: 'off', canDisconnect: false, connectLabel: null,
        explanation: 'Les messages validés restent uniquement dans VIPER. Activation côté serveur : TOOLBOX_MAIL_ENABLED=true.' };
    case 'not_configured':
      return { label: 'Non configurée', tone: 'warn', canDisconnect: false, connectLabel: null,
        explanation: `Configuration serveur incomplète : ${status.missing.join(', ') || 'variables Toolbox'}.` };
    case 'disconnected':
      return { label: 'À connecter', tone: 'warn', canDisconnect: false, connectLabel: 'Connecter la Toolbox',
        explanation: 'Vous serez redirigé vers la Toolbox : connexion Infomaniak puis token API personnel (Mail). Sans connexion, aucun brouillon Infomaniak n’est créé.' };
    case 'expired':
      return { label: 'À reconnecter', tone: 'warn', canDisconnect: true, connectLabel: 'Reconnecter la Toolbox',
        explanation: 'La connexion a expiré ou a été refusée par la Toolbox. Les brouillons ne sont plus créés ni supprimés tant qu’elle n’est pas rétablie.' };
    case 'connected':
      return { label: 'Connectée', tone: 'ok', canDisconnect: true, connectLabel: null,
        explanation: 'À chaque validation, un brouillon est créé dans la boîte Infomaniak liée au token (c’est elle l’expéditeur réel). Aucun envoi automatique pour l’instant.' };
  }
}

const callbackMessages: Record<string, string> = {
  toolbox_state_invalid: 'Demande de connexion expirée ou inconnue : relancez « Connecter la Toolbox ».',
  toolbox_access_denied: 'Connexion refusée sur la Toolbox.',
  toolbox_issuer_mismatch: 'Réponse d’un serveur d’autorisation inattendu : connexion refusée.',
  toolbox_token_exchange_failed: 'La Toolbox a refusé l’échange du code : relancez la connexion.',
  toolbox_scope_missing: 'La Toolbox n’a pas accordé l’accès Mail.',
  toolbox_not_configured: 'Intégration Toolbox non configurée côté serveur.'
};
/** Lit le résultat du retour OAuth dans l'URL (`?toolbox=`) ; `null` si absent. */
export function readToolboxCallback(search: string): { ok: boolean; message: string } | null {
  const params = new URLSearchParams(search);
  const result = params.get('toolbox');
  if (result === 'connected') return { ok: true, message: 'Toolbox connectée.' };
  if (result !== 'error') return null;
  const code = params.get('code') ?? '';
  return { ok: false, message: callbackMessages[code] ?? `Connexion à la Toolbox impossible (${code || 'erreur inconnue'}).` };
}
/** URL sans les paramètres du retour OAuth (à remplacer dans l'historique pour qu'un rechargement ne réaffiche pas le message). */
export function withoutToolboxCallback(href: string): string {
  const url = new URL(href);
  url.searchParams.delete('toolbox');
  url.searchParams.delete('code');
  return `${url.pathname}${url.search}${url.hash}`;
}
