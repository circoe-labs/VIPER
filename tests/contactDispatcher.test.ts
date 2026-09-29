// Task 16 — envoi programmé : faux serveur Toolbox local (MCP réel), horloge injectée, bases temporaires sur disque.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { schema } from '../src/server/schema.js';
import { migrateContactMessages } from '../src/server/contactMessageSchema.js';
import { contactMessageCanceller, getContactMessageById, listContactMessageEvents } from '../src/server/contactMessageStore.js';
import { createContactTrackingService } from '../src/server/contactTrackingService.js';
import { createContactMessageService } from '../src/server/contactMessageService.js';
import { createMemoryTokenStore, createToolboxAuth } from '../src/server/toolboxAuth.js';
import { createMcpMailToolbox, ToolboxError, type MailToolbox } from '../src/server/toolboxMcpClient.js';
import { toolboxRemoteDrafts } from '../src/server/toolboxIntegration.js';
import {
  classifySendError, contactDispatchConfigFromEnv, createContactDispatcher, dispatchBackoffMs, RECONCILE_LIST_LIMIT,
  type ContactDispatchConfig, type ContactDispatcherDeps
} from '../src/server/contactMessageDispatcher.js';
import { actionConfirmation, dispatchStatusLines, type ContactMessage, type ProspectMessagesResponse } from '../src/client/contactMailModel';
import { MailEditor } from '../src/client/ContactMailPanel';
import { stateChangeNotice } from '../src/client/contactWorkbenchModel';
import type { ContactMessageStep } from '../src/shared/contactWorkflow.js';
import { startFakeToolbox, type FakeToolbox, type FakeToolboxOptions } from './support/fakeToolbox.js';

const human = { type: 'human' as const, id: 'pilot-user', display: 'Commercial VIPER' };
const REDIRECT = 'http://localhost:5999/api/toolbox/oauth/callback';
const NOW = new Date('2026-09-29T08:00:00.000Z');
const DUE = new Date('2026-09-29T09:00:00.000Z');
const TO = 'prospect@example.test';
const CONFIG: ContactDispatchConfig = { intervalMs: 0, maxLatenessMs: 6 * 3600_000, claimTtlMs: 10 * 60_000, maxAttempts: 3, retryBaseMs: 60_000, batchSize: 100 };
const SEND = 'infomaniak.mail.send_draft';
const plus = (date: Date, ms: number) => new Date(date.getTime() + ms);

const fakes: FakeToolbox[] = [];
const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(async () => { while (fakes.length) await fakes.pop()!.close(); });
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

function openDb(file: string) {
  const db = new Database(file);
  dbs.push(db);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  return db;
}
async function connectedToolbox(fake: FakeToolbox, timeoutMs: number): Promise<{ toolbox: MailToolbox; withTimeout: (ms: number) => MailToolbox }> {
  const auth = createToolboxAuth({ mcpUrl: fake.mcpUrl, redirectUri: REDIRECT, tokenStorePath: 'unused', timeoutMs }, { store: createMemoryTokenStore() });
  const { authorizationUrl } = await auth.start(human);
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(await auth.complete(Object.fromEntries(new URL(res.headers.get('location')!).searchParams))).toEqual({ ok: true });
  const withTimeout = (ms: number) => createMcpMailToolbox({ mcpUrl: fake.mcpUrl, tokens: auth.tokens, timeoutMs: ms });
  return { toolbox: withTimeout(timeoutMs), withTimeout };
}

