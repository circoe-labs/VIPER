import { afterAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../src/server/schema.js';
import { migrateContactMessages } from '../src/server/contactMessageSchema.js';
import { contactMessageCanceller, getContactMessage, listContactMessageEvents } from '../src/server/contactMessageStore.js';
import { createContactTrackingService } from '../src/server/contactTrackingService.js';
import { ContactMessageError, createContactMessageService } from '../src/server/contactMessageService.js';
import {
  createContactMailGenerationService, loadMailGenerationContext, normalizeBookingUrl, parseGenerateRequest, type MailGenerationDeps
} from '../src/server/contactMailGenerationService.js';
import { buildMailInput, buildMailInstructions, buildMailPrompt, MAIL_PROMPT_VERSION, type MailGenerationContext } from '../src/server/mailGenerationPrompt.js';
import {
  AiGenerationError, createOpenAiMailGenerator, missingOpenAiSettings, openAiConfigFromEnv, parseGeneratedMail,
  type MailGeneratorPort, type MailPrompt, type OpenAiConfig
} from '../src/server/openaiMailGenerator.js';

const human = { type: 'human' as const, id: 'pilot-user', display: 'Commercial VIPER' };
const NOW = new Date('2026-09-29T08:00:00.000Z');
const FUTURE = '2026-10-05T07:30:00.000Z';
const KEY = 'sk-test-SECRET-never-logged';

// --- Faux fetch OpenAI ---
const responsesPayload = (text: string, over: Record<string, unknown> = {}) => ({
  id: 'resp_1', object: 'response', status: 'completed', model: 'model-snapshot-1',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], ...over
});
const okJson = (payload: unknown) => new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
const errorJson = (status: number, code: string | null = null, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ error: { message: 'upstream detail', type: 'error_type', code } }), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const validMail = JSON.stringify({ subject: 'Objet généré', body: 'Bonjour Madame Martin,\n\nCorps.' });
type Call = { url: string; init: RequestInit };
function fakeFetch(responses: (Response | Error | 'hang')[]) {
  const calls: Call[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (next === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    }
    if (next instanceof Error) throw next;
    return next.clone();
  }) as typeof fetch;
  return { fn, calls };
}
const config = (over: Partial<OpenAiConfig> = {}): OpenAiConfig => ({ apiKey: KEY, model: 'configured-model', baseUrl: 'https://openai.test/v1', timeoutMs: 1000, maxRetries: 2, ...over });
const prompt: MailPrompt = { instructions: 'instructions', input: 'input' };
function generator(responses: (Response | Error | 'hang')[], over: Partial<OpenAiConfig> = {}) {
  const f = fakeFetch(responses);
  const sleeps: number[] = [];
  const port = createOpenAiMailGenerator(config(over), { fetch: f.fn, sleep: async ms => { sleeps.push(ms); } });
  return { port, calls: f.calls, sleeps };
}
async function expectAiError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, e => e);
  expect(error).toBeInstanceOf(AiGenerationError);
  expect((error as AiGenerationError).code).toBe(code);
  expect(String((error as Error).message)).not.toContain(KEY);
  expect(JSON.stringify(error)).not.toContain(KEY);
  return error as AiGenerationError;
}

describe('configuration OpenAI (env)', () => {
  it('clé et modèle obligatoires, aucun modèle par défaut ; options bornées', () => {
    expect(openAiConfigFromEnv({})).toBeNull();
    expect(openAiConfigFromEnv({ OPENAI_API_KEY: KEY })).toBeNull();
    expect(openAiConfigFromEnv({ OPENAI_MODEL: 'm' })).toBeNull();
    expect(openAiConfigFromEnv({ OPENAI_API_KEY: ' ', OPENAI_MODEL: 'm' })).toBeNull();
    expect(missingOpenAiSettings({ OPENAI_API_KEY: KEY })).toEqual(['OPENAI_MODEL']);
    expect(missingOpenAiSettings({})).toEqual(['OPENAI_API_KEY', 'OPENAI_MODEL']);
    expect(openAiConfigFromEnv({ OPENAI_API_KEY: KEY, OPENAI_MODEL: ' m ' })).toEqual({ apiKey: KEY, model: 'm', baseUrl: 'https://api.openai.com/v1', timeoutMs: 60000, maxRetries: 2 });
    expect(openAiConfigFromEnv({ OPENAI_API_KEY: KEY, OPENAI_MODEL: 'm', OPENAI_BASE_URL: 'http://127.0.0.1:9/v1/', OPENAI_TIMEOUT_MS: '5', OPENAI_MAX_RETRIES: '99' }))
      .toMatchObject({ baseUrl: 'http://127.0.0.1:9/v1', timeoutMs: 1000, maxRetries: 5 });
  });
});

