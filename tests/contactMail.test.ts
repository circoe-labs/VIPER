import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  actionConfirmation, actionNotice, cancelReasonLabel, formFieldErrors, formFromMessage, formPayload, formatUtcOffset, isFormDirty,
  mailActions, mailErrorView, mailTabs, messageStatusLine, parseRecipients, previousStep, scheduleToIso, tabKeyTarget,
  type ContactMessage, type MailContext, type MailForm, type ProspectMessagesResponse
} from '../src/client/contactMailModel';
import { MailEditor } from '../src/client/ContactMailPanel';
import type { ContactMessageStatus, ContactMessageStep } from '../src/shared/contactWorkflow';

const msg = (over: Partial<ContactMessage> = {}): ContactMessage => ({
  id: 'm1', step: 'contact', status: 'draft', from_email: 'hello@viper.test', subject: 'Bonjour', body_text: 'Corps',
  to_recipients: ['alice@acme.test'], cc_recipients: [], bcc_recipients: [], revision: 1, scheduled_at: null, validated_at: null,
  sent_at: null, cancelled_at: null, cancel_reason: null, dispatch_claim_id: null, updated_at: '2026-09-29T10:00:00Z', ...over
});
const response = (messages: Partial<Record<ContactMessageStep, ContactMessage>> = {}, prospect: Partial<ProspectMessagesResponse['prospect']> = {}): ProspectMessagesResponse => ({
  prospect: { id: 'p1', state: 'neutral', do_not_contact: false, sequence_closed: false, ...prospect },
  defaults: { from_email: 'hello@viper.test', to: ['alice@acme.test'] },
  messages: (['contact', 'r1', 'r2'] as const).map(step => ({ step, message: messages[step] ?? null }))
});
const ctx = (message: ContactMessage | null, over: Partial<MailContext> = {}): MailContext =>
  ({ message, prospectState: 'neutral', doNotContact: false, sequenceClosed: false, dirty: false, busy: false, ...over });
const withStatus = (status: ContactMessageStatus, over: Partial<ContactMessage> = {}) => msg({ status, ...over });

describe('onglets Contact / R1 / R2', () => {
  it('trois onglets dans l’ordre, badge « Vide » ou libellé du statut, marque des modifications en attente', () => {
    const tabs = mailTabs(response({ contact: withStatus('scheduled'), r1: withStatus('draft', { step: 'r1' }) }), ['r1']);
    expect(tabs.map(t => [t.label, t.badge, t.dirty])).toEqual([['Contact', 'Programmé', false], ['R1', 'Brouillon', true], ['R2', 'Vide', false]]);
    expect(mailTabs(response({ contact: withStatus('cancelled') })).map(t => t.badge)).toEqual(['Annulé', 'Vide', 'Vide']);
  });
  it('clavier : flèches circulaires, Début/Fin, autres touches ignorées', () => {
    expect(tabKeyTarget('ArrowRight', 'contact')).toBe('r1');
    expect(tabKeyTarget('ArrowRight', 'r2')).toBe('contact');
    expect(tabKeyTarget('ArrowLeft', 'contact')).toBe('r2');
    expect(tabKeyTarget('Home', 'r2')).toBe('contact');
    expect(tabKeyTarget('End', 'contact')).toBe('r2');
    expect(tabKeyTarget('Enter', 'r1')).toBeNull();
  });
  it('étape précédente de référence : aucune pour Contact', () => {
    expect([previousStep('contact'), previousStep('r1'), previousStep('r2')]).toEqual([null, 'contact', 'r1']);
  });
});