// `sendTimeoutMs` : délai court appliqué seulement aux appels du dispatcher (envoi volontairement bloqué/lent) ; connexion,
// brouillons et réconciliation gardent le délai normal pour ne pas dépendre de la charge de la machine.
async function setup(opts: { fake?: FakeToolboxOptions; sendTimeoutMs?: number } = {}) {
  const fake = await startFakeToolbox(opts.fake);
  fakes.push(fake);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-dispatch-'));
  dirs.push(dir);
  const file = path.join(dir, 'viper.sqlite');
  const db = openDb(file);
  db.exec(schema);
  migrateContactMessages(db);
  db.prepare("INSERT INTO companies(id,display_name) VALUES('c1','Synthetic Co')").run();
  let clock = NOW;
  const now = () => clock;
  const tracking = createContactTrackingService(db, { now, cancelFutureMessages: contactMessageCanceller });
  for (const id of ['p1', 'p2']) {
    db.prepare("INSERT INTO prospects(id,company_id,first_name,last_name,contactability_status) VALUES(?,'c1','P','Test','contactable')").run(id);
    db.prepare('INSERT INTO emails(id,prospect_id,address,is_primary) VALUES(?,?,?,1)').run(`e-${id}`, id, id === 'p1' ? TO : `${id}@example.test`);
    tracking.applyProspectPayload(id, {}, human);
  }
  const { toolbox, withTimeout } = await connectedToolbox(fake, 2000);
  const shortToolbox = opts.sendTimeoutMs ? withTimeout(opts.sendTimeoutMs) : toolbox;
  const service = createContactMessageService(db, { now, defaultFromEmail: 'lucie@example.test', remoteDrafts: toolboxRemoteDrafts(toolbox) });
  const logs: string[] = [];
  const dispatcher = (over: Partial<ContactDispatcherDeps> = {}, onDb: Database.Database = db) => createContactDispatcher({
    getDb: () => onDb, toolbox: () => toolbox, remoteDrafts: () => toolboxRemoteDrafts(toolbox), config: CONFIG, now, log: line => logs.push(line), ...over
  });
  const draft = (id = 'p1', step: ContactMessageStep = 'contact') => service.saveMessage(id, step, { subject: 'Objet confidentiel', body_text: 'Corps confidentiel' }, human).message;
  const validated = async (id = 'p1', step: ContactMessageStep = 'contact', withRemote = true) => {
    const m = service.validate(id, step, draft(id, step).revision, human).message;
    if (withRemote) expect(await service.syncRemoteDraft(m.id, human)).toMatchObject({ status: 'created' });
    return getContactMessageById(db, m.id)!;
  };
  const scheduled = async (id = 'p1', step: ContactMessageStep = 'contact', at = DUE, withRemote = true) => {
    const m = await validated(id, step, withRemote);
    return service.schedule(id, step, { expected_revision: m.revision, scheduled_at: at.toISOString() }, human).message;
  };
  const sendCalls = () => fake.calls.filter(c => c.tool === SEND).length;
  const reload = (id: string) => getContactMessageById(db, id)!;
  const events = (id: string) => listContactMessageEvents(db, id).map(e => e.event_type);
  return { fake, db, file, tracking, toolbox, shortToolbox, service, logs, dispatcher, draft, validated, scheduled, sendCalls, reload, events, setClock: (d: Date) => { clock = d; } };
}

