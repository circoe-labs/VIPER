import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../src/server/schema.js';
import { migrateContactMessages } from '../src/server/contactMessageSchema.js';
import { contactMessageCanceller, getContactMessageById, listContactMessageEvents } from '../src/server/contactMessageStore.js';
import { createContactTrackingService } from '../src/server/contactTrackingService.js';
import {
  ContactMessageError, createContactMessageService, parseExpectedRevision, parseMessageContent, parseMessageStep, parseSchedule,
  type ContactMessageDeps, type RemoteDraftPort
} from '../src/server/contactMessageService.js';
import { canReopenContactMessage, isContactSequenceClosed, type ContactMessageStep } from '../src/shared/contactWorkflow.js';

const human = { type: 'human' as const, id: 'pilot-user', display: 'Commercial VIPER' };
const agent = { type: 'agent' as const, id: 'openai-generator' };
const system = { type: 'system' as const, id: 'dispatcher' };
const NOW = new Date('2026-09-29T08:00:00.000Z');
const FUTURE = '2026-10-05T07:30:00.000Z';
const FROM = 'expediteur@example.test';
const TO = 'prospect@example.test';

const dirs: string[] = [];
const opened: Database.Database[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
// Base temporaire sur disque (même chemin d'exécution que le serveur : WAL + FK).
function setup(deps: ContactMessageDeps = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-messages-'));
  dirs.push(dir);
  const db = new Database(path.join(dir, 'viper.sqlite'));
  opened.push(db);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(schema);
  migrateContactMessages(db);
  db.prepare("INSERT INTO companies(id,display_name) VALUES('c1','Synthetic Co')").run();
  let clock = NOW;
  const service = createContactMessageService(db, { now: () => clock, defaultFromEmail: FROM, ...deps });
  const tracking = createContactTrackingService(db, { now: () => clock, cancelFutureMessages: contactMessageCanceller });
  const addProspect = (id: string, { email = (id === 'p1' ? TO : `${id}@example.test`) as string | null, dnc = false } = {}) => {
    db.prepare("INSERT INTO prospects(id,company_id,first_name,last_name,contactability_status) VALUES(?,'c1','P','Test',?)").run(id, dnc ? 'do_not_contact' : 'contactable');
    if (email) db.prepare("INSERT INTO emails(id,prospect_id,address,is_primary) VALUES(?,?,?,1)").run(`e-${id}`, id, email);
    tracking.applyProspectPayload(id, {}, human);
  };
  const setClock = (date: Date) => { clock = date; };
  const events = (messageId: string) => listContactMessageEvents(db, messageId).map(e => e.event_type);
  const cleanups = () => db.prepare('SELECT message_id,remote_provider,remote_draft_id,reason FROM contact_message_remote_draft_cleanups ORDER BY created_at,rowid').all();
  // Message complet en brouillon (révision 1).
  const draft = (id = 'p1', step: ContactMessageStep = 'contact') => service.saveMessage(id, step, { subject: 'Objet', body_text: 'Bonjour' }, human).message;
  const validated = (id = 'p1', step: ContactMessageStep = 'contact') => { const m = draft(id, step); return service.validate(id, step, m.revision, human).message; };
  const scheduled = (id = 'p1', step: ContactMessageStep = 'contact') => { const m = validated(id, step); return service.schedule(id, step, { expected_revision: m.revision, scheduled_at: FUTURE }, human).message; };
  const attachRemote = (messageId: string, draftId = 'remote-1') => db.prepare("UPDATE contact_messages SET remote_provider='toolbox',remote_draft_id=? WHERE id=?").run(draftId, messageId);
  const claim = (messageId: string, claimId = 'claim-1') => db.prepare('UPDATE contact_messages SET dispatch_claim_id=?,dispatch_claimed_at=? WHERE id=?').run(claimId, NOW.toISOString(), messageId);
  return { db, service, tracking, addProspect, setClock, events, cleanups, draft, validated, scheduled, attachRemote, claim };
}

const expectCode = (fn: () => unknown, code: string) => {
  try { fn(); } catch (e) {
    expect(e).toBeInstanceOf(ContactMessageError);
    expect((e as ContactMessageError).code).toBe(code);
    return e as ContactMessageError;
  }
  throw new Error(`ContactMessageError ${code} attendue`);
};

describe('lecture et création des trois messages', () => {
  it('trois étapes vides avec valeurs par défaut : From depuis la config, destinataire = email principal', () => {
    const t = setup();
    t.addProspect('p1');
    const list = t.service.listMessages('p1');
    expect(list.messages.map(m => [m.step, m.message])).toEqual([['contact', null], ['r1', null], ['r2', null]]);
    expect(list.defaults).toEqual({ from_email: FROM, to: [TO] });
    expect(list.prospect).toEqual({ id: 'p1', state: 'neutral', do_not_contact: false, sequence_closed: false });
  });

  it('From jamais inventé : absent ou invalide en config => null ; prospect sans email => aucun destinataire', () => {
    const none = setup({ defaultFromEmail: null });
    none.addProspect('p1', { email: null });
    expect(none.service.listMessages('p1').defaults).toEqual({ from_email: null, to: [] });
    const invalid = setup({ defaultFromEmail: 'pas-une-adresse' });
    invalid.addProspect('p1');
    expect(invalid.service.listMessages('p1').defaults.from_email).toBeNull();
  });

  it('création sans révision : draft révision 1, valeurs par défaut complétées par la saisie, événement created', () => {
    const t = setup();
    t.addProspect('p1');
    const result = t.service.saveMessage('p1', 'r1', { subject: 'Relance', cc: [' copie@example.test ', 'COPIE@example.test'] }, human);
    expect(result).toMatchObject({ created: true, changed: true, unvalidated: false });
    expect(result.message).toMatchObject({ step: 'r1', status: 'draft', revision: 1, from_email: FROM, to_recipients: [TO], cc_recipients: ['copie@example.test'], subject: 'Relance', body_text: '' });
    expect(t.events(result.message.id)).toEqual(['created']);
    expect(t.service.getMessage('p1', 'r1').events.map(e => e.event_type)).toEqual(['created']);
    expect(t.service.getMessage('p1', 'r2')).toEqual({ message: null, events: [] });
  });

  it('création concurrente : sans révision sur une étape existante => message_exists ; révision sur étape absente => message_not_found', () => {
    const t = setup();
    t.addProspect('p1');
    t.draft();
    expectCode(() => t.service.saveMessage('p1', 'contact', { subject: 'Autre' }, human), 'message_exists');
    expectCode(() => t.service.saveMessage('p1', 'r2', { expected_revision: 1, subject: 'x' }, human), 'message_not_found');
  });

  it('prospect inconnu, destinataire ou From invalides refusés sans écriture', () => {
    const t = setup();
    t.addProspect('p1');
    expectCode(() => t.service.listMessages('nope'), 'prospect_not_found');
    expectCode(() => t.service.saveMessage('nope', 'contact', {}, human), 'prospect_not_found');
    expectCode(() => t.service.saveMessage('p1', 'contact', { to: ['pas-une-adresse'] }, human), 'invalid_recipient');
    expectCode(() => t.service.saveMessage('p1', 'contact', { from_email: 'x@' }, human), 'invalid_from_email');
    expect(t.service.getMessage('p1', 'contact').message).toBeNull();
  });

  it('création refusée si la séquence est fermée (réponse, RDV, ignoré, à ne plus contacter)', () => {
    const t = setup();
    t.addProspect('dnc', { dnc: true });
    expectCode(() => t.service.saveMessage('dnc', 'contact', {}, human), 'prospect_do_not_contact');
    for (const state of ['response_received', 'appointment_obtained'] as const) {
      t.addProspect(state);
      t.tracking.changeState(state, state, human);
      expectCode(() => t.service.saveMessage(state, 'contact', {}, human), 'prospect_sequence_closed');
    }
    t.addProspect('ign');
    t.tracking.changeState('ign', 'ignored', human);
    expectCode(() => t.service.saveMessage('ign', 'contact', {}, human), 'prospect_do_not_contact');
  });

  it('acteur humain obligatoire pour toute écriture manuelle', () => {
    const t = setup();
    t.addProspect('p1');
    for (const a of [agent, system, { type: 'human' as const }]) expectCode(() => t.service.saveMessage('p1', 'contact', {}, a), 'human_actor_required');
    const m = t.draft();
    for (const a of [agent, system]) {
      expectCode(() => t.service.validate('p1', 'contact', m.revision, a), 'human_actor_required');
      expectCode(() => t.service.cancel('p1', 'contact', m.revision, a), 'human_actor_required');
    }
  });
});

describe('édition et verrou optimiste', () => {
  it('édition d’un brouillon : revision+1, événement edited avec noms de champs seulement ; sauvegarde identique = no-op', () => {
    const t = setup();
    t.addProspect('p1');
    const m = t.draft();
    const edited = t.service.saveMessage('p1', 'contact', { expected_revision: m.revision, body_text: 'Nouveau corps' }, human);
    expect(edited).toMatchObject({ changed: true, unvalidated: false, message: { status: 'draft', revision: 2, body_text: 'Nouveau corps' } });
    const events = listContactMessageEvents(t.db, m.id);
    expect(events.at(-1)).toMatchObject({ event_type: 'edited', revision: 2, details: { fields: 'body_text' } });
    expect(JSON.stringify(events)).not.toContain('Nouveau corps');
    const same = t.service.saveMessage('p1', 'contact', { expected_revision: 2, body_text: 'Nouveau corps' }, human);
    expect(same).toMatchObject({ changed: false, message: { revision: 2 } });
  });

  it('révision périmée ou absente => 409/400, rien n’est écrasé', () => {
    const t = setup();
    t.addProspect('p1');
    const m = t.draft();
    t.service.saveMessage('p1', 'contact', { expected_revision: 1, subject: 'Version A' }, human);
    const conflict = expectCode(() => t.service.saveMessage('p1', 'contact', { expected_revision: 1, subject: 'Version B' }, human), 'revision_conflict');
    expect(conflict.httpStatus).toBe(409);
    expectCode(() => t.service.validate('p1', 'contact', 1, human), 'revision_conflict');
    expect(getContactMessageById(t.db, m.id)).toMatchObject({ subject: 'Version A', revision: 2, status: 'draft' });
  });

  it('édition d’un validated => draft, révision+1, validation effacée, unvalidated_by_edit', () => {
    const t = setup();
    t.addProspect('p1');
    const v = t.validated();
    expect(v).toMatchObject({ status: 'validated', validated_by_actor_id: 'pilot-user', validated_revision: 1 });
    const r = t.service.saveMessage('p1', 'contact', { expected_revision: v.revision, subject: 'Objet modifié' }, human);
    expect(r).toMatchObject({ unvalidated: true, remoteDraftQueued: false });
    expect(r.message).toMatchObject({ status: 'draft', revision: 2, validated_at: null, validated_by_actor_id: null, validated_revision: null });
    expect(t.events(v.id)).toEqual(['created', 'validated', 'unvalidated_by_edit', 'edited']);
  });

  it('édition d’un scheduled => draft, date effacée, brouillon distant déplacé dans la file de cleanup', () => {
    const t = setup();
    t.addProspect('p1');
    const s = t.scheduled();
    t.attachRemote(s.id, 'remote-42');
    const r = t.service.saveMessage('p1', 'contact', { expected_revision: s.revision, to: ['autre@example.test'] }, human);
    expect(r).toMatchObject({ unvalidated: true, remoteDraftQueued: true });
    expect(r.message).toMatchObject({ status: 'draft', revision: 2, scheduled_at: null, remote_draft_id: null, remote_provider: null, to_recipients: ['autre@example.test'] });
    expect(t.cleanups()).toEqual([{ message_id: s.id, remote_provider: 'toolbox', remote_draft_id: 'remote-42', reason: 'edited' }]);
    expect(t.events(s.id)).toEqual(['created', 'validated', 'scheduled', 'unvalidated_by_edit', 'remote_draft_invalidated', 'edited']);
    const unvalidated = listContactMessageEvents(t.db, s.id).find(e => e.event_type === 'unvalidated_by_edit');
    expect(unvalidated?.details).toEqual({ fields: 'to_recipients', had_schedule: true });
  });

  it('une sauvegarde identique d’un validated ne dévalide pas', () => {
    const t = setup();
    t.addProspect('p1');
    const v = t.validated();
    expect(t.service.saveMessage('p1', 'contact', { expected_revision: 1, subject: 'Objet' }, human)).toMatchObject({ changed: false, message: { status: 'validated' } });
    expect(getContactMessageById(t.db, v.id)?.status).toBe('validated');
  });

  it('édition d’un scheduled verrouillé par un envoi en cours refusée', () => {
    const t = setup();
    t.addProspect('p1');
    const s = t.scheduled();
    t.claim(s.id);
    expectCode(() => t.service.saveMessage('p1', 'contact', { expected_revision: 1, subject: 'x' }, human), 'dispatch_in_progress');
    expectCode(() => t.service.unschedule('p1', 'contact', 1, human), 'dispatch_in_progress');
    expectCode(() => t.service.cancel('p1', 'contact', 1, human), 'dispatch_in_progress');
  });
});

describe('validation humaine', () => {
  it('draft complet => validated, liée à la révision courante, audit sans contenu', () => {
    const t = setup();
    t.addProspect('p1');
    const v = t.validated();
    expect(v).toMatchObject({ status: 'validated', revision: 1, validated_revision: 1, validated_at: NOW.toISOString() });
    const audit = t.db.prepare("SELECT action,before_payload,after_payload FROM audit_log WHERE entity_type='contact_message' ORDER BY rowid").all() as { action: string; after_payload: string }[];
    expect(audit.map(a => a.action)).toEqual(['message_create', 'message_validate']);
    expect(JSON.stringify(audit)).not.toMatch(/Objet|Bonjour|example\.test/);
  });

  it('sujet, corps, destinataire ou From manquants => message_incomplete avec la liste des champs', () => {
    const t = setup({ defaultFromEmail: null });
    t.addProspect('p1', { email: null });
    const m = t.service.saveMessage('p1', 'contact', { subject: '  ', body_text: '' }, human).message;
    const e = expectCode(() => t.service.validate('p1', 'contact', m.revision, human), 'message_incomplete');
    expect(e.httpStatus).toBe(422);
    expect(e.fields).toEqual(['subject', 'body_text', 'to', 'from_email']);
    expect(getContactMessageById(t.db, m.id)?.status).toBe('draft');
  });

  it('validation refusée si le prospect est à ne plus contacter ou si la séquence est fermée', () => {
    const t = setup();
    t.addProspect('p1');
    const m = t.draft();
    t.db.prepare("UPDATE prospects SET contactability_status='do_not_contact' WHERE id='p1'").run();
    expectCode(() => t.service.validate('p1', 'contact', m.revision, human), 'prospect_do_not_contact');
    t.db.prepare("UPDATE prospects SET contactability_status='contactable' WHERE id='p1'").run();
    t.db.prepare("UPDATE contact_tracking SET status='response_received' WHERE prospect_id='p1'").run(); // état posé sans passer par le hook
    expectCode(() => t.service.validate('p1', 'contact', m.revision, human), 'prospect_sequence_closed');
  });

  it('chaque étape a sa propre validation (décision 23)', () => {
    const t = setup();
    t.addProspect('p1');
    t.validated('p1', 'contact');
    t.draft('p1', 'r1');
    const list = t.service.listMessages('p1').messages.map(m => m.message?.status ?? null);
    expect(list).toEqual(['validated', 'draft', null]);
  });

  it('valider un message non-draft => invalid_transition', () => {
    const t = setup();
    t.addProspect('p1');
    t.validated();
    expectCode(() => t.service.validate('p1', 'contact', 1, human), 'invalid_transition');
    t.service.schedule('p1', 'contact', { expected_revision: 1, scheduled_at: FUTURE }, human);
    expectCode(() => t.service.validate('p1', 'contact', 1, human), 'invalid_transition');
  });
});

describe('programmation', () => {
  it('validated + date future => scheduled (date normalisée UTC), événement scheduled ; déprogrammation => validated', () => {
    const t = setup();
    t.addProspect('p1');
    const v = t.validated();
    const s = t.service.schedule('p1', 'contact', { expected_revision: v.revision, scheduled_at: '2026-10-05T09:30:00+02:00' }, human).message;
    expect(s).toMatchObject({ status: 'scheduled', scheduled_at: FUTURE, validated_revision: 1, revision: 1 });
    const u = t.service.unschedule('p1', 'contact', 1, human).message;
    expect(u).toMatchObject({ status: 'validated', scheduled_at: null, validated_revision: 1 });
    expect(t.events(v.id)).toEqual(['created', 'validated', 'scheduled', 'validated']);
  });

  it('draft jamais programmable', () => {
    const t = setup();
    t.addProspect('p1');
    t.draft();
    expectCode(() => t.service.schedule('p1', 'contact', { expected_revision: 1, scheduled_at: FUTURE }, human), 'invalid_transition');
  });

  it('date absente, invalide, sans fuseau, passée ou égale à maintenant refusée ; aucune heure par défaut', () => {
    const t = setup();
    t.addProspect('p1');
    t.validated();
    expectCode(() => parseSchedule({ expected_revision: 1 }), 'invalid_scheduled_at');
    for (const at of ['', 'demain', '2026-10-05', '2026-10-05T09:30:00', '2026-13-40T09:30:00Z']) {
      expectCode(() => t.service.schedule('p1', 'contact', { expected_revision: 1, scheduled_at: at }, human), 'invalid_scheduled_at');
    }
    expectCode(() => t.service.schedule('p1', 'contact', { expected_revision: 1, scheduled_at: '2026-09-28T08:00:00Z' }, human), 'scheduled_at_not_future');
    expectCode(() => t.service.schedule('p1', 'contact', { expected_revision: 1, scheduled_at: NOW.toISOString() }, human), 'scheduled_at_not_future');
    expect(t.service.getMessage('p1', 'contact').message).toMatchObject({ status: 'validated', scheduled_at: null });
  });

  it('reprogrammer exige de déprogrammer d’abord ; déprogrammer un non-programmé refusé', () => {
    const t = setup();
    t.addProspect('p1');
    t.scheduled();
    expectCode(() => t.service.schedule('p1', 'contact', { expected_revision: 1, scheduled_at: FUTURE }, human), 'invalid_transition');
    t.draft('p1', 'r1');
    expectCode(() => t.service.unschedule('p1', 'r1', 1, human), 'invalid_transition');
  });

  it('programmation refusée si la séquence est fermée', () => {
    const t = setup();
    t.addProspect('p1');
    t.validated();
    t.db.prepare("UPDATE contact_tracking SET status='appointment_obtained' WHERE prospect_id='p1'").run();
    expectCode(() => t.service.schedule('p1', 'contact', { expected_revision: 1, scheduled_at: FUTURE }, human), 'prospect_sequence_closed');
  });
});

describe('envoi (dispatcher interne) et immutabilité de sent', () => {
  it('markSent exige scheduled + verrou du dispatcher ; draft et validated jamais envoyés', () => {
    const t = setup();
    t.addProspect('p1');
    const d = t.draft('p1', 'contact');
    expectCode(() => t.service.markSent(d.id, { claimId: 'x', remoteMessageId: null }, system), 'invalid_transition');
    const v = t.validated('p1', 'r1');
    expectCode(() => t.service.markSent(v.id, { claimId: 'x', remoteMessageId: null }, system), 'invalid_transition');
    const s = t.scheduled('p1', 'r2');
    expectCode(() => t.service.markSent(s.id, { claimId: 'claim-1', remoteMessageId: 'm-1' }, system), 'dispatch_claim_mismatch');
    t.claim(s.id, 'claim-1');
    expectCode(() => t.service.markSent(s.id, { claimId: 'autre', remoteMessageId: 'm-1' }, system), 'dispatch_claim_mismatch');
    expect(t.service.markSent(s.id, { claimId: 'claim-1', remoteMessageId: 'm-1' }, system)).toMatchObject({ status: 'sent', sent_at: NOW.toISOString(), remote_message_id: 'm-1' });
    expect(t.events(s.id).at(-1)).toBe('sent');
  });

  it('sent n’est jamais modifiable : édition, validation, programmation, annulation, réouverture, génération refusées', () => {
    const t = setup();
    t.addProspect('p1');
    const s = t.scheduled();
    t.claim(s.id);
    const sent = t.service.markSent(s.id, { claimId: 'claim-1', remoteMessageId: 'm-1' }, system);
    const attempts: (() => unknown)[] = [
      () => t.service.saveMessage('p1', 'contact', { expected_revision: 1, subject: 'x' }, human),
      () => t.service.saveMessage('p1', 'contact', { subject: 'x' }, human),
      () => t.service.validate('p1', 'contact', 1, human),
      () => t.service.schedule('p1', 'contact', { expected_revision: 1, scheduled_at: FUTURE }, human),
      () => t.service.unschedule('p1', 'contact', 1, human),
      () => t.service.cancel('p1', 'contact', 1, human),
      () => t.service.reopen('p1', 'contact', 1, human),
      () => t.service.saveGeneratedContent('p1', 'contact', { subject: 's', body_text: 'b', model: 'm', prompt_version: 'v1', expected_revision: 1 }, agent),
      () => t.service.markSent(s.id, { claimId: 'claim-1', remoteMessageId: 'm-2' }, system)
    ];
    for (const attempt of attempts) expectCode(attempt, 'message_sent_immutable');
    expect(getContactMessageById(t.db, s.id)).toEqual(sent);
  });

  it('les routes ne peuvent pas usurper un statut : le schéma de contenu refuse status/sent_at/validated_at', () => {
    for (const key of ['status', 'sent_at', 'validated_at', 'scheduled_at', 'revision', 'remote_draft_id']) {
      expectCode(() => parseMessageContent({ [key]: 'sent' }), 'invalid_payload');
    }
    expectCode(() => parseExpectedRevision({}), 'revision_required');
    expectCode(() => parseExpectedRevision({ expected_revision: 0 }), 'revision_required');
    expectCode(() => parseMessageStep('r3'), 'invalid_step');
    expect(parseMessageStep('r2')).toBe('r2');
  });
});

describe('annulation', () => {
  it('annulation humaine depuis draft, validated et scheduled ; brouillon distant en file ; journal', () => {
    const t = setup();
    t.addProspect('p1');
    const d = t.draft('p1', 'contact');
    const v = t.validated('p1', 'r1');
    const s = t.scheduled('p1', 'r2');
    t.attachRemote(s.id);
    expect(t.service.cancel('p1', 'contact', d.revision, human)).toMatchObject({ remoteDraftQueued: false, message: { status: 'cancelled', cancel_reason: 'manual' } });
    expect(t.service.cancel('p1', 'r1', v.revision, human).message.status).toBe('cancelled');
    expect(t.service.cancel('p1', 'r2', s.revision, human)).toMatchObject({ remoteDraftQueued: true, message: { status: 'cancelled', remote_draft_id: null } });
    expect(t.cleanups()).toEqual([{ message_id: s.id, remote_provider: 'toolbox', remote_draft_id: 'remote-1', reason: 'cancelled' }]);
    expect(t.events(s.id).at(-1)).toBe('cancelled');
    expectCode(() => t.service.cancel('p1', 'contact', 1, human), 'invalid_transition');
  });

  it('un message annulé ne s’édite pas, ne se valide pas et ne se programme pas', () => {
    const t = setup();
    t.addProspect('p1');
    t.draft();
    t.service.cancel('p1', 'contact', 1, human);
    expectCode(() => t.service.saveMessage('p1', 'contact', { expected_revision: 1, subject: 'x' }, human), 'message_cancelled');
    expectCode(() => t.service.validate('p1', 'contact', 1, human), 'invalid_transition');
    expectCode(() => t.service.schedule('p1', 'contact', { expected_revision: 1, scheduled_at: FUTURE }, human), 'invalid_transition');
  });

  it('changement manuel vers réponse reçue / RDV / ignoré => messages futurs annulés, sent inchangé', () => {
    for (const state of ['response_received', 'appointment_obtained', 'ignored'] as const) {
      const t = setup();
      t.addProspect('p1');
      const s = t.scheduled('p1', 'contact');
      t.claim(s.id);
      const sent = t.service.markSent(s.id, { claimId: 'claim-1', remoteMessageId: 'm-1' }, system);
      const v = t.scheduled('p1', 'r1');
      t.attachRemote(v.id, 'remote-r1');
      const d = t.draft('p1', 'r2');
      const result = t.tracking.changeState('p1', state, human);
      expect(result.cancelledMessages).toBe(2);
      expect(getContactMessageById(t.db, s.id)).toEqual(sent);
      expect(getContactMessageById(t.db, v.id)).toMatchObject({ status: 'cancelled', cancel_reason: `prospect_state:${state}`, remote_draft_id: null });
      expect(getContactMessageById(t.db, d.id)?.status).toBe('cancelled');
      expect(t.cleanups()).toEqual([{ message_id: v.id, remote_provider: 'toolbox', remote_draft_id: 'remote-r1', reason: 'cancelled' }]);
      expect(t.service.listMessages('p1').prospect.sequence_closed).toBe(true);
    }
  });

  it('contacté / R1 / R2 / failure n’annulent rien', () => {
    const t = setup();
    t.addProspect('p1');
    const s = t.scheduled();
    for (const state of ['contacted', 'r1', 'r2', 'failure'] as const) expect(t.tracking.changeState('p1', state, human).cancelledMessages).toBe(0);
    expect(getContactMessageById(t.db, s.id)?.status).toBe('scheduled');
  });
});

describe('réouverture d’une étape annulée (règle retenue)', () => {
  it('annulation manuelle puis réouverture explicite : draft, contenu conservé, révision+1, revalidation obligatoire', () => {
    const t = setup();
    t.addProspect('p1');
    const s = t.scheduled();
    t.service.cancel('p1', 'contact', s.revision, human);
    const r = t.service.reopen('p1', 'contact', 1, human).message;
    expect(r).toMatchObject({ status: 'draft', revision: 2, subject: 'Objet', cancelled_at: null, cancel_reason: null, validated_at: null, validated_revision: null, scheduled_at: null });
    expect(t.events(s.id).slice(-2)).toEqual(['cancelled', 'created']);
    expectCode(() => t.service.schedule('p1', 'contact', { expected_revision: 2, scheduled_at: FUTURE }, human), 'invalid_transition');
    expect(t.service.validate('p1', 'contact', 2, human).message.status).toBe('validated');
  });

  it('réouverture refusée tant que la séquence est fermée ; possible après un nouveau choix humain d’état ouvert', () => {
    const t = setup();
    t.addProspect('p1');
    t.validated();
    t.tracking.changeState('p1', 'response_received', human);
    expectCode(() => t.service.reopen('p1', 'contact', 1, human), 'prospect_sequence_closed');
    t.tracking.changeState('p1', 'contacted', human);
    expect(t.service.reopen('p1', 'contact', 1, human).message).toMatchObject({ status: 'draft', revision: 2 });
  });

  it('ignoré : jamais de réouverture (blocage durable) ; réouverture d’un non-annulé refusée ; agent refusé', () => {
    const t = setup();
    t.addProspect('p1');
    t.draft('p1', 'contact');
    t.draft('p1', 'r1');
    t.service.cancel('p1', 'r1', 1, human);
    expectCode(() => t.service.reopen('p1', 'contact', 1, human), 'invalid_transition');
    expectCode(() => t.service.reopen('p1', 'r1', 1, agent), 'human_actor_required');
    t.tracking.changeState('p1', 'ignored', human);
    expectCode(() => t.service.reopen('p1', 'r1', 1, human), 'prospect_do_not_contact');
  });

  it('helpers partagés pour l’UI', () => {
    expect(isContactSequenceClosed('neutral', false)).toBe(false);
    expect(isContactSequenceClosed('failure', false)).toBe(false);
    expect(isContactSequenceClosed('response_received', false)).toBe(true);
    expect(isContactSequenceClosed('contacted', true)).toBe(true);
    expect(isContactSequenceClosed(null, false)).toBe(false);
    expect(canReopenContactMessage('cancelled', 'r1', false)).toBe(true);
    expect(canReopenContactMessage('cancelled', 'ignored', true)).toBe(false);
    expect(canReopenContactMessage('draft', 'r1', false)).toBe(false);
  });
});

describe('points d’extension', () => {
  it('Task 14 : contenu généré => draft, modèle/prompt enregistrés, événement generated ; jamais validé', () => {
    const t = setup();
    t.addProspect('p1');
    const created = t.service.saveGeneratedContent('p1', 'contact', { subject: 'IA', body_text: 'Corps IA', model: 'model-x', prompt_version: 'v1' }, agent);
    expect(created).toMatchObject({ created: true, message: { status: 'draft', generation_model: 'model-x', generation_prompt_version: 'v1', from_email: FROM, to_recipients: [TO] } });
    expect(t.events(created.message.id)).toEqual(['generated']);
    t.service.validate('p1', 'contact', 1, human);
    t.service.schedule('p1', 'contact', { expected_revision: 1, scheduled_at: FUTURE }, human);
    expectCode(() => t.service.saveGeneratedContent('p1', 'contact', { subject: 'IA 2', body_text: 'b', model: 'model-y', prompt_version: 'v2' }, agent), 'message_exists');
    const regenerated = t.service.saveGeneratedContent('p1', 'contact', { subject: 'IA 2', body_text: 'b', model: 'model-y', prompt_version: 'v2', expected_revision: 1 }, agent);
    expect(regenerated).toMatchObject({ unvalidated: true, message: { status: 'draft', revision: 2, subject: 'IA 2', generation_model: 'model-y', scheduled_at: null } });
    expect(t.events(created.message.id).slice(-2)).toEqual(['unvalidated_by_edit', 'generated']);
    const tracking = t.tracking.getTracking('p1');
    expect(tracking?.status).toBe('neutral');
  });

  it('Task 14 : génération refusée si la séquence est fermée ou sans acteur identifié', () => {
    const t = setup();
    t.addProspect('p1');
    expectCode(() => t.service.saveGeneratedContent('p1', 'contact', { subject: 's', body_text: 'b', model: 'm', prompt_version: 'v' }, { type: 'agent' }), 'human_actor_required');
    t.tracking.changeState('p1', 'appointment_obtained', human);
    expectCode(() => t.service.saveGeneratedContent('p1', 'contact', { subject: 's', body_text: 'b', model: 'm', prompt_version: 'v' }, agent), 'prospect_sequence_closed');
  });

  it('Task 15/16 : sans adapter, aucune synchronisation distante (no-op)', async () => {
    const t = setup();
    t.addProspect('p1');
    const v = t.validated();
    expect(await t.service.syncRemoteDraft(v.id, human)).toEqual({ status: 'disabled' });
    expect(getContactMessageById(t.db, v.id)?.remote_draft_id).toBeNull();
  });

  it('Task 15/16 : adapter injecté => id distant rattaché au message validé, jamais pour un draft', async () => {
    const calls: string[] = [];
    const port: RemoteDraftPort = { createDraft: async message => { calls.push(message.status); return { provider: 'toolbox', draftId: `d-${calls.length}` }; } };
    const t = setup({ remoteDrafts: port });
    t.addProspect('p1');
    const d = t.draft('p1', 'r1');
    expect(await t.service.syncRemoteDraft(d.id, human)).toEqual({ status: 'not_applicable' });
    const v = t.validated();
    expect(await t.service.syncRemoteDraft(v.id, human)).toEqual({ status: 'created', provider: 'toolbox' });
    expect(await t.service.syncRemoteDraft(v.id, human)).toEqual({ status: 'already_present' });
    expect(getContactMessageById(t.db, v.id)).toMatchObject({ remote_provider: 'toolbox', remote_draft_id: 'd-1', status: 'validated' });
    expect(t.events(v.id).at(-1)).toBe('remote_draft_created');
    expect(calls).toEqual(['validated']);
  });

  it('Task 15/16 : message édité pendant la création distante => id mis en file (replaced) ; échec adapter => diagnostic, statut intact', async () => {
    let t = setup();
    const racing: RemoteDraftPort = {
      createDraft: async () => {
        t.service.saveMessage('p1', 'contact', { expected_revision: 1, subject: 'Édité pendant l’appel' }, human);
        return { provider: 'toolbox', draftId: 'late-1' };
      }
    };
    t = setup({ remoteDrafts: racing });
    t.addProspect('p1');
    const v = t.validated();
    expect(await t.service.syncRemoteDraft(v.id, human)).toEqual({ status: 'stale', provider: 'toolbox' });
    expect(getContactMessageById(t.db, v.id)).toMatchObject({ status: 'draft', remote_draft_id: null });
    expect(t.cleanups()).toEqual([{ message_id: v.id, remote_provider: 'toolbox', remote_draft_id: 'late-1', reason: 'replaced' }]);

    const failing: RemoteDraftPort = { createDraft: async () => { throw Object.assign(new Error('boom'), { code: 'toolbox_auth_missing' }); } };
    const f = setup({ remoteDrafts: failing });
    f.addProspect('p1');
    const fv = f.validated();
    expect(await f.service.syncRemoteDraft(fv.id, human)).toEqual({ status: 'failed', code: 'toolbox_auth_missing' });
    expect(getContactMessageById(f.db, fv.id)).toMatchObject({ status: 'validated', remote_draft_id: null });
  });
});