describe('adapter OpenAI (faux fetch, aucun appel réel)', () => {
  it('réponse valide : API Responses, sortie structurée json_schema stricte, store=false, modèle renvoyé', async () => {
    const g = generator([okJson(responsesPayload(validMail))]);
    await expect(g.port.generate(prompt)).resolves.toEqual({ subject: 'Objet généré', body: 'Bonjour Madame Martin,\n\nCorps.', model: 'model-snapshot-1' });
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0].url).toBe('https://openai.test/v1/responses');
    expect((g.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(g.calls[0].init.body));
    expect(body).toMatchObject({ model: 'configured-model', instructions: 'instructions', input: 'input', store: false });
    expect(body.text.format).toMatchObject({ type: 'json_schema', name: 'contact_mail', strict: true, schema: { required: ['subject', 'body'], additionalProperties: false } });
    expect(String(g.calls[0].init.body)).not.toContain(KEY);
  });

  it('modèle absent de la réponse => modèle configuré', async () => {
    const g = generator([okJson(responsesPayload(validMail, { model: undefined }))]);
    expect((await g.port.generate(prompt)).model).toBe('configured-model');
  });

  it('sortie invalide rejetée : JSON illisible, champ manquant, objet multiligne, refus, réponse incomplète', async () => {
    await expectAiError(generator([okJson(responsesPayload('pas du json'))]).port.generate(prompt), 'ai_invalid_output');
    await expectAiError(generator([okJson(responsesPayload(JSON.stringify({ subject: 'x' })))]).port.generate(prompt), 'ai_invalid_output');
    await expectAiError(generator([okJson(responsesPayload(JSON.stringify({ subject: 'a\nb', body: 'c' })))]).port.generate(prompt), 'ai_invalid_output');
    await expectAiError(generator([okJson(responsesPayload(JSON.stringify({ subject: ' ', body: 'c' })))]).port.generate(prompt), 'ai_invalid_output');
    await expectAiError(generator([okJson(responsesPayload(JSON.stringify({ subject: 's', body: 'c', status: 'validated' })))]).port.generate(prompt), 'ai_invalid_output');
    await expectAiError(generator([okJson({ status: 'completed', output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'non' }] }] })]).port.generate(prompt), 'ai_refused');
    await expectAiError(generator([okJson(responsesPayload(validMail, { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }))]).port.generate(prompt), 'ai_invalid_output');
    await expectAiError(generator([new Response('<html>', { status: 200 })]).port.generate(prompt), 'ai_invalid_output');
    expect(() => parseGeneratedMail('{"subject":"s","body":"b"}')).not.toThrow();
  });

  it('timeout : erreur ai_timeout, pas de nouvelle tentative', async () => {
    const g = generator(['hang'], { timeoutMs: 20 });
    await expectAiError(g.port.generate(prompt), 'ai_timeout');
    expect(g.calls).toHaveLength(1);
  });

  it('429 / 5xx / réseau : retries bornés avec backoff (Retry-After respecté) puis succès ou erreur', async () => {
    const ok = generator([errorJson(429, 'rate_limit_exceeded', { 'retry-after': '3' }), errorJson(503), okJson(responsesPayload(validMail))]);
    expect((await ok.port.generate(prompt)).subject).toBe('Objet généré');
    expect(ok.calls).toHaveLength(3);
    expect(ok.sleeps).toEqual([3000, 1000]);

    const down = generator([errorJson(500)]);
    const e = await expectAiError(down.port.generate(prompt), 'ai_upstream_error');
    expect(down.calls).toHaveLength(3); // 1 + OPENAI_MAX_RETRIES (2)
    expect(e.upstreamStatus).toBe(500);

    const limited = generator([errorJson(429, 'rate_limit_exceeded')], { maxRetries: 1 });
    await expectAiError(limited.port.generate(prompt), 'ai_rate_limited');
    expect(limited.calls).toHaveLength(2);

    const network = generator([new TypeError('fetch failed'), okJson(responsesPayload(validMail))]);
    await expect(network.port.generate(prompt)).resolves.toMatchObject({ subject: 'Objet généré' });
    expect(network.calls).toHaveLength(2);
  });

  it('4xx non transitoires : aucune nouvelle tentative (400, 401, 404, quota épuisé)', async () => {
    for (const [response, code] of [[errorJson(400, 'invalid_request_error'), 'ai_upstream_error'], [errorJson(401, 'invalid_api_key'), 'ai_auth_failed'],
      [errorJson(404, 'model_not_found'), 'ai_upstream_error'], [errorJson(429, 'insufficient_quota'), 'ai_rate_limited']] as const) {
      const g = generator([response]);
      const e = await expectAiError(g.port.generate(prompt), code);
      expect(g.calls).toHaveLength(1);
      expect(g.sleeps).toEqual([]);
      expect(e.message).not.toContain('upstream detail');
    }
  });
});