describe('dispatcher : éligibilité', () => {
  it('brouillon et validé jamais envoyés ; programmé jamais avant l’heure ; à l’heure => un envoi, `sent`, prospect inchangé', async () => {
    const t = await setup();
    const d = t.draft('p2', 'contact');
    const v = await t.validated('p2', 'r1');
    const s = await t.scheduled();
    const trackingBefore = t.db.prepare('SELECT status,next_action_year,next_action_week FROM contact_tracking WHERE prospect_id=?').get('p1');
    const historyBefore = t.db.prepare('SELECT count(*) n FROM contact_tracking_status_history').get();
    const d1 = t.dispatcher();

    t.setClock(plus(DUE, -1));
    expect(await d1.runScan()).toMatchObject({ skipped: null, sent: 0 });
    expect(t.sendCalls()).toBe(0);
    t.setClock(DUE);
    expect(await d1.runScan()).toMatchObject({ sent: 1, failed: 0, uncertain: 0 });
    expect(t.sendCalls()).toBe(1);
    const sent = t.reload(s.id);
    expect(sent).toMatchObject({ status: 'sent', sent_at: DUE.toISOString(), dispatch_attempts: 1, last_error_code: null, remote_message_id: null });
    expect(t.fake.sent).toEqual([sent.remote_draft_id]);
    expect(t.events(s.id).slice(-2)).toEqual(['dispatch_claimed', 'sent']);
    expect(t.reload(d.id).status).toBe('draft');
    expect(t.reload(v.id).status).toBe('validated');
    // Aucune transition prospect automatique (décision 10).
    expect(t.db.prepare('SELECT status,next_action_year,next_action_week FROM contact_tracking WHERE prospect_id=?').get('p1')).toEqual(trackingBefore);
    expect(t.db.prepare('SELECT count(*) n FROM contact_tracking_status_history').get()).toEqual(historyBefore);
    // Passe suivante : rien à renvoyer.
    t.setClock(plus(DUE, 3600_000));
    expect(await d1.runScan()).toMatchObject({ sent: 0 });
    expect(t.sendCalls()).toBe(1);
    // Journal et audit sans contenu ni adresse.
    const journal = JSON.stringify([t.db.prepare('SELECT * FROM contact_message_events').all(), t.db.prepare("SELECT * FROM audit_log WHERE entity_type='contact_message'").all(), t.logs]);
    expect(journal).not.toMatch(/confidentiel|prospect@example|lucie@example/);
  });

  it('Toolbox inactive : aucune passe', async () => {
    const t = await setup();
    await t.scheduled();
    t.setClock(DUE);
    expect(await t.dispatcher({ toolbox: () => null }).runScan()).toMatchObject({ skipped: 'inactive' });
    expect(t.sendCalls()).toBe(0);
    expect(t.dispatcher({ toolbox: () => null }).status()).toEqual({ active: false, maxLatenessMinutes: 360 });
  });

  it('brouillon distant absent (validé pendant une déconnexion) : créé par le dispatcher puis envoyé', async () => {
    const t = await setup();
    const s = await t.scheduled('p1', 'contact', DUE, false);
    expect(s.remote_draft_id).toBeNull();
    t.setClock(DUE);
    expect(await t.dispatcher().runScan()).toMatchObject({ sent: 1 });
    expect(t.reload(s.id)).toMatchObject({ status: 'sent' });
    expect(t.events(s.id)).toContain('remote_draft_created');
    expect(t.sendCalls()).toBe(1);
  });

  it('retard au-delà de la tolérance (serveur éteint) : pas d’envoi tardif, retour à Validé pour revue humaine', async () => {
    const t = await setup();
    const s = await t.scheduled();
    t.setClock(plus(DUE, CONFIG.maxLatenessMs + 1));
    expect(await t.dispatcher().runScan()).toMatchObject({ overdue: 1, sent: 0 });
    expect(t.sendCalls()).toBe(0);
    expect(t.reload(s.id)).toMatchObject({ status: 'validated', scheduled_at: null, last_error_code: 'dispatch_overdue', dispatch_claim_id: null });
    expect(t.events(s.id).at(-1)).toBe('send_failed');
    // Reprogrammation humaine : diagnostic effacé, envoi à la nouvelle heure.
    const later = plus(DUE, CONFIG.maxLatenessMs + 3600_000);
    const again = t.service.schedule('p1', 'contact', { expected_revision: s.revision, scheduled_at: later.toISOString() }, human).message;
    expect(again).toMatchObject({ status: 'scheduled', last_error_code: null, dispatch_attempts: 0 });
    t.setClock(later);
    expect(await t.dispatcher().runScan()).toMatchObject({ sent: 1 });
  });
});

