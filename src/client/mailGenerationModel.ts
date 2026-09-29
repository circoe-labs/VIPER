// Génération IA dans l'éditeur mail (Task 14) : logique pure du bouton « Générer » / « Régénérer », de la consigne, de la
// confirmation de remplacement et des erreurs. Le serveur reste l'autorité (clé, modèle, prompt, règles de statut) : le
// résultat est toujours un Brouillon à relire et valider ; aucun état prospect ne change.
import { contactMessageStepLabels, type ContactMessageStep } from '../shared/contactWorkflow';
import { mailErrorView, messagesUrl, type ContactMessage, type MailConfirmation, type MessageMutationResult } from './contactMailModel';

export const MAX_GENERATION_INSTRUCTIONS = 1000;
export type GenerationResult = MessageMutationResult & { generation: { model: string; prompt_version: string } };
export const generateUrl = (prospectId: string, step: ContactMessageStep) => `${messagesUrl(prospectId)}/${step}/generate`;

const hasContent = (message: ContactMessage | null) => !!message && !!(message.subject.trim() || message.body_text.trim());

export type GenerationAvailability = { show: boolean; enabled: boolean; label: string; note: string | null };
/** Visible seulement si l'étape est modifiable ; un message programmé doit d'abord être déprogrammé. */
export function generationAvailability(input: { message: ContactMessage | null; editable: boolean; busy: boolean }): GenerationAvailability {
  const label = hasContent(input.message) ? 'Régénérer' : 'Générer';
  if (!input.editable) return { show: false, enabled: false, label, note: null };
  if (input.message?.status === 'scheduled') return { show: true, enabled: false, label, note: 'Message programmé : déprogrammez-le avant de le régénérer.' };
  return { show: true, enabled: !input.busy, label, note: null };
}

/** Corps de `POST .../generate` : révision attendue dès que l'étape existe, consigne facultative. */
export function generationPayload(message: ContactMessage | null, instructions: string) {
  const text = instructions.trim().slice(0, MAX_GENERATION_INSTRUCTIONS);
  return { ...(message ? { expected_revision: message.revision } : {}), ...(text ? { instructions: text } : {}) };
}

/** Confirmation avant de remplacer un contenu enregistré ou des modifications locales ; `null` = rien à perdre. */
export function generationConfirmation(step: ContactMessageStep, message: ContactMessage | null, dirty: boolean): MailConfirmation | null {
  const lines: string[] = [];
  if (hasContent(message)) lines.push('L’objet et le corps enregistrés seront remplacés par une nouvelle version rédigée par l’IA.');
  if (dirty) lines.push('Vos modifications non enregistrées de cet onglet (destinataires compris) seront perdues.');
  if (message?.status === 'validated') lines.push('Ce message est validé : il repassera en Brouillon et devra être revalidé.');
  if (!lines.length) return null;
  lines.push('Le résultat reste un Brouillon : rien n’est validé ni envoyé.');
  return { title: `Régénérer le message ${contactMessageStepLabels[step]} ?`, lines, confirmLabel: 'Remplacer par une version IA' };
}

export function generationNotice(step: ContactMessageStep, result: GenerationResult): string {
  const label = contactMessageStepLabels[step];
  return `Brouillon ${label} rédigé par l’IA (${result.generation.model}) : relisez-le et corrigez-le avant de le valider.${result.unvalidated ? ' Il était validé : il est repassé en Brouillon.' : ''}`;
}

export type GenerationErrorView = { message: string; reload: boolean };
export function generationErrorView(error: { message?: string; code?: string; fields?: string[] }): GenerationErrorView {
  switch (error.code) {
    case 'ai_not_configured': return { message: 'Génération IA indisponible : la clé API ou le modèle OpenAI n’est pas configuré sur le serveur. Rien n’a été modifié.', reload: false };
    case 'ai_timeout': return { message: 'L’IA n’a pas répondu à temps. Rien n’a été modifié : réessayez.', reload: false };
    case 'ai_rate_limited': return { message: error.message || 'Limite OpenAI atteinte : réessayez dans un moment. Rien n’a été modifié.', reload: false };
    case 'ai_auth_failed': return { message: 'La clé API OpenAI est refusée : vérifiez la configuration du serveur. Rien n’a été modifié.', reload: false };
    case 'ai_refused': return { message: 'L’IA a refusé de rédiger ce message. Rien n’a été modifié : reformulez la consigne ou rédigez à la main.', reload: false };
    case 'ai_invalid_output': return { message: 'La réponse de l’IA était inutilisable. Rien n’a été modifié : réessayez.', reload: false };
    case 'ai_upstream_error': return { message: 'Le service IA est en erreur ou injoignable. Rien n’a été modifié : réessayez plus tard.', reload: false };
    case 'invalid_transition': return { message: 'Message programmé : déprogrammez-le avant de le régénérer.', reload: true };
    default: {
      const view = mailErrorView(error);
      return { message: view.message, reload: view.reload };
    }
  }
}