describe('formulaire', () => {
  const defaults = { from_email: 'hello@viper.test', to: ['alice@acme.test'] };
  it('étape vide : From de la config et destinataire principal, rien d’autre', () => {
    expect(formFromMessage(null, defaults)).toEqual({ from: 'hello@viper.test', to: 'alice@acme.test', cc: '', bcc: '', subject: '', body: '' });
    expect(formFromMessage(null, { from_email: null, to: [] }).from).toBe('');
  });
  it('dirty ignore espaces et séparateurs, détecte un vrai changement', () => {
    const saved = formFromMessage(msg({ to_recipients: ['a@x.test', 'b@x.test'] }), defaults);
    expect(isFormDirty(undefined, saved)).toBe(false);
    expect(isFormDirty({ ...saved, to: ' a@x.test ; b@x.test ' }, saved)).toBe(false);
    expect(isFormDirty({ ...saved, subject: 'Autre' }, saved)).toBe(true);
  });
  it('payload : création sans révision, édition avec `expected_revision`, From vide = null', () => {
    const form: MailForm = { from: ' ', to: 'a@x.test, b@x.test', cc: 'c@x.test', bcc: '', subject: 'S', body: 'B' };
    expect(formPayload(form, null)).toEqual({ from_email: null, subject: 'S', body_text: 'B', to: ['a@x.test', 'b@x.test'], cc: ['c@x.test'], bcc: [] });
    expect(formPayload(form, 3)).toMatchObject({ expected_revision: 3 });
    expect(parseRecipients('a@x.test;\n b@x.test,,')).toEqual(['a@x.test', 'b@x.test']);
  });
  it('adresses mal formées signalées sur le bon champ', () => {
    const errors = formFieldErrors({ from: 'nope', to: 'a@x.test', cc: 'bad', bcc: '', subject: '', body: '' });
    expect(Object.keys(errors).sort()).toEqual(['cc', 'from']);
  });
});

describe('actions selon statut, séquence et modifications', () => {
  it('étape vide : seulement « Créer le brouillon »', () => {
    const a = mailActions(ctx(null));
    expect(a).toMatchObject({ editable: true, canSave: true, saveLabel: 'Créer le brouillon', showValidate: false, showSchedule: false, showCancel: false });
  });
  it('brouillon : valider seulement sans modification en attente', () => {
    expect(mailActions(ctx(withStatus('draft')))).toMatchObject({ canSave: false, showValidate: true, canValidate: true, showSchedule: false, canCancel: true });
    const dirty = mailActions(ctx(withStatus('draft'), { dirty: true }));
    expect(dirty).toMatchObject({ canSave: true, canValidate: false });
    expect(dirty.notes.join(' ')).toMatch(/avant de valider/);
  });
  it('validé : programmation possible ; modifier avertit du retour en Brouillon et bloque la programmation', () => {
    expect(mailActions(ctx(withStatus('validated')))).toMatchObject({ showSchedule: true, canSchedule: true, showValidate: false });
    const dirty = mailActions(ctx(withStatus('validated'), { dirty: true }));
    expect(dirty.canSchedule).toBe(false);
    expect(dirty.notes[0]).toMatch(/repasse en Brouillon.*revalider/);
  });
  it('programmé : déprogrammer ; modifier annonce la perte de programmation', () => {
    expect(mailActions(ctx(withStatus('scheduled')))).toMatchObject({ showUnschedule: true, canUnschedule: true, showSchedule: false });
    expect(mailActions(ctx(withStatus('scheduled'), { dirty: true })).notes[0]).toMatch(/retire la programmation.*reprogrammer/);
  });
  it('envoyé : lecture seule, aucune action', () => {
    const a = mailActions(ctx(withStatus('sent')));
    expect(a).toMatchObject({ editable: false, canSave: false, showValidate: false, showCancel: false, showReopen: false });
    expect(a.notes[0]).toMatch(/ne peut plus être modifié/);
  });
  it('annulé : Rouvrir seulement si la séquence est ouverte', () => {
    expect(mailActions(ctx(withStatus('cancelled')))).toMatchObject({ editable: false, showReopen: true, canReopen: true });
    const closed = mailActions(ctx(withStatus('cancelled'), { prospectState: 'response_received', sequenceClosed: true }));
    expect(closed).toMatchObject({ showReopen: false, canReopen: false });
    expect(closed.notes[0]).toMatch(/Réponse reçue/);
    expect(mailActions(ctx(withStatus('cancelled'), { doNotContact: true, sequenceClosed: true })).showReopen).toBe(false);
  });
  it('séquence fermée : édition, validation et programmation bloquées, retrait encore possible', () => {
    const draft = mailActions(ctx(withStatus('draft'), { prospectState: 'appointment_obtained', sequenceClosed: true }));
    expect(draft).toMatchObject({ editable: false, canSave: false, showValidate: false, canCancel: true });
    expect(draft.notes[0]).toMatch(/RDV pris/);
    expect(mailActions(ctx(withStatus('scheduled'), { doNotContact: true, sequenceClosed: true }))).toMatchObject({ canUnschedule: true, showSchedule: false });
    expect(mailActions(ctx(null, { sequenceClosed: true, prospectState: 'ignored' }))).toMatchObject({ editable: false, canSave: false });
  });
  it('envoi en cours : tout verrouillé', () => {
    expect(mailActions(ctx(withStatus('scheduled', { dispatch_claim_id: 'c1' })))).toMatchObject({ editable: false, canUnschedule: false, canCancel: false });
  });
  it('occupé ou confirmation ouverte : aucune action cliquable', () => {
    expect(mailActions(ctx(withStatus('draft'), { busy: true }))).toMatchObject({ canValidate: false, canCancel: false });
  });
});