describe('dispatcher : anti-double-envoi', () => {
  it('deux passes concurrentes du même dispatcher : une seule passe, un seul send_draft', async () => {
    const t = await setup({ fake: {} });
    await t.scheduled();
    t.fake.mode.delayTool = SEND;
    t.fake.mode.delayMs = 150;
    t.setClock(DUE);
    const d = t.dispatcher();
    const [a, b] = await Promise.all([d.runScan(), d.runScan()]);
    expect(a).toBe(b);
    expect(t.sendCalls()).toBe(1);
  });

  it('deux dispatchers (deux connexions sur la même base fichier) : un seul send_draft, l’autre voit le verrou', async () => {
    const t = await setup();
    const s = await t.scheduled();
    const second = openDb(t.file);
    t.fake.mode.delayTool = SEND;
    t.fake.mode.delayMs = 200;
    t.setClock(DUE);
    const [a, b] = await Promise.all([t.dispatcher().runScan(), t.dispatcher({}, second).runScan()]);
    expect(a.sent + b.sent).toBe(1);
    expect(t.sendCalls()).toBe(1);
    expect(t.reload(s.id).status).toBe('sent');
    expect(t.events(s.id).filter(e => e === 'dispatch_claimed')).toHaveLength(1);
  });

  it('redémarrage après verrou (process tué) : jamais relancé ; brouillon présent => revue humaine, disparu => envoyé', async () => {
    const t = await setup();
    const a = await t.scheduled('p1');
    const b = await t.scheduled('p2');
    // Process précédent tué juste après le verrou : pour A avant send_draft, pour B après l'envoi effectif.
    const claim = (id: string, claimId: string) => t.db.prepare('UPDATE contact_messages SET dispatch_claim_id=?,dispatch_claimed_at=?,dispatch_attempts=1 WHERE id=?').run(claimId, DUE.toISOString(), id);
    claim(a.id, 'dead-a');
    claim(b.id, 'dead-b');
    await t.toolbox.sendDraft(t.reload(b.id).remote_draft_id!);
    const callsBefore = t.sendCalls();

    const restarted = t.dispatcher();
    t.setClock(plus(DUE, 60_000)); // verrou récent : peut-être un autre process en plein envoi, on n'y touche pas
    expect(await restarted.runScan()).toMatchObject({ sent: 0, reconciledSent: 0, reconciledNotSent: 0 });
    expect(t.reload(a.id).dispatch_claim_id).toBe('dead-a');
    t.setClock(plus(DUE, CONFIG.claimTtlMs + 1));
    expect(await restarted.runScan()).toMatchObject({ sent: 0, reconciledSent: 1, reconciledNotSent: 1 });
    expect(t.sendCalls()).toBe(callsBefore);
    expect(t.reload(a.id)).toMatchObject({ status: 'validated', last_error_code: 'send_not_confirmed', dispatch_claim_id: null, scheduled_at: null });
    expect(t.reload(b.id)).toMatchObject({ status: 'sent', last_error_code: 'send_reconciled_draft_absent', dispatch_claim_id: 'dead-b' });
    expect(listContactMessageEvents(t.db, b.id).at(-1)).toMatchObject({ event_type: 'sent', details: { reconciled: true } });
    // Plus rien ne part ensuite.
    t.setClock(plus(DUE, 2 * CONFIG.claimTtlMs));
    await restarted.runScan();
    expect(t.sendCalls()).toBe(callsBefore);
  });

  it('liste des brouillons tronquée : absence non probante, verrou conservé', async () => {
    const t = await setup();
    const s = await t.scheduled();
    t.db.prepare('UPDATE contact_messages SET dispatch_claim_id=?,dispatch_claimed_at=? WHERE id=?').run('dead', DUE.toISOString(), s.id);
    const full: MailToolbox = { ...t.toolbox, listDrafts: async () => Array.from({ length: RECONCILE_LIST_LIMIT }, (_, i) => ({ draftId: `other-${i}`, subject: '', date: null })) };
    t.setClock(plus(DUE, CONFIG.claimTtlMs + 1));
    expect(await t.dispatcher({ toolbox: () => full }).runScan()).toMatchObject({ uncertain: 1, reconciledSent: 0 });
    expect(t.reload(s.id)).toMatchObject({ status: 'scheduled', dispatch_claim_id: 'dead', last_error_code: 'send_outcome_unknown' });
    const down: MailToolbox = { ...t.toolbox, listDrafts: async () => { throw new ToolboxError('toolbox_unavailable', 'x'); } };
    expect(await t.dispatcher({ toolbox: () => down }).runScan()).toMatchObject({ deferred: 1 });
    expect(t.sendCalls()).toBe(0);
  });

  it('issue inconnue (timeout pendant send_draft) : jamais rejoué, réconcilié ensuite (envoi effectif => sent)', async () => {
    const t = await setup({ sendTimeoutMs: 1500 });
    const s = await t.scheduled();
    t.fake.mode.delayTool = SEND;
    t.fake.mode.delayMs = 2500; // la Toolbox envoie après l'abandon du client (délai client 1,5 s)
    t.setClock(DUE);
    expect(await t.dispatcher({ toolbox: () => t.shortToolbox }).runScan()).toMatchObject({ uncertain: 1, sent: 0 });
    expect(t.reload(s.id)).toMatchObject({ status: 'scheduled', last_error_code: 'send_outcome_unknown' });
    expect(t.reload(s.id).dispatch_claim_id).not.toBeNull();
    for (let i = 0; i < 100 && t.fake.sent.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 50)); // envoi effectif côté Toolbox
    t.fake.mode.delayTool = undefined;
    const d = t.dispatcher(); // reprise (délai normal)
    t.setClock(plus(DUE, 60_000));
    await d.runScan(); // verrou récent : aucune action
    expect(t.sendCalls()).toBe(1);
    t.setClock(plus(DUE, CONFIG.claimTtlMs + 1));
    expect(await d.runScan()).toMatchObject({ reconciledSent: 1 });
    expect(t.reload(s.id)).toMatchObject({ status: 'sent', last_error_code: 'send_reconciled_draft_absent' });
    expect(t.sendCalls()).toBe(1);
    expect(t.fake.sent).toHaveLength(1);
  }, 15_000);

  it('issue inconnue sans envoi effectif (Toolbox muette) : brouillon toujours présent => revue humaine, aucun renvoi', async () => {
    const t = await setup({ sendTimeoutMs: 1500 });
    const s = await t.scheduled();
    t.fake.mode.hangTool = SEND;
    t.setClock(DUE);
    expect(await t.dispatcher({ toolbox: () => t.shortToolbox }).runScan()).toMatchObject({ uncertain: 1 });
    t.fake.mode.hangTool = undefined;
    const d = t.dispatcher(); // reprise (délai normal)
    t.setClock(plus(DUE, CONFIG.claimTtlMs + 1));
    expect(await d.runScan()).toMatchObject({ reconciledNotSent: 1, sent: 0 });
    expect(t.reload(s.id)).toMatchObject({ status: 'validated', last_error_code: 'send_not_confirmed' });
    expect(t.sendCalls()).toBe(1);
    expect(t.fake.sent).toHaveLength(0);
  }, 15_000);
});

