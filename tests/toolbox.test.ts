import { afterAll, afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { schema } from '../src/server/schema.js';
import { migrateContactMessages } from '../src/server/contactMessageSchema.js';
import { contactMessageCanceller, getContactMessageById } from '../src/server/contactMessageStore.js';
import { createContactTrackingService } from '../src/server/contactTrackingService.js';
import { createContactMessageService, noRemoteDrafts } from '../src/server/contactMessageService.js';
import { createFileTokenStore, createMemoryTokenStore, createToolboxAuth, type ToolboxTokenStore } from '../src/server/toolboxAuth.js';
import { classifyToolError, createMcpMailToolbox, ToolboxError, type MailToolbox } from '../src/server/toolboxMcpClient.js';
import {
  callbackReturnPath, cleanupBackoffMs, createToolboxIntegration, processRemoteDraftCleanups, TOOLBOX_PROVIDER, toolboxSettingsFromEnv,
  type ToolboxIntegration, type ToolboxSettings
} from '../src/server/toolboxIntegration.js';
import { readToolboxCallback, toolboxPanelModel, withoutToolboxCallback, type ToolboxStatusView } from '../src/client/toolboxModel.js';
import { ToolboxStatusPanel } from '../src/client/ToolboxSettings.js';
import { startFakeToolbox, type FakeToolbox, type FakeToolboxOptions } from './support/fakeToolbox.js';

const human = { type: 'human' as const, id: 'pilot-user', display: 'Commercial VIPER' };
const REDIRECT = 'http://localhost:5999/api/toolbox/oauth/callback';
const NOW = new Date('2026-09-29T08:00:00.000Z');

const fakes: FakeToolbox[] = [];
const dirs: string[] = [];
const dbs: Database.Database[] = [];
afterEach(async () => { while (fakes.length) await fakes.pop()!.close(); });
afterAll(() => {
  for (const db of dbs) db.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
const tmpDir = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-toolbox-')); dirs.push(dir); return dir; };
async function fakeToolbox(options: FakeToolboxOptions = {}) { const fake = await startFakeToolbox(options); fakes.push(fake); return fake; }

/** Simule le navigateur : /authorize du faux serveur (utilisateur consentant) puis retour sur la redirect_uri. */
async function authorize(authorizationUrl: string): Promise<Record<string, string>> {
  const res = await fetch(authorizationUrl, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const back = new URL(res.headers.get('location')!);
  expect(`${back.origin}${back.pathname}`).toBe(REDIRECT);
  return Object.fromEntries(back.searchParams);
}
async function connectedAuth(fake: FakeToolbox, store: ToolboxTokenStore = createMemoryTokenStore(), timeoutMs = 2000) {
  const auth = createToolboxAuth({ mcpUrl: fake.mcpUrl, redirectUri: REDIRECT, tokenStorePath: 'unused', timeoutMs }, { store });
  const { authorizationUrl } = await auth.start(human);
  expect(await auth.complete(await authorize(authorizationUrl))).toEqual({ ok: true });
  return auth;
}
async function connectedToolbox(fake: FakeToolbox, timeoutMs = 2000) {
  const store = createMemoryTokenStore();
  const auth = await connectedAuth(fake, store, timeoutMs);
  return { auth, store, toolbox: createMcpMailToolbox({ mcpUrl: fake.mcpUrl, tokens: auth.tokens, timeoutMs }) };
}
const draftInput = { to: ['prospect@example.test'], subject: 'Objet', text: 'Bonjour' };
async function expectToolboxError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(ToolboxError);
  expect((error as ToolboxError).code).toBe(code);
  return error as ToolboxError;
}

describe('configuration Toolbox', () => {
  const storageDir = path.join(os.tmpdir(), 'viper-storage');
  const env = { TOOLBOX_MAIL_ENABLED: 'true', TOOLBOX_MCP_URL: 'https://toolbox.example.test/mcp', TOOLBOX_OAUTH_REDIRECT_URI: REDIRECT };
  it('désactivée par défaut, sans exiger de configuration', () => {
    expect(toolboxSettingsFromEnv({}, { storageDir })).toMatchObject({ enabled: false, config: null });
    expect(toolboxSettingsFromEnv({ ...env, TOOLBOX_MAIL_ENABLED: 'false' }, { storageDir }).enabled).toBe(false);
  });
  it('configuration complète : jetons hors dépôt, défauts bornés', () => {
    const settings = toolboxSettingsFromEnv(env, { storageDir, checkoutDir: process.cwd() });
    expect(settings.missing).toEqual([]);
    expect(settings.config).toMatchObject({ mcpUrl: env.TOOLBOX_MCP_URL, redirectUri: REDIRECT, timeoutMs: 20000, cleanupIntervalMs: 60000, tokenStorePath: path.join(storageDir, 'toolbox-oauth.json') });
  });
  it('variables manquantes ou dangereuses nommées sans valeur', () => {
    const settings = toolboxSettingsFromEnv({ TOOLBOX_MAIL_ENABLED: '1', TOOLBOX_MCP_URL: 'http://toolbox.example.test/mcp', TOOLBOX_OAUTH_REDIRECT_URI: '', TOOLBOX_TOKEN_STORE_PATH: path.join(process.cwd(), 'data', 'tokens.json') }, { storageDir, checkoutDir: process.cwd() });
    expect(settings.config).toBeNull();
    expect(settings.missing).toEqual(['TOOLBOX_MCP_URL', 'TOOLBOX_OAUTH_REDIRECT_URI', 'TOOLBOX_TOKEN_STORE_PATH']);
  });
  it('retour OAuth : chemin relatif, codes seulement', () => {
    expect(callbackReturnPath({ ok: true })).toBe('/?toolbox=connected');
    expect(callbackReturnPath({ ok: false, code: 'toolbox_state_invalid' })).toBe('/?toolbox=error&code=toolbox_state_invalid');
  });
});

describe('OAuth 2.1 + PKCE vers la Toolbox (faux serveur)', () => {
  it('découverte, enregistrement dynamique, autorisation S256 avec resource et scope mail, échange du code', async () => {
    const fake = await fakeToolbox();
    const store = createMemoryTokenStore();
    const auth = createToolboxAuth({ mcpUrl: fake.mcpUrl, redirectUri: REDIRECT, tokenStorePath: 'unused' }, { store });
    const { authorizationUrl } = await auth.start(human);
    const url = new URL(authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${fake.origin}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'code', code_challenge_method: 'S256', scope: 'mail', resource: fake.mcpUrl, redirect_uri: REDIRECT });
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fake.registrations).toEqual([{ client_name: 'VIPER', redirect_uris: [REDIRECT] }]);
    expect(auth.status().state).toBe('disconnected');
    expect(await auth.complete(await authorize(authorizationUrl))).toEqual({ ok: true });
    const status = auth.status();
    expect(status).toMatchObject({ state: 'connected', connectedBy: 'Commercial VIPER', refreshable: false, scope: 'mail' });
    expect(JSON.stringify(status)).not.toMatch(/at-\d/);
    // Client enregistré réutilisé à la connexion suivante.
    await auth.start(human);
    expect(fake.registrations).toHaveLength(1);
  });

  it('state inconnu, rejoué ou émetteur différent : refus sans jeton', async () => {
    const fake = await fakeToolbox();
    const store = createMemoryTokenStore();
    const auth = createToolboxAuth({ mcpUrl: fake.mcpUrl, redirectUri: REDIRECT, tokenStorePath: 'unused' }, { store });
    expect(await auth.complete({ state: 'forged', code: 'x' })).toEqual({ ok: false, code: 'toolbox_state_invalid' });
    const first = await authorize((await auth.start(human)).authorizationUrl);
    expect(await auth.complete({ ...first, iss: 'https://evil.example.test' })).toEqual({ ok: false, code: 'toolbox_issuer_mismatch' });
    expect(await auth.complete(first)).toEqual({ ok: false, code: 'toolbox_state_invalid' }); // usage unique
    const second = await authorize((await auth.start(human)).authorizationUrl);
    const withoutIss: Record<string, string> = { ...second };
    delete withoutIss.iss;
    expect(await auth.complete(withoutIss)).toEqual({ ok: false, code: 'toolbox_issuer_mismatch' }); // RFC 9207 annoncé => obligatoire
    const third = (await auth.start(human)).authorizationUrl;
    expect(await auth.complete({ state: new URL(third).searchParams.get('state')!, error: 'access_denied' })).toEqual({ ok: false, code: 'toolbox_access_denied' });
    expect(store.snapshot().token).toBeUndefined();
  });

  it('URL MCP différente de la ressource annoncée : non configurée', async () => {
    const fake = await fakeToolbox();
    const auth = createToolboxAuth({ mcpUrl: `${fake.origin}/autre`, redirectUri: REDIRECT, tokenStorePath: 'unused' }, { store: createMemoryTokenStore() });
    await expectToolboxError(auth.start(human), 'toolbox_not_configured');
  });

  it('stockage fichier privé hors base, relu après redémarrage', async () => {
    const fake = await fakeToolbox();
    const file = path.join(tmpDir(), 'secrets', 'toolbox-oauth.json');
    await connectedAuth(fake, createFileTokenStore(file));
    const content = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(content.token.accessToken).toMatch(/^at-/);
    const restarted = createToolboxAuth({ mcpUrl: fake.mcpUrl, redirectUri: REDIRECT, tokenStorePath: file }, { store: createFileTokenStore(file) });
    expect(restarted.status().state).toBe('connected');
    restarted.disconnect();
    expect(restarted.status().state).toBe('disconnected');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).client.clientId).toBeTruthy();
  });

  it('jeton expiré : rafraîchi si le serveur le permet, sinon « à reconnecter »', async () => {
    const withRefresh = await fakeToolbox({ refresh: true, tokenTtlSec: 1 });
    let clock = new Date();
    const store = createMemoryTokenStore();
    const auth = createToolboxAuth({ mcpUrl: withRefresh.mcpUrl, redirectUri: REDIRECT, tokenStorePath: 'unused' }, { store, now: () => clock });
    expect(await auth.complete(await authorize((await auth.start(human)).authorizationUrl))).toEqual({ ok: true });
    expect(auth.status().refreshable).toBe(true);
    const first = store.snapshot().token!.accessToken;
    clock = new Date(clock.getTime() + 5000);
    const toolbox = createMcpMailToolbox({ mcpUrl: withRefresh.mcpUrl, tokens: auth.tokens, timeoutMs: 2000 });
    expect((await toolbox.createDraft(draftInput)).draftId).toMatch(/^draft-/);
    expect(store.snapshot().token!.accessToken).not.toBe(first);
    expect(withRefresh.tokenRequests.map(r => r.grant_type)).toEqual(['authorization_code', 'refresh_token']);

    const noRefresh = await fakeToolbox({ tokenTtlSec: 1 });
    let clock2 = new Date();
    const store2 = createMemoryTokenStore();
    const auth2 = createToolboxAuth({ mcpUrl: noRefresh.mcpUrl, redirectUri: REDIRECT, tokenStorePath: 'unused' }, { store: store2, now: () => clock2 });
    await auth2.complete(await authorize((await auth2.start(human)).authorizationUrl));
    clock2 = new Date(clock2.getTime() + 5000);
    expect(auth2.status().state).toBe('expired');
    const toolbox2 = createMcpMailToolbox({ mcpUrl: noRefresh.mcpUrl, tokens: auth2.tokens, timeoutMs: 2000 });
    await expectToolboxError(toolbox2.createDraft(draftInput), 'toolbox_auth_required');
    expect(noRefresh.calls).toHaveLength(0);
  });

  it('401 de la Toolbox : un rafraîchissement puis nouvel essai ; sans refresh, connexion marquée à reconnecter', async () => {
    const withRefresh = await fakeToolbox({ refresh: true });
    const a = await connectedToolbox(withRefresh);
    withRefresh.revokeAll();
    expect((await a.toolbox.createDraft(draftInput)).draftId).toMatch(/^draft-/);
    expect(withRefresh.tokenRequests.map(r => r.grant_type)).toEqual(['authorization_code', 'refresh_token']);

    const plain = await fakeToolbox();
    const b = await connectedToolbox(plain);
    plain.revokeAll();
    await expectToolboxError(b.toolbox.createDraft(draftInput), 'toolbox_auth_required');
    expect(b.auth.status().state).toBe('expired');
    expect(plain.tokenRequests.map(r => r.grant_type)).toEqual(['authorization_code']);
  });
});