describe('programmation : date + heure locales explicites', () => {
  const now = new Date(2026, 8, 29, 10, 0);
  it('aucune valeur par défaut : date et heure exigées', () => {
    expect(scheduleToIso({ date: '', time: '' }, now)).toMatchObject({ ok: false });
    expect(scheduleToIso({ date: '2026-10-05', time: '' }, now)).toMatchObject({ ok: false, error: expect.stringMatching(/heure/) });
    expect(scheduleToIso({ date: '', time: '09:30' }, now)).toMatchObject({ ok: false, error: expect.stringMatching(/date/) });
  });
  it('ISO 8601 avec le décalage local, même instant que la saisie', () => {
    const parsed = scheduleToIso({ date: '2026-10-05', time: '09:30' }, now);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.iso).toMatch(/^2026-10-05T09:30:00[+-]\d{2}:\d{2}$/);
    expect(new Date(parsed.iso).getTime()).toBe(new Date(2026, 9, 5, 9, 30).getTime());
  });
  it('passé ou maintenant refusé ; date impossible refusée', () => {
    expect(scheduleToIso({ date: '2026-09-29', time: '10:00' }, now)).toMatchObject({ ok: false, error: expect.stringMatching(/futur/) });
    expect(scheduleToIso({ date: '2026-02-30', time: '10:00' }, now)).toMatchObject({ ok: false });
  });
  it('format du décalage UTC', () => {
    expect([formatUtcOffset(120), formatUtcOffset(0), formatUtcOffset(-330), formatUtcOffset(345)]).toEqual(['+02:00', '+00:00', '-05:30', '+05:45']);
  });
});

describe('erreurs API', () => {
  it('422 message_incomplete : champs signalés', () => {
    const view = mailErrorView({ code: 'message_incomplete', fields: ['subject', 'body_text', 'to', 'from_email'], message: 'x' });
    expect(Object.keys(view.fields).sort()).toEqual(['body', 'from', 'subject', 'to']);
    expect(view.reload).toBe(false);
  });
  it('409 revision_conflict : rechargement + mise de côté, jamais d’écrasement', () => {
    expect(mailErrorView({ code: 'revision_conflict' })).toMatchObject({ reload: true, conflict: true });
    expect(mailErrorView({ code: 'message_exists' })).toMatchObject({ conflict: true });
    expect(mailErrorView({ code: 'prospect_sequence_closed' })).toMatchObject({ reload: true, conflict: false });
  });
  it('adresse invalide rattachée au champ fautif ; date passée au sélecteur', () => {
    const form: MailForm = { from: 'hello@viper.test', to: 'a@x.test', cc: '', bcc: 'oops', subject: '', body: '' };
    expect(Object.keys(mailErrorView({ code: 'invalid_recipient' }, form).fields)).toEqual(['bcc']);
    expect(Object.keys(mailErrorView({ code: 'scheduled_at_not_future' }).fields)).toEqual(['schedule']);
    expect(mailErrorView({ message: 'Réseau' }).message).toBe('Réseau');
  });
});