describe('dispatcher : erreurs Toolbox', () => {
  it('refus définitif (brouillon introuvable) : trace send_failed, retour Validé, jamais sent', async () => {
    const t = await setup();
    const s = await t.scheduled();
    t.fake.drafts.clear(); // supprimé depuis le webmail
    t.setClock(DUE);
    expect(await t.dispatcher().runScan()).toMatchObject({ failed: 1, sent: 0 });
    expect(t.reload(s.id)).toMatchObject({ status: 'validated', last_error_code: 'toolbox_draft_not_found', remote_draft_id: null, dispatch_claim_id: null, dispatch_attempts: 1 });
    const failed = listContactMessageEvents(t.db, s.id).at(-1)!;
    expect(failed).toMatchObject({ event_type: 'send_failed', to_status: 'validated', details: { code: 'toolbox_draft_not_found', terminal: true } });
    expect(t.db.prepare("SELECT count(*) n FROM audit_log WHERE entity_id=? AND action='message_send_failed'").get(s.id)).toEqual({ n: 1 });
  });

  it('allowlist à la création du brouillon distant : échec définitif, rien d’envoyé', async () => {
    const t = await setup({ fake: { allowlist: ['@circoe.test'] } });
    const v = t.service.validate('p1', 'contact', t.draft().revision, human).message;
    const s = t.service.schedule('p1', 'contact', { expected_revision: v.revision, scheduled_at: DUE.toISOString() }, human).message;
    t.setClock(DUE);
    expect(await t.dispatcher().runScan()).toMatchObject({ failed: 1 });
    expect(t.reload(s.id)).toMatchObject({ status: 'validated', last_error_code: 'toolbox_outbound_blocked' });
    expect(t.sendCalls()).toBe(0);
  });

  it('erreur transitoire certaine : verrou relâché, backoff, nouvel essai borné, puis succès', async () => {
    const t = await setup();
    const s = await t.scheduled();
    t.fake.mode.httpStatus = 503; // refus dès l'initialisation MCP : rien n'est parti
    t.setClock(DUE);
    const d = t.dispatcher();
    expect(await d.runScan()).toMatchObject({ retrying: 1 });
    expect(t.reload(s.id)).toMatchObject({ status: 'scheduled', dispatch_claim_id: null, last_error_code: 'toolbox_unavailable', dispatch_attempts: 1 });
    t.setClock(plus(DUE, 30_000));
    expect(await d.runScan()).toMatchObject({ deferred: 1 });
    t.fake.mode.httpStatus = undefined;
    t.setClock(plus(DUE, dispatchBackoffMs(1, CONFIG.retryBaseMs)));
    expect(await d.runScan()).toMatchObject({ sent: 1 });
    expect(t.reload(s.id)).toMatchObject({ status: 'sent', dispatch_attempts: 2, last_error_code: null });
    expect(t.events(s.id).filter(e => e === 'send_failed')).toHaveLength(1);
    expect(t.sendCalls()).toBe(1);
  });

  it('tentatives épuisées : retour Validé avec le dernier code', async () => {
    const t = await setup();
    const s = await t.scheduled();
    t.fake.mode.httpStatus = 503;
    const d = t.dispatcher();
    let clock = DUE;
    for (let i = 1; i <= CONFIG.maxAttempts; i++) {
      t.setClock(clock);
      await d.runScan();
      clock = plus(clock, dispatchBackoffMs(i, CONFIG.retryBaseMs));
    }
    expect(t.reload(s.id)).toMatchObject({ status: 'validated', last_error_code: 'toolbox_unavailable', dispatch_attempts: CONFIG.maxAttempts });
    expect(t.fake.sent).toHaveLength(0);
  });

  it('classement : seul un refus Toolbox certain autorise un nouvel essai', () => {
    expect(classifySendError(new ToolboxError('toolbox_unavailable', 'x'))).toEqual({ kind: 'transient', code: 'toolbox_unavailable' });
    expect(classifySendError(new ToolboxError('toolbox_timeout', 'x', { outcomeUnknown: true }))).toEqual({ kind: 'uncertain', code: 'toolbox_timeout' });
    expect(classifySendError(new ToolboxError('toolbox_invalid_response', 'x'))).toEqual({ kind: 'uncertain', code: 'toolbox_invalid_response' });
    expect(classifySendError(new ToolboxError('toolbox_outbound_blocked', 'x'))).toEqual({ kind: 'terminal', code: 'toolbox_outbound_blocked' });
    expect(classifySendError(new Error('boom'))).toEqual({ kind: 'uncertain', code: 'dispatch_internal_error' });
  });
});

