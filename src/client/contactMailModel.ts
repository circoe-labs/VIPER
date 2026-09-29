// Éditeur mail Contact/R1/R2 (Task 13, décisions 20-25, 29) : logique pure de l'onglet, du formulaire, des actions et des erreurs.
// - le formulaire local ne contient que les modifications non enregistrées ; la version enregistrée vient toujours du serveur ;
// - « Enregistrer » ne valide jamais ; « Valider » et « Programmer » exigent une version enregistrée (pas de modification en attente) ;
// - enregistrer un message validé/programmé le repasse en Brouillon (règle serveur, rappelée avant l'enregistrement) ;
// - aucune heure d'envoi par défaut : date et heure sont saisies explicitement, converties en ISO 8601 avec le fuseau local ;
// - aucune action de l'éditeur ne change l'état du prospect.
import {
  canReopenContactMessage, contactMessageStepLabels, contactMessageSteps, contactMessageStatusLabels, isContactMessageStatus, isProspectState,
  type ContactMessageStatus, type ContactMessageStep
} from '../shared/contactWorkflow';
import { stateOptionLabel } from './trackingDisplay';

// --- Contrat HTTP (Task 12, champs utilisés par l'éditeur) ---
export type ContactMessage = {
  id: string; step: ContactMessageStep; status: ContactMessageStatus;
  from_email: string | null; subject: string; body_text: string;
  to_recipients: string[]; cc_recipients: string[]; bcc_recipients: string[];
  revision: number; scheduled_at: string | null; validated_at: string | null;
  sent_at: string | null; cancelled_at: string | null; cancel_reason: string | null;
  dispatch_claim_id: string | null; updated_at: string;
  /** Diagnostic d'envoi (Task 16) ; absents des anciennes réponses. */
  remote_draft_id?: string | null; dispatch_attempts?: number; last_error_code?: string | null; last_error_at?: string | null;
};
/** État réel de l'envoi programmé côté serveur (dispatcher démarré et Toolbox connectée), jamais une constante du client. */
export type DispatchInfo = { active: boolean; maxLatenessMinutes: number };
export type ProspectMessagesResponse = {
  prospect: { id: string; state: string | null; do_not_contact: boolean; sequence_closed: boolean };
  defaults: { from_email: string | null; to: string[] };
  messages: { step: ContactMessageStep; message: ContactMessage | null }[];
  /** Absent (ancienne API) = envoi automatique considéré inactif. */
  dispatch?: DispatchInfo;
};
export type MessageMutationResult = { message: ContactMessage; created: boolean; changed: boolean; unvalidated: boolean; remoteDraftQueued: boolean };
export type MessageAction = 'validate' | 'schedule' | 'unschedule' | 'cancel' | 'reopen';

export const messagesUrl = (prospectId: string) => `/api/prospects/${encodeURIComponent(prospectId)}/messages`;
export const messageUrl = (prospectId: string, step: ContactMessageStep, action?: MessageAction) =>
  `${messagesUrl(prospectId)}/${step}${action ? `/${action}` : ''}`;
export const messageOf = (data: ProspectMessagesResponse | null, step: ContactMessageStep): ContactMessage | null =>
  data?.messages.find(m => m.step === step)?.message ?? null;

// --- Onglets ---
export type MailTab = { step: ContactMessageStep; label: string; status: ContactMessageStatus | null; badge: string; dirty: boolean };
/** Badge « Vide » tant que l'étape n'a jamais été créée ; libellés de statut du contrat partagé. */
export const messageStatusBadge = (status: ContactMessageStatus | null): string => status ? contactMessageStatusLabels[status] : 'Vide';
export function mailTabs(data: ProspectMessagesResponse | null, dirtySteps: readonly ContactMessageStep[] = []): MailTab[] {
  return contactMessageSteps.map(step => {
    const message = messageOf(data, step);
    const status = message && isContactMessageStatus(message.status) ? message.status : null;
    return { step, label: contactMessageStepLabels[step], status, badge: messageStatusBadge(status), dirty: dirtySteps.includes(step) };
  });
}
/** Navigation clavier du tablist (flèches, Début, Fin) ; `null` = touche non gérée. */
export function tabKeyTarget(key: string, current: ContactMessageStep): ContactMessageStep | null {
  const i = contactMessageSteps.indexOf(current);
  const n = contactMessageSteps.length;
  switch (key) {
    case 'ArrowRight': return contactMessageSteps[(i + 1) % n];
    case 'ArrowLeft': return contactMessageSteps[(i - 1 + n) % n];
    case 'Home': return contactMessageSteps[0];
    case 'End': return contactMessageSteps[n - 1];
    default: return null;
  }
}
/** Étape précédente, affichée en référence (lecture seule) dans R1/R2 ; aucune règle de séquence n'en découle. */
export const previousStep = (step: ContactMessageStep): ContactMessageStep | null => {
  const i = contactMessageSteps.indexOf(step);
  return i > 0 ? contactMessageSteps[i - 1] : null;
};