describe('MailToolbox MCP (faux serveur)', () => {
  it('create/list/send/delete avec les schémas Toolbox, via initialize puis tools/call', async () => {
    const fake = await fakeToolbox();
    const { toolbox } = await connectedToolbox(fake);
    const { draftId } = await toolbox.createDraft({ ...draftInput, cc: [], bcc: ['archive@example.test'] });
    expect(fake.drafts.get(draftId)).toEqual({ to: ['prospect@example.test'], cc: [], bcc: ['archive@example.test'], subject: 'Objet', text: 'Bonjour' });
    expect(fake.calls.slice(0, 3).map(c => c.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    expect(fake.calls[2].tool).toBe('infomaniak.mail.create_draft');
    expect(await toolbox.listDrafts()).toEqual([{ draftId, subject: 'Objet', date: null }]);
    expect(await toolbox.sendDraft(draftId)).toEqual({ draftId, transport: 'api', etop: null, cancelResource: null });
    expect(fake.sent).toEqual([draftId]);
    await expectToolboxError(toolbox.sendDraft(draftId), 'toolbox_draft_not_found');
    const second = (await toolbox.createDraft(draftInput)).draftId;
    expect(await toolbox.deleteDraft(second)).toEqual({ deleted: true });
    expect(await toolbox.deleteDraft(second)).toEqual({ deleted: false }); // idempotent
  });

  it('réponses SSE acceptées', async () => {
    const fake = await fakeToolbox({ sse: true });
    const { toolbox } = await connectedToolbox(fake);
    expect((await toolbox.createDraft(draftInput)).draftId).toMatch(/^draft-/);
  });

  it('erreurs typées : non connectée, allowlist, 5xx, entrée invalide, sortie inattendue', async () => {
    const fake = await fakeToolbox({ allowlist: ['@circoe.test'] });
    const disconnected = createMcpMailToolbox({ mcpUrl: fake.mcpUrl, tokens: { accessToken: async () => null, refreshAfterUnauthorized: async () => null } });
    await expectToolboxError(disconnected.createDraft(draftInput), 'toolbox_auth_required');
    expect(fake.calls).toHaveLength(0);

    const { toolbox } = await connectedToolbox(fake);
    const blocked = await expectToolboxError(toolbox.createDraft(draftInput), 'toolbox_outbound_blocked');
    expect(blocked.message).not.toContain('prospect@example.test'); // texte amont jamais recopié
    const before = fake.calls.length;
    await expectToolboxError(toolbox.createDraft({ ...draftInput, subject: 'x'.repeat(501) }), 'toolbox_invalid_input');
    await expectToolboxError(toolbox.createDraft({ ...draftInput, to: [] }), 'toolbox_invalid_input');
    expect(fake.calls.length).toBe(before);

    fake.mode.httpStatus = 503;
    const unavailable = await expectToolboxError(toolbox.createDraft({ ...draftInput, to: ['a@circoe.test'] }), 'toolbox_unavailable');
    expect(unavailable.retryable).toBe(true);
    fake.mode.httpStatus = undefined;
    fake.mode.toolErrorText = 'Paramètres invalides pour infomaniak.mail.create_draft';
    await expectToolboxError(toolbox.createDraft({ ...draftInput, to: ['a@circoe.test'] }), 'toolbox_invalid_input');
  });

  it('timeout : erreur typée, issue inconnue signalée pour send_draft', async () => {
    const fake = await fakeToolbox();
    const { toolbox } = await connectedToolbox(fake, 300);
    const { draftId } = await toolbox.createDraft(draftInput);
    fake.mode.hangTool = 'infomaniak.mail.send_draft';
    const error = await expectToolboxError(toolbox.sendDraft(draftId), 'toolbox_timeout');
    expect(error.outcomeUnknown).toBe(true);
    fake.mode.hangTool = 'infomaniak.mail.create_draft';
    expect((await expectToolboxError(toolbox.createDraft(draftInput), 'toolbox_timeout')).outcomeUnknown).toBe(false);
  });

  it('classement des textes d\'erreur Toolbox', () => {
    expect(classifyToolError('Brouillon introuvable : d1')).toBe('toolbox_draft_not_found');
    expect(classifyToolError('L\'API Infomaniak Mail a répondu 404 : …')).toBe('toolbox_draft_not_found');
    expect(classifyToolError('L\'API Infomaniak Mail a répondu 401 : …')).toBe('toolbox_auth_required');
    expect(classifyToolError('L\'API Infomaniak Mail a répondu 502 : …')).toBe('toolbox_unavailable');
    expect(classifyToolError('Ce brouillon n\'a aucun destinataire')).toBe('toolbox_rejected');
  });
});

describe('brouillon distant des messages et file de suppression', () => {
  function setupDb() {
    const db = new Database(path.join(tmpDir(), 'viper.sqlite'));
    dbs.push(db);
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    migrateContactMessages(db);
    db.prepare("INSERT INTO companies(id,display_name) VALUES('c1','Synthetic Co')").run();
    db.prepare("INSERT INTO prospects(id,company_id,first_name,last_name,contactability_status) VALUES('p1','c1','P','Test','contactable')").run();
    db.prepare("INSERT INTO emails(id,prospect_id,address,is_primary) VALUES('e1','p1','prospect@example.test',1)").run();
    createContactTrackingService(db, { now: () => NOW, cancelFutureMessages: contactMessageCanceller }).applyProspectPayload('p1', {}, human);
    return db;
  }
  const settingsFor = (fake: FakeToolbox | null, enabled = true): ToolboxSettings => ({
    enabled, missing: [],
    config: fake ? { mcpUrl: fake.mcpUrl, redirectUri: REDIRECT, tokenStorePath: 'unused', timeoutMs: 2000, cleanupIntervalMs: 0 } : null
  });
  const logs: string[] = [];
  async function connectedIntegration(fake: FakeToolbox, db: Database.Database) {
    const integration = createToolboxIntegration({ getDb: () => db, settings: settingsFor(fake), store: createMemoryTokenStore(), log: line => logs.push(line) });
    const { authorizationUrl } = await integration.startAuthorization(human);
    expect(await integration.completeAuthorization(await authorize(authorizationUrl))).toEqual({ ok: true });
    return integration;
  }
  const serviceWith = (db: Database.Database, integration: ToolboxIntegration) =>
    createContactMessageService(db, { now: () => NOW, defaultFromEmail: 'lucie@example.test', remoteDrafts: integration.remoteDrafts() });

  it('flag désactivé : port no-op, aucun appel, comportement inchangé', async () => {
    const db = setupDb();
    const integration = createToolboxIntegration({ getDb: () => db, settings: { enabled: false, config: null, missing: [] }, store: createMemoryTokenStore() });
    expect(integration.remoteDrafts()).toBe(noRemoteDrafts);
    expect(integration.mailToolbox()).toBeNull();
    expect(integration.status()).toMatchObject({ enabled: false, state: 'disabled', connection: null });
    expect(await integration.runCleanups()).toBeNull();
    await expectToolboxError(integration.startAuthorization(human), 'toolbox_not_configured');
    expect(await integration.completeAuthorization({ state: 'x' })).toEqual({ ok: false, code: 'toolbox_not_configured' });
    const service = serviceWith(db, integration);
    const m = service.saveMessage('p1', 'contact', { subject: 'Objet', body_text: 'Bonjour' }, human).message;
    const validated = service.validate('p1', 'contact', m.revision, human).message;
    expect(await service.syncRemoteDraft(validated.id, human)).toEqual({ status: 'disabled' });
  });

  it('activée mais non connectée : état « à connecter », port no-op', async () => {
    const fake = await fakeToolbox();
    const db = setupDb();
    const integration = createToolboxIntegration({ getDb: () => db, settings: settingsFor(fake), store: createMemoryTokenStore() });
    expect(integration.status()).toMatchObject({ enabled: true, state: 'disconnected', toolboxOrigin: fake.origin });
    expect(integration.remoteDrafts()).toBe(noRemoteDrafts);
    const notConfigured = createToolboxIntegration({ getDb: () => db, settings: { enabled: true, config: null, missing: ['TOOLBOX_MCP_URL'] } });
    expect(notConfigured.status()).toMatchObject({ state: 'not_configured', missing: ['TOOLBOX_MCP_URL'] });
  });

  it('validation => brouillon Infomaniak créé et id stocké ; brouillon local non validé => rien', async () => {
    const fake = await fakeToolbox();
    const db = setupDb();
    const integration = await connectedIntegration(fake, db);
    expect(integration.status().state).toBe('connected');
    const service = serviceWith(db, integration);
    const m = service.saveMessage('p1', 'contact', { subject: 'Objet', body_text: 'Bonjour', cc: ['copie@example.test'] }, human).message;
    expect(fake.drafts.size).toBe(0); // un draft local ne crée rien chez Infomaniak
    const validated = service.validate('p1', 'contact', m.revision, human).message;
    expect(await service.syncRemoteDraft(validated.id, human)).toEqual({ status: 'created', provider: TOOLBOX_PROVIDER });
    const stored = getContactMessageById(db, validated.id)!;
    expect(stored.remote_provider).toBe(TOOLBOX_PROVIDER);
    expect(fake.drafts.get(stored.remote_draft_id!)).toEqual({ to: ['prospect@example.test'], cc: ['copie@example.test'], bcc: [], subject: 'Objet', text: 'Bonjour' });
    expect(await service.syncRemoteDraft(validated.id, human)).toEqual({ status: 'already_present' });
    expect(fake.drafts.size).toBe(1);
  });

  it('échec Toolbox à la validation : statut conservé, code seulement', async () => {
    const fake = await fakeToolbox({ allowlist: ['@circoe.test'] });
    const db = setupDb();
    const integration = await connectedIntegration(fake, db);
    const service = serviceWith(db, integration);
    const m = service.saveMessage('p1', 'contact', { subject: 'Objet', body_text: 'Bonjour' }, human).message;
    const validated = service.validate('p1', 'contact', m.revision, human).message;
    expect(await service.syncRemoteDraft(validated.id, human)).toEqual({ status: 'failed', code: 'toolbox_outbound_blocked' });
    expect(getContactMessageById(db, validated.id)).toMatchObject({ status: 'validated', remote_draft_id: null });
  });

  it('édition puis annulation : brouillons mis en file puis supprimés chez Infomaniak ; revalidation => nouveau brouillon', async () => {
    const fake = await fakeToolbox();
    const db = setupDb();
    const integration = await connectedIntegration(fake, db);
    const service = serviceWith(db, integration);
    let m = service.saveMessage('p1', 'contact', { subject: 'Objet', body_text: 'Bonjour' }, human).message;
    m = service.validate('p1', 'contact', m.revision, human).message;
    await service.syncRemoteDraft(m.id, human);
    const firstDraft = getContactMessageById(db, m.id)!.remote_draft_id!;
    const edited = service.saveMessage('p1', 'contact', { expected_revision: m.revision, body_text: 'Bonjour modifié' }, human);
    expect(edited).toMatchObject({ unvalidated: true, remoteDraftQueued: true });
    expect(await integration.runCleanups()).toMatchObject({ processed: 1, deleted: 1, failed: 0, blocked: null });
    expect(fake.drafts.has(firstDraft)).toBe(false);
    expect(db.prepare('SELECT reason,completed_at IS NOT NULL done,attempts FROM contact_message_remote_draft_cleanups').all()).toEqual([{ reason: 'edited', done: 1, attempts: 1 }]);

    m = service.validate('p1', 'contact', edited.message.revision, human).message;
    await service.syncRemoteDraft(m.id, human);
    const secondDraft = getContactMessageById(db, m.id)!.remote_draft_id!;
    expect(secondDraft).not.toBe(firstDraft);
    expect(fake.drafts.get(secondDraft)?.text).toBe('Bonjour modifié');
    service.cancel('p1', 'contact', m.revision, human);
    expect(await integration.runCleanups()).toMatchObject({ processed: 1, deleted: 1 });
    expect(fake.drafts.size).toBe(0);
    expect(logs.join('\n')).not.toMatch(/at-\d|prospect@example\.test|Bonjour/);
  });

  it('file : brouillon déjà absent = terminé ; auth perdue = lot interrompu sans tentative ; échec => backoff ; id rattaché jamais supprimé', async () => {
    const fake = await fakeToolbox();
    const db = setupDb();
    const { toolbox } = await connectedToolbox(fake);
    let clock = NOW;
    const queue = (id: string, draftId: string, messageId: string | null = null) => db.prepare("INSERT INTO contact_message_remote_draft_cleanups(id,message_id,remote_provider,remote_draft_id,reason,created_at) VALUES(?,?,?,?,'cancelled',?)")
      .run(id, messageId, TOOLBOX_PROVIDER, draftId, clock.toISOString());
    queue('q1', 'draft-absent');
    expect(await processRemoteDraftCleanups(db, toolbox, { now: () => clock })).toMatchObject({ processed: 1, alreadyAbsent: 1 });

    queue('q2', 'draft-x');
    const lost: MailToolbox = { ...toolbox, deleteDraft: async () => { throw new ToolboxError('toolbox_auth_required', 'x'); } };
    expect(await processRemoteDraftCleanups(db, lost, { now: () => clock })).toMatchObject({ processed: 0, blocked: 'toolbox_auth_required' });
    expect(db.prepare("SELECT attempts,last_error_code FROM contact_message_remote_draft_cleanups WHERE id='q2'").get()).toEqual({ attempts: 0, last_error_code: null });

    const down: MailToolbox = { ...toolbox, deleteDraft: async () => { throw new ToolboxError('toolbox_unavailable', 'x'); } };
    expect(await processRemoteDraftCleanups(db, down, { now: () => clock })).toMatchObject({ failed: 1 });
    expect(db.prepare("SELECT attempts,last_error_code FROM contact_message_remote_draft_cleanups WHERE id='q2'").get()).toEqual({ attempts: 1, last_error_code: 'toolbox_unavailable' });
    expect(await processRemoteDraftCleanups(db, toolbox, { now: () => clock })).toMatchObject({ processed: 0, skipped: 1 }); // backoff 30 s
    clock = new Date(NOW.getTime() + cleanupBackoffMs(1));
    expect(await processRemoteDraftCleanups(db, toolbox, { now: () => clock })).toMatchObject({ processed: 1, alreadyAbsent: 1 });

    // Id encore rattaché à un message validé : jamais supprimé.
    const service = createContactMessageService(db, { now: () => clock, defaultFromEmail: 'lucie@example.test' });
    const m = service.saveMessage('p1', 'contact', { subject: 'Objet', body_text: 'Bonjour' }, human).message;
    service.validate('p1', 'contact', m.revision, human);
    const { draftId } = await toolbox.createDraft(draftInput);
    db.prepare('UPDATE contact_messages SET remote_provider=?,remote_draft_id=? WHERE id=?').run(TOOLBOX_PROVIDER, draftId, m.id);
    queue('q3', draftId, m.id);
    expect(await processRemoteDraftCleanups(db, toolbox, { now: () => clock })).toMatchObject({ processed: 0, skipped: 1 });
    expect(fake.drafts.has(draftId)).toBe(true);
    expect(cleanupBackoffMs(0)).toBe(0);
    expect(cleanupBackoffMs(30)).toBe(6 * 3600_000);
  });
});

describe('panneau Paramètres Toolbox', () => {
  const base: ToolboxStatusView = { enabled: true, state: 'disconnected', missing: [], toolboxOrigin: 'https://toolbox.example.test', connection: null, cleanups: { pending: 0, failing: 0 } };
  it('libellés et actions par état', () => {
    expect(toolboxPanelModel({ ...base, enabled: false, state: 'disabled' })).toMatchObject({ label: 'Désactivée', connectLabel: null, canDisconnect: false });
    expect(toolboxPanelModel({ ...base, state: 'not_configured', missing: ['TOOLBOX_MCP_URL'] }).explanation).toContain('TOOLBOX_MCP_URL');
    expect(toolboxPanelModel(base)).toMatchObject({ label: 'À connecter', connectLabel: 'Connecter la Toolbox' });
    expect(toolboxPanelModel({ ...base, state: 'expired' })).toMatchObject({ label: 'À reconnecter', connectLabel: 'Reconnecter la Toolbox', canDisconnect: true });
    expect(toolboxPanelModel({ ...base, state: 'connected' })).toMatchObject({ label: 'Connectée', connectLabel: null, canDisconnect: true });
  });
  it('retour OAuth lu puis retiré de l\'URL', () => {
    expect(readToolboxCallback('?toolbox=connected')).toEqual({ ok: true, message: 'Toolbox connectée.' });
    expect(readToolboxCallback('?toolbox=error&code=toolbox_state_invalid')?.ok).toBe(false);
    expect(readToolboxCallback('?other=1')).toBeNull();
    expect(withoutToolboxCallback('http://localhost:5173/?toolbox=error&code=x&keep=1#h')).toBe('/?keep=1#h');
  });
  it('rendu : bouton de connexion, aucune donnée sensible', () => {
    const html = renderToStaticMarkup(createElement(ToolboxStatusPanel, { status: base, busy: false, notice: null, onConnect: () => {}, onDisconnect: () => {} }));
    expect(html).toContain('Connecter la Toolbox');
    expect(html).toContain('À connecter');
    const connected = renderToStaticMarkup(createElement(ToolboxStatusPanel, {
      status: { ...base, state: 'connected', connection: { connectedAt: NOW.toISOString(), connectedBy: 'Commercial VIPER', expiresAt: null, refreshable: false, scope: 'mail' }, cleanups: { pending: 2, failing: 1 } },
      busy: false, notice: null, onConnect: () => {}, onDisconnect: () => {}
    }));
    expect(connected).toContain('Oublier la connexion');
    expect(connected).toContain('dont 1 en échec');
    expect(connected).not.toContain('Connecter la Toolbox');
  });
});