describe('dispatcher : annulations et révisions', () => {
  it('réponse reçue avant l’heure : messages annulés, aucun envoi', async () => {
    const t = await setup();
    const s = await t.scheduled();
    t.setClock(plus(DUE, -60_000));
    expect(t.tracking.changeState('p1', 'response_received', human)).toMatchObject({ cancelledMessages: 1, inFlightMessages: 0 });
    t.setClock(DUE);
    await t.dispatcher().runScan();
    expect(t.sendCalls()).toBe(0);
    expect(t.reload(s.id).status).toBe('cancelled');
  });

  it('état prospect fermé sans passer par le hook (écriture concurrente) : revérifié au verrou, annulé, aucun envoi', async () => {
    const t = await setup();
    const s = await t.scheduled();
    t.db.prepare("UPDATE prospects SET contactability_status='do_not_contact' WHERE id='p1'").run();
    t.setClock(DUE);
    expect(await t.dispatcher().runScan()).toMatchObject({ cancelled: 1, sent: 0 });
    expect(t.reload(s.id)).toMatchObject({ status: 'cancelled', cancel_reason: 'do_not_contact' });
    expect(t.sendCalls()).toBe(0);
  });

  it('changement d’état pendant l’envoi (inFlight) : signalé ; si l’envoi échoue, le message est annulé', async () => {
    const t = await setup();
    const s = await t.scheduled();
    let inFlight = -1;
    const racing: MailToolbox = {
      ...t.toolbox,
      sendDraft: async () => {
        inFlight = t.tracking.changeState('p1', 'appointment_obtained', human).inFlightMessages;
        throw new ToolboxError('toolbox_unavailable', 'x');
      }
    };
    t.setClock(DUE);
    expect(await t.dispatcher({ toolbox: () => racing }).runScan()).toMatchObject({ retrying: 1, cancelled: 1 });
    expect(inFlight).toBe(1);
    expect(t.reload(s.id)).toMatchObject({ status: 'cancelled', dispatch_claim_id: null });
    expect(t.fake.sent).toHaveLength(0);
  });

  it('édition après programmation : l’ancienne révision ne part jamais', async () => {
    const t = await setup();
    const s = await t.scheduled();
    const oldDraft = s.remote_draft_id!;
    const edited = t.service.saveMessage('p1', 'contact', { expected_revision: s.revision, body_text: 'Nouveau corps' }, human).message;
    expect(edited.status).toBe('draft');
    t.service.validate('p1', 'contact', edited.revision, human);
    t.setClock(DUE);
    await t.dispatcher().runScan();
    expect(t.sendCalls()).toBe(0);
    expect(t.db.prepare('SELECT remote_draft_id,reason FROM contact_message_remote_draft_cleanups').all()).toEqual([{ remote_draft_id: oldDraft, reason: 'edited' }]);
  });

  it('édition pendant la création du brouillon distant par le dispatcher : révision périmée, aucun verrou ni envoi', async () => {
    const t = await setup();
    const s = await t.scheduled('p1', 'contact', DUE, false);
    const racingDrafts = {
      createDraft: async (message: Parameters<ReturnType<typeof toolboxRemoteDrafts>['createDraft']>[0]) => {
        const ref = await toolboxRemoteDrafts(t.toolbox).createDraft(message);
        t.service.saveMessage('p1', 'contact', { expected_revision: s.revision, subject: 'Objet modifié' }, human);
        return ref;
      }
    };
    t.setClock(DUE);
    expect(await t.dispatcher({ remoteDrafts: () => racingDrafts }).runScan()).toMatchObject({ sent: 0 });
    expect(t.reload(s.id)).toMatchObject({ status: 'draft', dispatch_claim_id: null });
    expect(t.sendCalls()).toBe(0);
  });

  it('verrou posé : déprogrammer, annuler ou éditer refusés (envoi en cours)', async () => {
    const t = await setup();
    const s = await t.scheduled();
    t.db.prepare('UPDATE contact_messages SET dispatch_claim_id=?,dispatch_claimed_at=? WHERE id=?').run('live', DUE.toISOString(), s.id);
    for (const action of [
      () => t.service.unschedule('p1', 'contact', s.revision, human),
      () => t.service.cancel('p1', 'contact', s.revision, human),
      () => t.service.saveMessage('p1', 'contact', { expected_revision: s.revision, body_text: 'x' }, human)
    ]) expect(action).toThrow(/Envoi en cours/);
  });
});