// --- Formulaire ---
export type MailForm = { from: string; to: string; cc: string; bcc: string; subject: string; body: string };
export type MailField = keyof MailForm;
export const recipientFields = ['to', 'cc', 'bcc'] as const satisfies readonly MailField[];
const joinRecipients = (values: readonly string[]) => values.join(', ');
/** Adresses saisies (séparées par virgule, point-virgule ou retour à la ligne), vides ignorées. */
export const parseRecipients = (value: string): string[] => value.split(/[,;\n]/).map(v => v.trim()).filter(Boolean);
/** Contrôle local simple (le serveur reste l'autorité) : sert à signaler le bon champ avant l'envoi. */
export const looksLikeEmail = (value: string) => /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/.test(value);

/** Version enregistrée affichée dans l'éditeur ; étape vide = From de la config et destinataire principal du prospect. */
export function formFromMessage(message: ContactMessage | null, defaults: ProspectMessagesResponse['defaults']): MailForm {
  if (!message) return { from: defaults.from_email ?? '', to: joinRecipients(defaults.to), cc: '', bcc: '', subject: '', body: '' };
  return {
    from: message.from_email ?? '', to: joinRecipients(message.to_recipients), cc: joinRecipients(message.cc_recipients),
    bcc: joinRecipients(message.bcc_recipients), subject: message.subject, body: message.body_text
  };
}
const normalizedForm = (form: MailForm) => ({
  from: form.from.trim(), to: parseRecipients(form.to), cc: parseRecipients(form.cc), bcc: parseRecipients(form.bcc), subject: form.subject, body: form.body
});
/** Modifications non enregistrées : comparaison sur les valeurs envoyées (espaces et séparateurs d'adresses ignorés). */
export const isFormDirty = (form: MailForm | undefined, saved: MailForm): boolean =>
  !!form && JSON.stringify(normalizedForm(form)) !== JSON.stringify(normalizedForm(saved));

/** Corps de `PUT .../messages/:step` : sans révision = création du brouillon ; avec = édition (verrou optimiste). */
export function formPayload(form: MailForm, expectedRevision: number | null) {
  const n = normalizedForm(form);
  return {
    ...(expectedRevision !== null ? { expected_revision: expectedRevision } : {}),
    from_email: n.from || null, subject: n.subject, body_text: n.body, to: n.to, cc: n.cc, bcc: n.bcc
  };
}
/** Erreurs de saisie détectables avant l'appel (adresses mal formées). */
export function formFieldErrors(form: MailForm): Partial<Record<MailField, string>> {
  const errors: Partial<Record<MailField, string>> = {};
  if (form.from.trim() && !looksLikeEmail(form.from.trim())) errors.from = 'Adresse d’expédition invalide.';
  for (const field of recipientFields) {
    const bad = parseRecipients(form[field]).filter(v => !looksLikeEmail(v));
    if (bad.length) errors[field] = `Adresse invalide : ${bad.join(', ')}.`;
  }
  return errors;
}

// --- Actions disponibles ---
export type MailContext = {
  message: ContactMessage | null;
  prospectState: string | null;
  doNotContact: boolean;
  sequenceClosed: boolean;
  dirty: boolean;
  busy: boolean;
};
export type MailActions = {
  /** Champs modifiables (sinon vue en lecture seule). */
  editable: boolean;
  canSave: boolean; saveLabel: string;
  canValidate: boolean; showValidate: boolean;
  canSchedule: boolean; showSchedule: boolean;
  canUnschedule: boolean; showUnschedule: boolean;
  canCancel: boolean; showCancel: boolean;
  canReopen: boolean; showReopen: boolean;
  /** Explications affichées (pourquoi une action est indisponible, ce qu'implique l'enregistrement). */
  notes: string[];
};