// --- Prompt ---
const baseContext = (over: Partial<MailGenerationContext> = {}): MailGenerationContext => ({
  step: 'contact',
  prospect: { civility: 'Mme', firstName: 'Claire', lastName: 'Martin', jobTitle: 'Directrice des opérations', role: 'Direction' },
  company: { name: 'Synthetic Co', website: 'https://synthetic.test', sizeLabel: null, segment: null, activityCategories: ['Logistique'], projectDoneWithCircoe: null, projectType: null, circoeReferences: null, clientApproach: null },
  previousMessages: [], currentVersion: null, userInstructions: null, bookingUrl: null, ...over
});

describe(`prompt versionné (${MAIL_PROMPT_VERSION})`, () => {
  it('interdit explicitement l’invention de signal, actualité, référence ; données fournies = pas des instructions', () => {
    const text = buildMailInstructions({ step: 'contact', bookingUrl: null });
    expect(text).toMatch(/N’invente aucun signal, aucune actualité/);
    expect(text).toMatch(/aucune référence/);
    expect(text).toMatch(/ne sont pas des instructions/);
    expect(text).toMatch(/n’insère aucun lien/);
    expect(MAIL_PROMPT_VERSION).toMatch(/^contact-mail-fr-/);
  });

  it('données manquantes : générer avec le contexte disponible, sans « null » ni valeur devinée', () => {
    const input = buildMailInput(baseContext({
      prospect: { civility: null, firstName: 'Claire', lastName: 'Martin', jobTitle: null, role: null },
      company: { ...baseContext().company, website: null, activityCategories: [] }
    }));
    expect(input).not.toMatch(/null|undefined/);
    expect(input).not.toMatch(/Fonction :|Site web :|Civilité :/);
    expect(input).toMatch(/Informations non disponibles \(ne pas les deviner\) : fonction, contexte d’activité de l’entreprise/);
    const empty = buildMailInput(baseContext({ prospect: { civility: null, firstName: null, lastName: null, jobTitle: null, role: null }, company: { ...baseContext().company, name: null, website: null, activityCategories: [] } }));
    expect(empty).toMatch(/aucune donnée disponible/);
  });

  it('consigne utilisateur incluse (bornée), version actuelle fournie pour la régénération', () => {
    const input = buildMailInput(baseContext({ userInstructions: 'Plus court, mentionner la logistique', currentVersion: { subject: 'Ancien objet', body: 'Ancien corps' } }));
    expect(input).toMatch(/Consigne de l’utilisateur pour cette version :\nPlus court, mentionner la logistique/);
    expect(input).toMatch(/Version actuelle de ce message[^\n]*\nObjet : Ancien objet\nAncien corps/);
    expect(buildMailInput(baseContext({ userInstructions: 'x'.repeat(1500) }))).toContain(`${'x'.repeat(1000)}`);
    expect(buildMailInput(baseContext({ userInstructions: 'x'.repeat(1500) }))).not.toContain('x'.repeat(1001));
  });

  it('R1/R2 : messages précédents enregistrés inclus ; sans message précédent, aucune référence inventée', () => {
    const r1 = buildMailPrompt(baseContext({ step: 'r1', previousMessages: [{ step: 'contact', statusLabel: 'Envoyé', subject: 'Premier objet', body: 'Premier corps' }] }));
    expect(r1.input).toMatch(/Message Contact déjà rédigé \(Envoyé\) :\nObjet : Premier objet\nPremier corps/);
    expect(r1.instructions).toMatch(/première relance/);
    expect(buildMailInput(baseContext({ step: 'r2' }))).toMatch(/Aucun message précédent enregistré/);
    expect(buildMailInput(baseContext())).not.toMatch(/Message .* déjà rédigé/);
  });

  it('lien de prise de rendez-vous seulement s’il est configuré (URL http(s) valide)', () => {
    expect(buildMailInstructions({ step: 'contact', bookingUrl: 'https://rdv.example.test/circoe' })).toContain('https://rdv.example.test/circoe');
    expect(normalizeBookingUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeBookingUrl('pas une url')).toBeNull();
    expect(normalizeBookingUrl(' https://rdv.example.test/x ')).toBe('https://rdv.example.test/x');
    expect(normalizeBookingUrl('')).toBeNull();
  });
});