describe('configuration et démarrage', () => {
  it('lecture de l’environnement bornée ; verrou toujours > 2 x délai Toolbox', () => {
    expect(contactDispatchConfigFromEnv({}, { toolboxTimeoutMs: 20_000 })).toEqual({ intervalMs: 30_000, maxLatenessMs: 6 * 3600_000, claimTtlMs: 600_000, maxAttempts: 5, retryBaseMs: 60_000, batchSize: 100 });
    expect(contactDispatchConfigFromEnv({ CONTACT_DISPATCH_INTERVAL_MS: '0' }, { toolboxTimeoutMs: 20_000 }).intervalMs).toBe(0);
    expect(contactDispatchConfigFromEnv({ CONTACT_DISPATCH_INTERVAL_MS: '10', CONTACT_DISPATCH_CLAIM_TTL_MS: '1000' }, { toolboxTimeoutMs: 5_000 })).toMatchObject({ intervalMs: 500, claimTtlMs: 10_000 });
  });
  it('start/stop : scan périodique, arrêt propre ; intervalle 0 = jamais démarré', async () => {
    const t = await setup();
    const off = t.dispatcher();
    off.start();
    expect(off.status().active).toBe(false);
    const d = t.dispatcher({ config: { ...CONFIG, intervalMs: 20 } });
    await t.scheduled();
    t.setClock(DUE);
    d.start();
    expect(d.status().active).toBe(true);
    for (let i = 0; i < 100 && t.sendCalls() === 0; i++) await new Promise(resolve => setTimeout(resolve, 20));
    await d.stop();
    expect(d.status().active).toBe(false);
    expect(t.sendCalls()).toBe(1);
  });
});