/** Explication d'une séquence fermée (état du prospect ou blocage). */
export function closedSequenceReason(state: string | null, doNotContact: boolean): string {
  if (doNotContact) return 'Prospect « À ne plus contacter » : aucun message ne peut être préparé, validé ni programmé.';
  const label = isProspectState(state) ? stateOptionLabel(state) : String(state ?? '');
  return `Séquence fermée par l’état « ${label} » : aucun message ne peut être préparé, validé ni programmé.`;
}

export function mailActions(ctx: MailContext): MailActions {
  const { message, dirty, busy, sequenceClosed } = ctx;
  const status = message?.status ?? null;
  const locked = !!message?.dispatch_claim_id;
  const notes: string[] = [];
  const none: MailActions = {
    editable: false, canSave: false, saveLabel: 'Enregistrer', canValidate: false, showValidate: false, canSchedule: false, showSchedule: false,
    canUnschedule: false, showUnschedule: false, canCancel: false, showCancel: false, canReopen: false, showReopen: false, notes
  };
  if (status === 'sent') return { ...none, notes: ['Message envoyé : il reste consultable mais ne peut plus être modifié.'] };
  if (locked) return { ...none, notes: ['Envoi en cours : le message est verrouillé le temps de l’envoi.'] };
  if (status === 'cancelled') {
    const canReopen = canReopenContactMessage('cancelled', ctx.prospectState, ctx.doNotContact);
    notes.push(canReopen
      ? 'Message annulé : il ne sera pas envoyé. « Rouvrir » le repasse en Brouillon (à revalider).'
      : `Message annulé. ${closedSequenceReason(ctx.prospectState, ctx.doNotContact)}`);
    return { ...none, showReopen: canReopen, canReopen: canReopen && !busy, notes };
  }
  if (sequenceClosed) {
    notes.push(closedSequenceReason(ctx.prospectState, ctx.doNotContact));
    // Retirer un envoi prévu reste possible : c'est toujours dans le sens de la séquence fermée.
    return {
      ...none,
      showUnschedule: status === 'scheduled', canUnschedule: status === 'scheduled' && !busy,
      showCancel: status !== null, canCancel: status !== null && !busy, notes
    };
  }
  const editable = true;
  const saveLabel = status === null ? 'Créer le brouillon' : 'Enregistrer';
  const canSave = !busy && (status === null || dirty);
  if (dirty && (status === 'validated' || status === 'scheduled')) {
    notes.push(status === 'scheduled'
      ? 'Ce message est programmé : l’enregistrer retire la programmation et le repasse en Brouillon. Il faudra le revalider puis le reprogrammer.'
      : 'Ce message est validé : l’enregistrer le repasse en Brouillon. Il faudra le revalider.');
  }
  if (dirty && status && status !== 'draft') notes.push('Enregistrez ou abandonnez les modifications avant de continuer.');
  if (dirty && status === 'draft') notes.push('Enregistrez les modifications avant de valider.');
  return {
    ...none, editable, canSave, saveLabel,
    showValidate: status === 'draft', canValidate: status === 'draft' && !dirty && !busy,
    showSchedule: status === 'validated', canSchedule: status === 'validated' && !dirty && !busy,
    showUnschedule: status === 'scheduled', canUnschedule: status === 'scheduled' && !dirty && !busy,
    showCancel: status !== null, canCancel: status !== null && !busy,
    notes
  };
}

// --- Présentation du statut ---
const dateTimeFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'full', timeStyle: 'short' });
export function displayDateTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTimeFormat.format(d);
}
/** Raison d'annulation lisible (`manual` ou `prospect_state:<état>`, Task 11/12). */
export function cancelReasonLabel(reason: string | null): string | null {
  if (!reason) return null;
  if (reason === 'manual') return 'annulé à la main';
  if (reason === 'do_not_contact') return 'annulé : prospect « À ne plus contacter »';
  const state = reason.startsWith('prospect_state:') ? reason.slice('prospect_state:'.length) : null;
  if (state && isProspectState(state)) return `annulé par le passage du prospect à « ${stateOptionLabel(state)} »`;
  return null;
}
/** Ligne d'état sous l'en-tête du message (sans jargon). */
export function messageStatusLine(message: ContactMessage | null, sequenceClosed = false): string {
  if (!message) return sequenceClosed ? 'Aucun message pour cette étape.' : 'Aucun message pour cette étape : le brouillon est créé au premier enregistrement.';
  switch (message.status) {
    case 'draft': return 'Brouillon : à relire puis valider. Il ne peut pas être envoyé tel quel.';
    case 'validated': return 'Validé : prêt à être programmé.';
    case 'scheduled': return `Programmé pour le ${displayDateTime(message.scheduled_at)}.`;
    case 'sent': return `Envoyé le ${displayDateTime(message.sent_at)}.`;
    case 'cancelled': {
      const reason = cancelReasonLabel(message.cancel_reason);
      return `Annulé le ${displayDateTime(message.cancelled_at)}${reason ? ` (${reason})` : ''}.`;
    }
  }
}