describe('textes', () => {
  it('confirmations claires, sans promesse d’envoi tant que l’envoi différé n’est pas actif', () => {
    expect(actionConfirmation('validate', 'r1').title).toBe('Valider le message R1 ?');
    const schedule = actionConfirmation('schedule', 'contact', { at: new Date(2026, 9, 5, 9, 30), zone: 'Europe/Paris, UTC+02:00' });
    expect(schedule.lines.join(' ')).toMatch(/Europe\/Paris/);
    expect(schedule.lines.join(' ')).toMatch(/aucun mail ne part/);
    expect(actionConfirmation('cancel', 'r2').confirmLabel).toBe('Confirmer l’annulation');
  });
  it('statut et raison d’annulation lisibles', () => {
    expect(cancelReasonLabel('prospect_state:response_received')).toMatch(/Réponse reçue/);
    expect(cancelReasonLabel('manual')).toBe('annulé à la main');
    expect(cancelReasonLabel('prospect_state:bogus')).toBeNull();
    expect(messageStatusLine(null)).toMatch(/premier enregistrement/);
    expect(messageStatusLine(null, true)).toBe('Aucun message pour cette étape.');
    expect(messageStatusLine(withStatus('sent', { sent_at: '2026-09-29T10:00:00Z' }))).toMatch(/^Envoyé le /);
  });
  it('annonces après action', () => {
    const r = (over = {}) => ({ message: msg(), created: false, changed: true, unvalidated: false, remoteDraftQueued: false, ...over });
    expect(actionNotice('save', 'contact', r({ created: true }))).toBe('Brouillon Contact créé.');
    expect(actionNotice('save', 'r1', r({ unvalidated: true }))).toMatch(/repassé en Brouillon/);
    expect(actionNotice('save', 'r1', r({ changed: false }))).toMatch(/Aucune modification/);
  });
});

describe('rendu de l’éditeur', () => {
  const render = (data: ProspectMessagesResponse, step: ContactMessageStep = 'contact', localForm?: MailForm) => renderToStaticMarkup(createElement(MailEditor, {
    prospectId: 'p1', step, data, localForm, onLocalForm: () => undefined, conflictForm: undefined, onConflict: () => undefined,
    onMessage: () => undefined, onReload: () => undefined
  }));
  it('étape vide : champs préremplis, bouton de création, aucun bouton de génération ni pièce jointe factice', () => {
    const html = render(response());
    expect(html).toContain('value="hello@viper.test"');
    expect(html).toContain('value="alice@acme.test"');
    expect(html).toContain('Créer le brouillon');
    expect(html).not.toMatch(/générer/i);
    expect(html).not.toMatch(/type="file"/);
    expect(html).not.toContain('Valider');
  });
  it('validé : programmation avec date et heure vides, fuseau affiché', () => {
    const html = render(response({ contact: withStatus('validated') }));
    expect(html).toContain('Programmer l’envoi');
    expect(html).toMatch(/type="date"[^>]*value=""/);
    expect(html).toMatch(/type="time"[^>]*value=""/);
    expect(html).toContain('Heure locale');
  });
  it('validé modifié : avertissement de revalidation et indication non enregistré', () => {
    const data = response({ contact: withStatus('validated') });
    const html = render(data, 'contact', { ...formFromMessage(withStatus('validated'), data.defaults), subject: 'Nouveau' });
    expect(html).toContain('Modifications non enregistrées');
    expect(html).toContain('Il faudra le revalider');
  });
  it('envoyé : lecture seule sans champ ni action', () => {
    const html = render(response({ contact: withStatus('sent', { sent_at: '2026-09-29T10:00:00Z' }) }));
    expect(html).not.toMatch(/<(input|textarea)\b/);
    expect(html).not.toMatch(/Enregistrer|Valider|Annuler le message/);
    expect(html).toContain('Bonjour');
  });
  it('R1 : message Contact en référence, lecture seule', () => {
    const html = render(response({ contact: withStatus('sent', { sent_at: '2026-09-29T10:00:00Z' }) }), 'r1');
    expect(html).toContain('Message Contact (référence, lecture seule)');
    expect(html).toContain('Créer le brouillon');
  });
  it('séquence fermée : explication, aucune édition', () => {
    const html = render(response({ r1: withStatus('cancelled', { step: 'r1', cancel_reason: 'prospect_state:response_received', cancelled_at: '2026-09-29T10:00:00Z' }) },
      { state: 'response_received', sequence_closed: true }), 'r1');
    expect(html).toContain('Séquence fermée par l’état « Réponse reçue »');
    expect(html).not.toMatch(/<(input|textarea)\b/);
    expect(html).not.toContain('Rouvrir');
  });
});