describe('panneau mail : état d’envoi', () => {
  const msg = (over: Partial<ContactMessage> = {}): ContactMessage => ({
    id: 'm1', step: 'contact', status: 'scheduled', from_email: 'hello@viper.test', subject: 'Bonjour', body_text: 'Corps',
    to_recipients: ['alice@acme.test'], cc_recipients: [], bcc_recipients: [], revision: 1, scheduled_at: '2026-10-05T07:30:00Z', validated_at: '2026-09-29T10:00:00Z',
    sent_at: null, cancelled_at: null, cancel_reason: null, dispatch_claim_id: null, updated_at: '2026-09-29T10:00:00Z', remote_draft_id: 'd1', ...over
  });
  const active = { active: true, maxLatenessMinutes: 360 };
  it('lignes lisibles selon l’état', () => {
    expect(dispatchStatusLines(msg(), active)).toEqual(['Brouillon prêt dans Infomaniak.']);
    expect(dispatchStatusLines(msg({ remote_draft_id: null }), undefined)[0]).toMatch(/Envoi automatique inactif/);
    expect(dispatchStatusLines(msg({ dispatch_claim_id: 'c' }), active)).toEqual(['Envoi en cours.']);
    expect(dispatchStatusLines(msg({ dispatch_claim_id: 'c', last_error_code: 'send_outcome_unknown' }), active)[0]).toMatch(/jamais renvoyé automatiquement/);
    expect(dispatchStatusLines(msg({ last_error_code: 'toolbox_unavailable' }), active)[0]).toMatch(/injoignable.*Nouvel essai/);
    expect(dispatchStatusLines(msg({ status: 'validated', scheduled_at: null, last_error_code: 'dispatch_overdue' }), active)[0]).toMatch(/Envoi non effectué.*reprogrammez/);
    expect(dispatchStatusLines(msg({ status: 'sent', sent_at: '2026-10-05T07:30:00Z', last_error_code: 'send_reconciled_draft_absent' }), active)[0]).toMatch(/après vérification/);
    expect(dispatchStatusLines(msg({ status: 'sent', sent_at: '2026-10-05T07:30:00Z' }), active)).toEqual([]);
    expect(stateChangeNotice({ tracking: { status: 'response_received' }, stateChanged: true, doNotContactReinforced: false, cancelledMessages: 0, inFlightMessages: 1 }, { year: null, week: null }))
      .toMatch(/déjà en cours d’envoi/);
  });
  it('confirmation de programmation pilotée par l’état réel du serveur', () => {
    const at = { at: new Date(2026, 9, 5, 9, 30), zone: 'Europe/Paris, UTC+02:00' };
    expect(actionConfirmation('schedule', 'contact', at, active).lines.join(' ')).toMatch(/partira automatiquement.*6 heures/);
    expect(actionConfirmation('schedule', 'contact', at, { active: false, maxLatenessMinutes: 360 }).lines.join(' ')).toMatch(/aucun mail ne partira/);
  });
  it('rendu : état d’envoi affiché sous le statut', () => {
    const data: ProspectMessagesResponse = {
      prospect: { id: 'p1', state: 'neutral', do_not_contact: false, sequence_closed: false },
      defaults: { from_email: 'hello@viper.test', to: ['alice@acme.test'] },
      messages: [{ step: 'contact', message: msg({ last_error_code: 'toolbox_timeout' }) }, { step: 'r1', message: null }, { step: 'r2', message: null }],
      dispatch: active
    };
    const html = renderToStaticMarkup(createElement(MailEditor, {
      prospectId: 'p1', step: 'contact', data, localForm: undefined, onLocalForm: () => undefined, conflictForm: undefined, onConflict: () => undefined,
      onMessage: () => undefined, onReload: () => undefined
    }));
    expect(html).toContain('Programmé pour le');
    expect(html).toContain('trop de temps à répondre');
    expect(html).toContain('Brouillon prêt dans Infomaniak.');
  });
});