// --- Suivi de l'envoi programmé (Task 16), sans jargon ---
const sendErrorLabels: Record<string, string> = {
  toolbox_unavailable: 'la Toolbox était injoignable',
  toolbox_timeout: 'la Toolbox a mis trop de temps à répondre',
  toolbox_auth_required: 'la connexion à la Toolbox est à renouveler (Paramètres)',
  toolbox_not_configured: 'la Toolbox n’est pas configurée',
  toolbox_outbound_blocked: 'un destinataire n’est pas autorisé par la liste d’envoi de la Toolbox',
  toolbox_rejected: 'la Toolbox a refusé l’envoi',
  toolbox_invalid_input: 'la Toolbox a refusé le message (champ invalide)',
  toolbox_draft_not_found: 'le brouillon n’existe plus dans Infomaniak (supprimé ou envoyé depuis le webmail ?)',
  toolbox_invalid_response: 'la réponse de la Toolbox était illisible',
  dispatch_overdue: 'l’heure prévue était dépassée depuis trop longtemps (VIPER arrêté ou Toolbox déconnectée) : il n’est pas parti en retard',
  send_not_confirmed: 'l’envoi n’a pas pu être confirmé et le brouillon est toujours dans Infomaniak : vérifiez les éléments envoyés avant de reprogrammer',
  missing_recipients: 'aucun destinataire'
};
export const sendErrorLabel = (code: string | null | undefined): string => (code && sendErrorLabels[code]) || 'erreur inattendue';
/**
 * Lignes d'état d'envoi affichées sous le statut : envoi en cours ou incertain, nouvel essai prévu, échec à reprogrammer,
 * envoi confirmé par vérification, brouillon Infomaniak prêt ou non, envoi automatique inactif.
 */
export function dispatchStatusLines(message: ContactMessage | null, dispatch: DispatchInfo | undefined): string[] {
  if (!message) return [];
  const code = message.last_error_code ?? null;
  const active = !!dispatch?.active;
  const draftLine = message.remote_draft_id ? 'Brouillon prêt dans Infomaniak.'
    : active ? 'Brouillon Infomaniak pas encore créé : il le sera avant l’envoi.' : null;
  switch (message.status) {
    case 'sent':
      return code === 'send_reconciled_draft_absent'
        ? ['Envoi déduit après vérification : la Toolbox n’a pas confirmé, mais le brouillon a quitté Infomaniak. Contrôlez au besoin les éléments envoyés.']
        : [];
    case 'scheduled': {
      if (message.dispatch_claim_id) return [code === 'send_outcome_unknown'
        ? 'Envoi non confirmé : VIPER vérifie auprès d’Infomaniak s’il est parti. Il ne sera jamais renvoyé automatiquement.'
        : 'Envoi en cours.'];
      const lines: string[] = [];
      if (!active) lines.push('Envoi automatique inactif : la Toolbox n’est pas connectée (Paramètres). Rien ne partira tant qu’elle ne l’est pas.');
      if (code) lines.push(`Dernière tentative d’envoi échouée : ${sendErrorLabel(code)}. Nouvel essai automatique.`);
      if (draftLine) lines.push(draftLine);
      return lines;
    }
    case 'validated': {
      const lines: string[] = [];
      if (code) lines.push(`Envoi non effectué : ${sendErrorLabel(code)}. Le message reste validé : reprogrammez-le pour réessayer.`);
      if (message.remote_draft_id) lines.push('Brouillon prêt dans Infomaniak.');
      return lines;
    }
    default: return [];
  }
}

