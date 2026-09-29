import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ContactMessage, ProspectMessagesResponse } from '../src/client/contactMailModel';
import {
  generateUrl, generationAvailability, generationConfirmation, generationErrorView, generationNotice, generationPayload, type GenerationResult
} from '../src/client/mailGenerationModel';
import { MailEditor, MailGenerationControls, type MailGenerationContext } from '../src/client/ContactMailPanel';
import type { ContactMessageStatus } from '../src/shared/contactWorkflow';

const msg = (status: ContactMessageStatus = 'draft', over: Partial<ContactMessage> = {}): ContactMessage => ({
  id: 'm1', step: 'contact', status, from_email: 'hello@viper.test', subject: 'Bonjour', body_text: 'Corps',
  to_recipients: ['alice@acme.test'], cc_recipients: [], bcc_recipients: [], revision: 3, scheduled_at: null, validated_at: null,
  sent_at: null, cancelled_at: null, cancel_reason: null, dispatch_claim_id: null, updated_at: '2026-09-29T10:00:00Z', ...over
});
const ctx = (message: ContactMessage | null, over: Partial<MailGenerationContext> = {}): MailGenerationContext =>
  ({ step: 'contact', message, editable: true, dirty: false, busy: false, onGenerated: () => undefined, onReload: () => undefined, ...over });

describe('génération IA : logique du bouton', () => {
  it('Générer si vide, Régénérer si contenu ; masqué si non modifiable ; programmé = à déprogrammer', () => {
    expect(generationAvailability({ message: null, editable: true, busy: false })).toEqual({ show: true, enabled: true, label: 'Générer', note: null });
    expect(generationAvailability({ message: msg('draft', { subject: '', body_text: '' }), editable: true, busy: false }).label).toBe('Générer');
    expect(generationAvailability({ message: msg(), editable: true, busy: true })).toMatchObject({ label: 'Régénérer', enabled: false });
    expect(generationAvailability({ message: msg('sent'), editable: false, busy: false }).show).toBe(false);
    expect(generationAvailability({ message: msg('scheduled'), editable: true, busy: false })).toMatchObject({ show: true, enabled: false, note: expect.stringMatching(/déprogrammez/) });
  });

  it('payload : révision dès que l’étape existe, consigne nettoyée et bornée', () => {
    expect(generationPayload(null, '  ')).toEqual({});
    expect(generationPayload(msg(), ' Plus court ')).toEqual({ expected_revision: 3, instructions: 'Plus court' });
    expect(generationPayload(null, 'x'.repeat(1200)).instructions).toHaveLength(1000);
    expect(generateUrl('p 1', 'r1')).toBe('/api/prospects/p%201/messages/r1/generate');
  });

  it('confirmation seulement si un contenu, des modifications locales ou une validation seraient perdus', () => {
    expect(generationConfirmation('contact', null, false)).toBeNull();
    expect(generationConfirmation('contact', msg('draft', { subject: '', body_text: '' }), false)).toBeNull();
    const all = generationConfirmation('r1', msg('validated'), true);
    expect(all?.title).toBe('Régénérer le message R1 ?');
    expect(all?.lines.join(' ')).toMatch(/seront remplacés.*modifications non enregistrées.*repassera en Brouillon.*reste un Brouillon/);
    expect(generationConfirmation('contact', null, true)?.lines[0]).toMatch(/modifications non enregistrées/);
  });

  it('annonce et erreurs lisibles (IA non configurée, timeout, conflit)', () => {
    const result = { message: msg(), created: false, changed: true, unvalidated: true, remoteDraftQueued: false, generation: { model: 'm-1', prompt_version: 'v' } } as GenerationResult;
    expect(generationNotice('contact', result)).toMatch(/Brouillon Contact rédigé par l’IA \(m-1\).*valider.*repassé en Brouillon/);
    expect(generationErrorView({ code: 'ai_not_configured', message: 'x' })).toEqual({ message: expect.stringMatching(/pas configuré.*Rien n’a été modifié/), reload: false });
    expect(generationErrorView({ code: 'ai_timeout' }).message).toMatch(/pas répondu à temps/);
    expect(generationErrorView({ code: 'revision_conflict' }).reload).toBe(true);
    expect(generationErrorView({ code: 'prospect_sequence_closed' }).reload).toBe(true);
    expect(generationErrorView({ message: 'Autre' }).message).toBe('Autre');
  });
});

describe('génération IA : rendu', () => {
  const html = (c: MailGenerationContext) => renderToStaticMarkup(createElement(MailGenerationControls, { prospectId: 'p1', ctx: c }));
  it('bouton + consigne ; masqué en lecture seule ; désactivé si programmé', () => {
    expect(html(ctx(null))).toContain('Générer avec l’IA');
    expect(html(ctx(null))).toMatch(/<label[^>]*>Consigne pour l’IA \(facultatif\)<\/label><input/);
    expect(html(ctx(msg()))).toContain('Régénérer avec l’IA');
    expect(html(ctx(msg('sent'), { editable: false }))).toBe('');
    expect(html(ctx(msg('scheduled')))).toMatch(/<button[^>]*disabled=""[^>]*>Régénérer avec l’IA/);
  });
  it('branché dans l’éditeur via renderGeneration, dans la barre d’actions', () => {
    const data: ProspectMessagesResponse = {
      prospect: { id: 'p1', state: 'neutral', do_not_contact: false, sequence_closed: false },
      defaults: { from_email: 'hello@viper.test', to: ['alice@acme.test'] },
      messages: [{ step: 'contact', message: null }, { step: 'r1', message: null }, { step: 'r2', message: null }]
    };
    const out = renderToStaticMarkup(createElement(MailEditor, {
      prospectId: 'p1', step: 'contact', data, localForm: undefined, onLocalForm: () => undefined, conflictForm: undefined, onConflict: () => undefined,
      onMessage: () => undefined, onReload: () => undefined, renderGeneration: c => createElement(MailGenerationControls, { prospectId: 'p1', ctx: c })
    }));
    expect(out).toMatch(/class="mail-actions-generation"><div class="mail-generation"[^>]*>.*Générer avec l’IA/);
    expect(out).not.toMatch(/OPENAI|sk-/);
  });
});