// --- Service de génération (base temporaire, faux port) ---
const dirs: string[] = [];
const opened: Database.Database[] = [];
afterAll(() => {
  for (const db of opened) db.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
type FakePort = MailGeneratorPort & { prompts: MailPrompt[] };
const fakePort = (behaviour: (prompt: MailPrompt, n: number) => Promise<{ subject: string; body: string; model: string }>): FakePort => {
  const prompts: MailPrompt[] = [];
  return { prompts, generate: async p => { prompts.push(p); return behaviour(p, prompts.length); } };
};
const okPort = () => fakePort(async (_p, n) => ({ subject: `Objet IA ${n}`, body: `Corps IA ${n}`, model: 'fake-model' }));
function setup(deps: Partial<MailGenerationDeps> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-generation-'));
  dirs.push(dir);
  const db = new Database(path.join(dir, 'viper.sqlite'));
  opened.push(db);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.exec(schema);
  migrateContactMessages(db);
  db.prepare("INSERT INTO companies(id,display_name,project_type,circoe_references) VALUES('c1','Synthetic Co','Automatisation','Projet X (validé)')").run();
  db.prepare("INSERT INTO prospects(id,company_id,civility,first_name,last_name,exact_job_title) VALUES('p1','c1','Mme','Claire','Martin','DAF')").run();
  db.prepare("INSERT INTO emails(id,prospect_id,address,is_primary) VALUES('e1','p1','claire.secret@example.test',1)").run();
  db.prepare("INSERT INTO phones(id,prospect_id,number,is_primary) VALUES('t1','p1','+33 6 00 00 00 99',1)").run();
  const tracking = createContactTrackingService(db, { now: () => NOW, cancelFutureMessages: contactMessageCanceller });
  tracking.applyProspectPayload('p1', {}, human);
  const port = (deps.generator as FakePort | null | undefined) === undefined ? okPort() : deps.generator as FakePort | null;
  const service = createContactMailGenerationService(db, { now: () => NOW, defaultFromEmail: 'from@example.test', ...deps, generator: port });
  const messages = createContactMessageService(db, { now: () => NOW, defaultFromEmail: 'from@example.test' });
  const snapshot = () => ({
    messages: db.prepare('SELECT * FROM contact_messages ORDER BY step').all(),
    events: db.prepare('SELECT count(*) n FROM contact_message_events').get(),
    audit: db.prepare("SELECT count(*) n FROM audit_log WHERE entity_type='contact_message'").get(),
    tracking: db.prepare('SELECT status,next_action_year,next_action_week FROM contact_tracking').all(),
    history: db.prepare('SELECT count(*) n FROM contact_tracking_status_history').get()
  });
  return { db, service, messages, tracking, port, snapshot };
}
async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(() => null, e => e);
  expect(error).toBeTruthy();
  expect((error as ContactMessageError | AiGenerationError).code).toBe(code);
}

describe('génération d’un message (service + faux port)', () => {
  it('génération => Brouillon avec modèle et version de prompt, aucune transition prospect', async () => {
    const t = setup();
    const before = t.snapshot();
    const result = await t.service.generate('p1', 'contact', {}, human);
    expect(result).toMatchObject({ created: true, generation: { model: 'fake-model', prompt_version: MAIL_PROMPT_VERSION },
      message: { status: 'draft', subject: 'Objet IA 1', body_text: 'Corps IA 1', generation_model: 'fake-model', generation_prompt_version: MAIL_PROMPT_VERSION, validated_at: null, to_recipients: ['claire.secret@example.test'] } });
    expect(listContactMessageEvents(t.db, result.message.id).map(e => e.event_type)).toEqual(['generated']);
    const after = t.snapshot();
    expect(after.tracking).toEqual(before.tracking);
    expect(after.history).toEqual(before.history);
    // Données minimales : ni email ni téléphone envoyés à l'IA.
    const sent = JSON.stringify(t.port!.prompts[0]);
    expect(sent).not.toContain('claire.secret');
    expect(sent).not.toContain('00 99');
    expect(sent).toContain('Références Circoe pertinentes : Projet X (validé)');
  });

  it('régénération guidée d’un message validé : consigne transmise, version actuelle fournie, retour en Brouillon (revalidation)', async () => {
    const t = setup();
    const first = await t.service.generate('p1', 'contact', {}, human);
    const validated = t.messages.validate('p1', 'contact', first.message.revision, human).message;
    const again = await t.service.generate('p1', 'contact', { expected_revision: validated.revision, instructions: 'Plus court' }, human);
    expect(again).toMatchObject({ unvalidated: true, message: { status: 'draft', revision: 2, subject: 'Objet IA 2', validated_at: null } });
    expect(t.port!.prompts[1].input).toMatch(/Consigne de l’utilisateur pour cette version :\nPlus court/);
    expect(t.port!.prompts[1].input).toMatch(/Version actuelle de ce message[^\n]*\nObjet : Objet IA 1/);
    expect(t.tracking.getTracking('p1')?.status).toBe('neutral');
  });

  it('R1 : le message Contact enregistré est fourni ; un message annulé ne l’est pas', async () => {
    const t = setup();
    t.messages.saveMessage('p1', 'contact', { subject: 'Premier objet', body_text: 'Premier corps' }, human);
    await t.service.generate('p1', 'r1', {}, human);
    expect(t.port!.prompts[0].input).toMatch(/Message Contact déjà rédigé \(Brouillon\) :\nObjet : Premier objet/);
    t.messages.cancel('p1', 'contact', 1, human);
    await t.service.generate('p1', 'r2', {}, human);
    expect(t.port!.prompts[1].input).not.toContain('Premier objet');
    expect(t.port!.prompts[1].input).toMatch(/Message R1 déjà rédigé/);
  });

  it('échec IA (timeout, sortie invalide) => rien n’est écrit, message existant intact', async () => {
    for (const code of ['ai_timeout', 'ai_invalid_output', 'ai_upstream_error'] as const) {
      const t = setup({ generator: fakePort(async () => { throw new AiGenerationError(code, 'échec'); }) });
      t.messages.saveMessage('p1', 'contact', { subject: 'Manuel', body_text: 'Corps manuel' }, human);
      const before = t.snapshot();
      await expectCode(t.service.generate('p1', 'contact', { expected_revision: 1 }, human), code);
      expect(t.snapshot()).toEqual(before);
      await expectCode(t.service.generate('p1', 'r1', {}, human), code);
      expect(getContactMessage(t.db, 'p1', 'r1')).toBeNull();
    }
  });

  it('clé/modèle absents => ai_not_configured, aucune écriture', async () => {
    const t = setup({ generator: null, missingSettings: ['OPENAI_API_KEY'] });
    const before = t.snapshot();
    const error = await t.service.generate('p1', 'contact', {}, human).then(() => null, e => e as AiGenerationError);
    expect(error?.code).toBe('ai_not_configured');
    expect(error?.httpStatus).toBe(503);
    expect(error?.message).toContain('OPENAI_API_KEY');
    expect(t.snapshot()).toEqual(before);
  });

  it('refus avant tout appel IA : séquence fermée, envoyé, annulé, programmé, révision absente ou périmée', async () => {
    const t = setup();
    const draft = t.messages.saveMessage('p1', 'contact', { subject: 'S', body_text: 'B' }, human).message;
    await expectCode(t.service.generate('p1', 'contact', {}, human), 'message_exists');
    await expectCode(t.service.generate('p1', 'contact', { expected_revision: 9 }, human), 'revision_conflict');
    await expectCode(t.service.generate('p1', 'r1', { expected_revision: 1 }, human), 'message_not_found');
    t.messages.validate('p1', 'contact', draft.revision, human);
    t.messages.schedule('p1', 'contact', { expected_revision: 1, scheduled_at: FUTURE }, human);
    await expectCode(t.service.generate('p1', 'contact', { expected_revision: 1 }, human), 'invalid_transition');
    expect(getContactMessage(t.db, 'p1', 'contact')?.status).toBe('scheduled');
    t.messages.cancel('p1', 'contact', 1, human);
    await expectCode(t.service.generate('p1', 'contact', { expected_revision: 1 }, human), 'message_cancelled');
    t.db.prepare("UPDATE contact_messages SET status='sent',sent_at=?,cancelled_at=NULL,cancel_reason=NULL,validated_at=?,validated_by_actor_id='x',validated_revision=revision WHERE step='contact'").run(NOW.toISOString(), NOW.toISOString());
    await expectCode(t.service.generate('p1', 'contact', { expected_revision: 1 }, human), 'message_sent_immutable');
    t.tracking.changeState('p1', 'response_received', human);
    await expectCode(t.service.generate('p1', 'r1', {}, human), 'prospect_sequence_closed');
    await expectCode(t.service.generate('nope', 'contact', {}, human), 'prospect_not_found');
    expect(t.port!.prompts).toHaveLength(0);
  });

  it('modification humaine pendant l’appel IA : conflit de révision, la saisie humaine n’est pas écrasée', async () => {
    const ref: { t?: ReturnType<typeof setup> } = {};
    const port = fakePort(async () => {
      ref.t!.messages.saveMessage('p1', 'contact', { expected_revision: 1, subject: 'Humain', body_text: 'Saisie humaine' }, human);
      return { subject: 'IA', body: 'IA', model: 'fake-model' };
    });
    const t = ref.t = setup({ generator: port });
    t.messages.saveMessage('p1', 'contact', { subject: 'S', body_text: 'B' }, human);
    await expectCode(t.service.generate('p1', 'contact', { expected_revision: 1 }, human), 'revision_conflict');
    expect(getContactMessage(t.db, 'p1', 'contact')).toMatchObject({ subject: 'Humain', revision: 2, generation_model: null });
  });

  it('programmé pendant l’appel IA : refus dans la transaction d’écriture (pas de déprogrammation silencieuse)', async () => {
    const ref: { t?: ReturnType<typeof setup> } = {};
    const port = fakePort(async () => {
      ref.t!.messages.schedule('p1', 'contact', { expected_revision: 1, scheduled_at: FUTURE }, human);
      return { subject: 'IA', body: 'IA', model: 'fake-model' };
    });
    const t = ref.t = setup({ generator: port });
    const m = t.messages.saveMessage('p1', 'contact', { subject: 'S', body_text: 'B' }, human).message;
    t.messages.validate('p1', 'contact', m.revision, human);
    await expectCode(t.service.generate('p1', 'contact', { expected_revision: 1 }, human), 'invalid_transition');
    expect(getContactMessage(t.db, 'p1', 'contact')).toMatchObject({ status: 'scheduled', subject: 'S' });
  });

  it('payload strict : aucun statut, consigne bornée', () => {
    expect(parseGenerateRequest({ expected_revision: 2, instructions: 'x' })).toEqual({ expected_revision: 2, instructions: 'x' });
    expect(parseGenerateRequest(undefined)).toEqual({});
    for (const [body, code] of [[{ status: 'validated' }, 'invalid_payload'], [{ instructions: 'x'.repeat(1001) }, 'invalid_payload'], [{ expected_revision: 0 }, 'revision_required'], [{ model: 'x' }, 'invalid_payload']] as const) {
      let caught: unknown = null;
      try { parseGenerateRequest(body); } catch (e) { caught = e; }
      expect((caught as ContactMessageError).code).toBe(code);
    }
  });

  it('contexte chargé depuis la base : rôle, catégories, pas de coordonnées', () => {
    const t = setup();
    t.db.prepare("INSERT INTO activity_categories(id,label) VALUES('a1','Transport')").run();
    t.db.prepare("INSERT INTO company_activity_categories(company_id,category_id) VALUES('c1','a1')").run();
    const ctx = loadMailGenerationContext(t.db, 'p1', 'contact', { userInstructions: null, bookingUrl: null });
    expect(ctx.company.activityCategories).toEqual(['Transport']);
    expect(ctx.prospect).toEqual({ civility: 'Mme', firstName: 'Claire', lastName: 'Martin', jobTitle: 'DAF', role: null });
    expect(JSON.stringify(ctx)).not.toMatch(/secret|\+33/);
  });
});