// --- Programmation : date + heure locales explicites -> ISO 8601 avec fuseau ---
const pad = (n: number) => String(Math.abs(n)).padStart(2, '0');
/** Décalage UTC au format ISO (`+02:00`, `-05:30`) à partir de minutes à l'est de UTC. */
export const formatUtcOffset = (minutesEast: number): string => `${minutesEast < 0 ? '-' : '+'}${pad(Math.trunc(minutesEast / 60))}:${pad(minutesEast % 60)}`;
/** Fuseau du navigateur, affiché à côté du sélecteur (ex. « Europe/Paris, UTC+02:00 »). */
export function localTimeZoneLabel(at: Date = new Date()): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = `UTC${formatUtcOffset(-at.getTimezoneOffset())}`;
  return zone ? `${zone}, ${offset}` : offset;
}
/** Valeur `YYYY-MM-DD` du jour local (borne minimale du sélecteur de date). */
export const localDateValue = (at: Date): string => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;

export type ScheduleInput = { date: string; time: string };
export type ScheduleParse = { ok: true; iso: string; at: Date } | { ok: false; error: string };
/**
 * Convertit la date et l'heure saisies (heure locale du navigateur) en ISO 8601 avec décalage explicite. Aucune valeur par
 * défaut : date et heure manquantes sont refusées. Une heure inexistante (passage à l'heure d'été) est refusée.
 */
export function scheduleToIso({ date, time }: ScheduleInput, now: Date): ScheduleParse {
  if (!date && !time) return { ok: false, error: 'Choisissez la date et l’heure d’envoi.' };
  if (!date) return { ok: false, error: 'Choisissez la date d’envoi.' };
  if (!time) return { ok: false, error: 'Choisissez l’heure d’envoi (aucune heure n’est proposée par défaut).' };
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(time);
  if (!d || !t) return { ok: false, error: 'Date ou heure illisible.' };
  const [year, month, day, hour, minute] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  const at = new Date(year, month - 1, day, hour, minute, 0, 0);
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== day || at.getHours() !== hour || at.getMinutes() !== minute) {
    return { ok: false, error: 'Cette heure n’existe pas dans le fuseau local (changement d’heure) : choisissez-en une autre.' };
  }
  if (at.getTime() <= now.getTime()) return { ok: false, error: 'La date et l’heure d’envoi doivent être dans le futur.' };
  const iso = `${d[1]}-${d[2]}-${d[3]}T${t[1]}:${t[2]}:00${formatUtcOffset(-at.getTimezoneOffset())}`;
  return { ok: true, iso, at };
}

// --- Confirmations ---
const formatLateness = (minutes: number) => minutes >= 120 && minutes % 60 === 0 ? `${minutes / 60} heures` : `${minutes} minutes`;
export type MailConfirmation = { title: string; lines: string[]; confirmLabel: string };
/** `dispatch` = état réel du serveur (`GET .../messages`) : la confirmation ne promet un envoi que s'il aura lieu. */
export function actionConfirmation(action: 'validate' | 'schedule' | 'cancel', step: ContactMessageStep, schedule?: { at: Date; zone: string }, dispatch?: DispatchInfo): MailConfirmation {
  const label = contactMessageStepLabels[step];
  if (action === 'validate') return {
    title: `Valider le message ${label} ?`,
    lines: ['Vous confirmez avoir relu l’objet, le corps et les destinataires. Rien n’est envoyé maintenant : le message pourra ensuite être programmé.',
      'Toute modification ultérieure le repassera en Brouillon et demandera une nouvelle validation.'],
    confirmLabel: 'Confirmer la validation'
  };
  if (action === 'schedule') return {
    title: `Programmer le message ${label} ?`,
    lines: [
      `Envoi prévu le ${schedule ? dateTimeFormat.format(schedule.at) : '—'} (${schedule?.zone ?? 'heure locale'}).`,
      ...(dispatch?.active ? [
        'Le message partira automatiquement à cette date, depuis la boîte Infomaniak connectée à la Toolbox (VIPER doit être en marche).',
        `S’il ne peut pas partir dans les ${formatLateness(dispatch.maxLatenessMinutes)} qui suivent, il ne part pas et revient à « Validé ».`
      ] : ['L’envoi automatique est inactif (Toolbox non connectée) : la date est enregistrée, mais aucun mail ne partira tant que la Toolbox n’est pas connectée.']),
      'Vous pourrez déprogrammer tant que le message n’est pas envoyé.'
    ],
    confirmLabel: 'Confirmer la programmation'
  };
  return {
    title: `Annuler le message ${label} ?`,
    lines: ['Il ne sera pas envoyé. Il restera consultable et pourra être rouvert tant que la séquence du prospect reste ouverte.'],
    confirmLabel: 'Confirmer l’annulation'
  };
}
/** Annonce après une action réussie (`aria-live`). */
export function actionNotice(kind: 'save' | MessageAction, step: ContactMessageStep, result: MessageMutationResult): string {
  const label = contactMessageStepLabels[step];
  switch (kind) {
    case 'save':
      if (result.created) return `Brouillon ${label} créé.`;
      if (!result.changed) return 'Aucune modification à enregistrer.';
      return result.unvalidated ? `Message ${label} enregistré et repassé en Brouillon : à revalider.` : `Message ${label} enregistré.`;
    case 'validate': return `Message ${label} validé.`;
    case 'schedule': return `Message ${label} programmé pour le ${displayDateTime(result.message.scheduled_at)}.`;
    case 'unschedule': return `Programmation du message ${label} retirée : il reste validé.`;
    case 'cancel': return `Message ${label} annulé.`;
    case 'reopen': return `Message ${label} rouvert en Brouillon : à revalider.`;
  }
}

// --- Erreurs API (codes Task 12) ---
export type MailErrorView = {
  message: string;
  fields: Partial<Record<MailField | 'schedule', string>>;
  /** Recharger la version enregistrée (état serveur différent de l'affichage). */
  reload: boolean;
  /** Conflit de révision : les modifications locales sont mises de côté, jamais écrasées ni renvoyées en silence. */
  conflict: boolean;
};
const incompleteFields: Record<string, { field: MailField; text: string }> = {
  subject: { field: 'subject', text: 'Objet requis.' },
  body_text: { field: 'body', text: 'Corps du message requis.' },
  to: { field: 'to', text: 'Au moins un destinataire valide.' },
  from_email: { field: 'from', text: 'Adresse d’expédition valide requise.' }
};
export function mailErrorView(error: { message?: string; code?: string; fields?: string[] }, form?: MailForm): MailErrorView {
  const view = (message: string, extra: Partial<MailErrorView> = {}): MailErrorView => ({ message, fields: {}, reload: false, conflict: false, ...extra });
  switch (error.code) {
    case 'revision_conflict':
    case 'message_exists':
      return view('Ce message a été modifié entre-temps (autre fenêtre ou changement d’état du prospect). La version enregistrée a été rechargée.', { reload: true, conflict: true });
    case 'message_incomplete': {
      const fields: MailErrorView['fields'] = {};
      for (const name of error.fields ?? []) { const f = incompleteFields[name]; if (f) fields[f.field] = f.text; }
      return view('Message incomplet : complétez les champs signalés, enregistrez, puis validez.', { fields });
    }
    case 'invalid_recipient': {
      const local = form ? formFieldErrors(form) : {};
      const field = recipientFields.find(f => local[f]) ?? 'to';
      return view('Une adresse destinataire est invalide.', { fields: { [field]: local[field] ?? 'Adresse invalide.' } });
    }
    case 'invalid_from_email': return view('L’adresse d’expédition est invalide.', { fields: { from: 'Adresse d’expédition invalide.' } });
    case 'invalid_scheduled_at': return view('Date/heure d’envoi invalide.', { fields: { schedule: 'Date/heure d’envoi invalide.' } });
    case 'scheduled_at_not_future': return view('La date et l’heure d’envoi doivent être dans le futur.', { fields: { schedule: 'Choisissez un moment futur.' } });
    case 'prospect_sequence_closed':
    case 'prospect_do_not_contact':
      return view('La séquence de ce prospect est fermée : action impossible. L’affichage a été actualisé.', { reload: true });
    case 'message_sent_immutable': return view('Ce message a déjà été envoyé : il ne peut plus être modifié.', { reload: true });
    case 'message_cancelled': return view('Ce message est annulé : rouvrez-le avant de le modifier.', { reload: true });
    case 'dispatch_in_progress': return view('Envoi en cours : le message est verrouillé.', { reload: true });
    case 'invalid_transition': return view('Action impossible dans l’état actuel du message. L’affichage a été actualisé.', { reload: true });
    case 'message_not_found': return view('Message introuvable. L’affichage a été actualisé.', { reload: true });
    default: return view(error.message || 'Action impossible.');
  }
}
