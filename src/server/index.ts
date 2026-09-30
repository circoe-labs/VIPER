import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { db, isBusinessStateEmpty, migrate, restoreDatabase, rows, serializeDatabase } from './db.js';
import { login, logout, me, requireAuth } from './auth.js';
import { audit, type Actor } from './audit.js';
import { parseWorkbook } from './importer.js';
import { buildExport } from './exporter.js';
import { assertReadOnlySql } from './sqlSafety.js';
import { archiveImportedWorkbook, storageDir } from './storage.js';
import { deleteDraftRecord, loadDraftRecord, saveDraftRecord } from './drafts.js';
import { nextActionOrderSql } from './contactTrackingSchema.js';
import { prospectionCounters, prospectionFilterSql, prospectSearchSql } from './prospectionDashboard.js';
import { isProspectionFilter } from '../shared/prospectionDashboard.js';
import { contactDashboard, contactProspects } from './contactDashboard.js';
import { homeDashboard } from './homeDashboard.js';
import { parseContactListQuery } from '../shared/contactDashboard.js';
import { ContactTrackingError, createContactTrackingService, parseTrackingPatch, type ContactTrackingDeps } from './contactTrackingService.js';
import { contactMessageCanceller, getContactMessageById } from './contactMessageStore.js';
import {
  ContactMessageError, createContactMessageService, parseExpectedRevision, parseMessageContent, parseMessageStep, parseSchedule, type ContactMessageDeps
} from './contactMessageService.js';
import { createContactMailGenerationService, parseGenerateRequest } from './contactMailGenerationService.js';
import { AiGenerationError, createOpenAiMailGenerator, missingOpenAiSettings, openAiConfigFromEnv } from './openaiMailGenerator.js';
import { callbackReturnPath, createToolboxIntegration, toolboxSettingsFromEnv } from './toolboxIntegration.js';
import { ToolboxError } from './toolboxMcpClient.js';
import { contactDispatchConfigFromEnv, createContactDispatcher } from './contactMessageDispatcher.js';
import { backfillUnassignedProspectRoles, ensureDefaultRoles, inferRoleSlug } from './roleTaxonomy.js';

migrate();
ensureDefaultRoles(db);
backfillUnassignedProspectRoles(db);
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
app.use(express.json({ limit: '50mb' }));
app.use(cookieParser());
// CIRCOE Toolbox (Task 15) : désactivée par défaut (`TOOLBOX_MAIL_ENABLED`) ; jetons OAuth dans un fichier serveur hors dépôt et hors
// base, jamais renvoyés au client. Le retour OAuth arrive par redirection depuis la Toolbox (autre site : le cookie de session
// `SameSite=Strict` n'est pas envoyé) : la route est publique et authentifiée par le `state` à usage unique lié à l'utilisateur.
const toolboxSettings = toolboxSettingsFromEnv(process.env, { storageDir });
const toolbox = createToolboxIntegration({ getDb: () => db, settings: toolboxSettings });
toolbox.startCleanupWorker();
// Envoi programmé (Task 16) : scan périodique dans ce process, seulement si la Toolbox est activée et configurée ; chaque passe
// ne fait rien tant qu'elle n'est pas connectée. `db` relu à chaque étape (restauration). Modèle : contactMessageDispatcher.ts.
const dispatcher = createContactDispatcher({
  getDb: () => db, toolbox: () => toolbox.mailToolbox(), remoteDrafts: () => toolbox.remoteDrafts(),
  config: contactDispatchConfigFromEnv(process.env, { toolboxTimeoutMs: toolboxSettings.config?.timeoutMs ?? 20_000 })
});
if (toolboxSettings.enabled && toolboxSettings.config) dispatcher.start();
// Arrêt propre : plus de nouvelle passe, l'envoi en cours se termine (au plus 30 s) avant la sortie du process.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    toolbox.stopCleanupWorker();
    void Promise.race([dispatcher.stop(), new Promise(resolve => setTimeout(resolve, 30_000))]).finally(() => process.exit(0));
  });
}
app.get('/api/toolbox/oauth/callback', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.redirect(302, callbackReturnPath(await toolbox.completeAuthorization(req.query as Record<string, unknown>)));
});
app.post('/api/auth/login', login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', me);
app.use('/api', requireAuth);

const actor = (req: express.Request): Actor => (req as express.Request & { actor?: Actor }).actor || { type: 'human', id: 'pilot-user', display: 'Commercial VIPER' };
const nowIso = () => new Date().toISOString();
// Dépendances du service de suivi : annulation SQL des messages futurs (décision 29, Task 11) ; la suppression des brouillons
// distants mis en file (`contact_message_remote_draft_cleanups`) est faite après commit par le worker Toolbox (Task 15) ; un
// message en cours d'envoi (`inFlight`) est résolu par le dispatcher (Task 16).
const trackingDeps: ContactTrackingDeps = { cancelFutureMessages: contactMessageCanceller };
// `db` est réassigné par une restauration : le service est recréé à chaque requête (aucun état propre).
const trackingService = () => createContactTrackingService(db, trackingDeps);
const sendTrackingError = (res: express.Response, e: unknown, fallback: string) => e instanceof ContactTrackingError
  ? res.status(e.httpStatus).json({ error: e.message, code: e.code })
  : res.status(400).json({ error: e instanceof Error ? e.message : fallback });
// Messages Contact/R1/R2 (Task 12) : From par défaut depuis la config serveur (jamais codé en dur) ; brouillon distant Toolbox
// créé à la validation/programmation seulement si l'intégration est activée et connectée (sinon `noRemoteDrafts`, Task 15).
const messageDeps = (): ContactMessageDeps => ({ defaultFromEmail: process.env.DEFAULT_OUTBOUND_EMAIL || null, remoteDrafts: toolbox.remoteDrafts() });
const messageService = () => createContactMessageService(db, messageDeps());
const sendMessageError = (res: express.Response, e: unknown, fallback: string) => e instanceof ContactMessageError
  ? res.status(e.httpStatus).json({ error: e.message, code: e.code, ...(e.fields ? { fields: e.fields } : {}) })
  : e instanceof AiGenerationError
    ? res.status(e.httpStatus).json({ error: e.message, code: e.code })
    : res.status(500).json({ error: fallback });
// Génération IA (Task 14) : configuration relue à chaque requête (clé et modèle serveur uniquement, jamais renvoyés au client).
const generationService = () => {
  const config = openAiConfigFromEnv();
  return createContactMailGenerationService(db, {
    ...messageDeps(), generator: config ? createOpenAiMailGenerator(config) : null,
    missingSettings: missingOpenAiSettings(), bookingUrl: process.env.CONTACT_BOOKING_URL || null
  });
};
// File de suppression des brouillons distants : passe non bloquante après toute mutation réussie d'un prospect ou d'un message
// (édition, annulation, changement d'état) ; le worker périodique reprend les échecs (backoff).
app.use('/api/prospects', (req, res, next) => {
  if (req.method !== 'GET') res.on('finish', () => { if (res.statusCode < 400) toolbox.kickCleanup(); });
  next();
});
const sendToolboxError = (res: express.Response, e: unknown, fallback: string) => e instanceof ToolboxError
  ? res.status(e.httpStatus).json({ error: e.message, code: e.code })
  : res.status(500).json({ error: fallback });
const norm = (v: unknown) => String(v || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

app.get('/api/drafts/:key', (req, res) => {
  try {
    const draft = loadDraftRecord(db, req.params.key);
    if (!draft) return res.status(404).json({ error: 'Brouillon introuvable' });
    res.json(draft);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Lecture du brouillon impossible' });
  }
});

app.put('/api/drafts/:key', (req, res) => {
  try {
    const draft = saveDraftRecord(db, req.params.key, req.body?.value);
    res.json(draft);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Sauvegarde du brouillon impossible' });
  }
});

app.delete('/api/drafts/:key', (req, res) => {
  try {
    deleteDraftRecord(db, req.params.key);
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Suppression du brouillon impossible' });
  }
});

app.get('/api/state/backup', (_req, res) => {
  try {
    const snapshot = serializeDatabase();
    res.setHeader('Content-Type', 'application/vnd.sqlite3');
    res.setHeader('Cache-Control', 'no-store');
    res.send(snapshot);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : 'Sauvegarde impossible' });
  }
});

app.post('/api/state/restore', upload.single('backup'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sauvegarde requise' });
  if (!isBusinessStateEmpty()) return res.status(409).json({ error: 'Restauration refusée : VIPER contient déjà des données.' });
  try {
    restoreDatabase(req.file.buffer);
    ensureDefaultRoles(db);
    backfillUnassignedProspectRoles(db);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Restauration impossible' });
  }
});

function ensureCategory(label: string) {
  const clean = label.trim();
  if (!clean) return null;
  let category = db.prepare('SELECT id FROM activity_categories WHERE lower(label)=lower(?)').get(clean) as { id: string } | undefined;
  if (!category) {
    category = { id: randomUUID() };
    db.prepare('INSERT INTO activity_categories(id,label) VALUES(?,?)').run(category.id, clean);
  }
  return category.id as string;
}

function ensureReferent(label: string) {
  const clean = label.trim();
  if (!clean) return null;
  const parts = clean.split(/\s+/).filter(Boolean);
  const firstName = parts[0] || clean;
  const lastName = parts.slice(1).join(' ');
  let ref = db.prepare("SELECT id FROM internal_referents WHERE lower(trim(first_name||' '||last_name))=lower(?)").get(clean) as { id: string } | undefined;
  if (!ref) {
    ref = { id: randomUUID() };
    db.prepare('INSERT INTO internal_referents(id,first_name,last_name) VALUES(?,?,?)').run(ref.id, firstName, lastName);
  }
  return ref.id as string;
}

// Formes JSON envoyées par le formulaire prospect (App.tsx) et lignes SQL relues pour la synchronisation.
type ContactPointInput = { id?: string; is_primary?: boolean | number; verification_status: string; source_reference?: string };
type EmailInput = ContactPointInput & { address?: string };
type PhoneInput = ContactPointInput & { number?: string; type: string };
type ContactPointRow = { id: string; verification_status: string; last_verified_at: string | null; source_reference: string | null };

function syncEmails(prospectId: string, items: EmailInput[] | undefined, forceUnverified = false) {
  if (!Array.isArray(items)) return;
  const existing = rows('SELECT * FROM emails WHERE prospect_id=?', [prospectId]) as (ContactPointRow & { address: string })[];
  const existingById = new Map(existing.map(x => [x.id, x]));
  db.prepare('UPDATE emails SET is_primary=0 WHERE prospect_id=?').run(prospectId);
  const active = items.filter(x => String(x.address || '').trim());
  if (active.length && !active.some(x => x.is_primary)) active[0].is_primary = true;
  const kept = new Set<string>();
  for (const item of active) {
    const address = String(item.address || '').trim().toLowerCase();
    const status = ['unverified', 'verified', 'invalid', 'unknown'].includes(item.verification_status) ? item.verification_status : 'unverified';
    const old = item.id ? existingById.get(item.id) : null;
    const changedAddress = old && norm(old.address) !== norm(address);
    const nextStatus = forceUnverified ? 'unverified' : (changedAddress && status !== 'verified' ? 'unverified' : status);
    const verifiedAt = nextStatus === 'verified' ? (old?.verification_status === 'verified' && !changedAddress ? old.last_verified_at : nowIso()) : null;
    if (old) {
      db.prepare('UPDATE emails SET address=?,is_primary=?,is_active=1,verification_status=?,last_verified_at=?,source_reference=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND prospect_id=?')
        .run(address, item.is_primary ? 1 : 0, nextStatus, verifiedAt, item.source_reference || old.source_reference || 'VIPER manual entry', old.id, prospectId);
      kept.add(old.id);
    } else {
      const id = randomUUID();
      db.prepare('INSERT INTO emails(id,prospect_id,address,is_primary,is_active,verification_status,origin_type,last_verified_at,source_reference) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, prospectId, address, item.is_primary ? 1 : 0, 1, nextStatus, 'manual', verifiedAt, item.source_reference || 'VIPER manual entry');
      kept.add(id);
    }
  }
  for (const old of existing) if (!kept.has(old.id)) db.prepare('UPDATE emails SET is_active=0,is_primary=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(old.id);
}

function syncPhones(prospectId: string, items: PhoneInput[] | undefined, forceUnverified = false) {
  if (!Array.isArray(items)) return;
  const existing = rows('SELECT * FROM phones WHERE prospect_id=?', [prospectId]) as (ContactPointRow & { number: string })[];
  const existingById = new Map(existing.map(x => [x.id, x]));
  db.prepare('UPDATE phones SET is_primary=0 WHERE prospect_id=?').run(prospectId);
  const active = items.filter(x => String(x.number || '').trim());
  if (active.length && !active.some(x => x.is_primary)) active[0].is_primary = true;
  const kept = new Set<string>();
  for (const item of active) {
    const number = String(item.number || '').trim();
    const type = ['mobile', 'landline', 'other'].includes(item.type) ? item.type : 'other';
    const status = ['unverified', 'verified', 'invalid', 'unknown'].includes(item.verification_status) ? item.verification_status : 'unverified';
    const old = item.id ? existingById.get(item.id) : null;
    const changedNumber = old && norm(old.number) !== norm(number);
    const nextStatus = forceUnverified ? 'unverified' : (changedNumber && status !== 'verified' ? 'unverified' : status);
    const verifiedAt = nextStatus === 'verified' ? (old?.verification_status === 'verified' && !changedNumber ? old.last_verified_at : nowIso()) : null;
    if (old) {
      db.prepare('UPDATE phones SET number=?,type=?,is_primary=?,is_active=1,verification_status=?,last_verified_at=?,source_reference=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND prospect_id=?')
        .run(number, type, item.is_primary ? 1 : 0, nextStatus, verifiedAt, item.source_reference || old.source_reference || 'VIPER manual entry', old.id, prospectId);
      kept.add(old.id);
    } else {
      const id = randomUUID();
      db.prepare('INSERT INTO phones(id,prospect_id,number,type,is_primary,is_active,verification_status,origin_type,last_verified_at,source_reference) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, prospectId, number, type, item.is_primary ? 1 : 0, 1, nextStatus, 'manual', verifiedAt, item.source_reference || 'VIPER manual entry');
      kept.add(id);
    }
  }
  for (const old of existing) if (!kept.has(old.id)) db.prepare('UPDATE phones SET is_active=0,is_primary=0,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(old.id);
}

// Accueil (retour « PARTIE PROSPECTION ») : BASE, activité de contact, camembert du mois et journal 24 h sur le modèle Contact.
app.get('/api/dashboard', (_req, res) => {
  res.json(homeDashboard(db, new Date()));
});

app.get('/api/prospection/counters', (req, res) => res.json(prospectionCounters(db, { today: new Date(), q: String(req.query.q || '') })));

// Dashboard Contact (Task 09) : lecture seule, définitions dans src/shared/contactDashboard.ts, SQL dans contactDashboard.ts.
app.get('/api/contact/dashboard', (_req, res) => res.json(contactDashboard(db, new Date())));
app.get('/api/contact/prospects', (req, res) => {
  const parsed = parseContactListQuery(req.query as Record<string, unknown>);
  if (!parsed.ok) return res.status(400).json({ error: parsed.error, code: 'invalid_contact_query' });
  res.json(contactProspects(db, parsed.query, new Date()));
});

app.get('/api/prospects', (req, res) => {
  const q = String(req.query.q || '').trim();
  const filter = String(req.query.filter || '');
  const company = String(req.query.company || '');
  const search = prospectSearchSql(q);
  const ps: unknown[] = [...search.params];
  let w = search.sql;
  if (company) { w += ' AND p.company_id=?'; ps.push(company); }
  if (isProspectionFilter(filter)) { const f = prospectionFilterSql(filter, new Date()); w += ` AND ${f.sql}`; ps.push(...f.params); } // cartes Prospection (Task 07)
  res.json(rows(`SELECT p.*,c.display_name company,r.label role,e.address primary_email,e.verification_status email_verification,e.last_verified_at email_verified_at,ph.number primary_phone,ct.status tracking_status,ct.planned_contact_at,ct.next_action_year,ct.next_action_week,ct.next_action_year contact_year,ct.next_action_week contact_week,ct.response_received_at,ct.appointment_at,trim(coalesce(ir.first_name,'')||' '||coalesce(ir.last_name,'')) referent,(SELECT max(h.changed_at) FROM contact_tracking_status_history h WHERE h.contact_tracking_id=ct.id AND h.to_status=ct.status) tracking_status_since FROM prospects p JOIN companies c ON c.id=p.company_id LEFT JOIN roles r ON r.id=p.role_id LEFT JOIN emails e ON e.prospect_id=p.id AND e.is_primary=1 AND e.is_active=1 LEFT JOIN phones ph ON ph.id=(SELECT ph1.id FROM phones ph1 WHERE ph1.prospect_id=p.id AND ph1.is_primary=1 AND ph1.is_active=1 LIMIT 1) LEFT JOIN contact_tracking ct ON ct.prospect_id=p.id LEFT JOIN internal_referents ir ON ir.id=ct.referent_id WHERE ${w} ORDER BY ${nextActionOrderSql()},p.updated_at DESC LIMIT 500`, ps));
});

app.get('/api/prospects/:id', (req, res) => {
  const prospect = db.prepare('SELECT * FROM prospects WHERE id=?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!prospect) return res.status(404).json({ error: 'Prospect introuvable' });
  const tracking = db.prepare('SELECT * FROM contact_tracking WHERE prospect_id=?').get(req.params.id) as Record<string, unknown> | undefined || null;
  res.json({
    prospect,
    company: db.prepare('SELECT * FROM companies WHERE id=?').get(prospect.company_id) || null,
    role: prospect.role_id ? (db.prepare('SELECT label FROM roles WHERE id=?').get(prospect.role_id) as { label: string } | undefined)?.label ?? null : null,
    emails: rows('SELECT * FROM emails WHERE prospect_id=? AND is_active=1 ORDER BY is_primary DESC,created_at', [req.params.id]),
    phones: rows('SELECT * FROM phones WHERE prospect_id=? AND is_active=1 ORDER BY is_primary DESC,created_at', [req.params.id]),
    tracking,
    trackingHistory: tracking ? rows('SELECT * FROM contact_tracking_status_history WHERE contact_tracking_id=? ORDER BY changed_at DESC', [tracking.id]) : [],
    sources: rows('SELECT * FROM prospect_sources WHERE prospect_id=? ORDER BY collected_at DESC', [req.params.id]),
    history: rows('SELECT * FROM audit_log WHERE entity_id=? ORDER BY created_at DESC LIMIT 30', [req.params.id])
  });
});

app.post('/api/prospects', (req, res) => {
  const b = req.body || {};
  if (!b.company_id || !b.first_name || !b.last_name) return res.status(400).json({ error: 'Entreprise, prénom et nom requis' });
  const id = randomUUID();
  const a = actor(req);
  const inferredSlug = !b.role_id ? inferRoleSlug(b.exact_job_title) : null;
  const inferredRole = inferredSlug ? db.prepare('SELECT id FROM roles WHERE slug=?').get(inferredSlug) as { id: string } | undefined : null;
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO prospects(id,company_id,civility,first_name,last_name,role_id,exact_job_title,activity_status,employment_verified_at,contactability_status) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(id, b.company_id, b.civility || null, b.first_name, b.last_name, b.role_id || inferredRole?.id || null, b.exact_job_title || null, b.activity_status || 'unknown', b.mark_employment_verified ? nowIso() : null, b.contactability_status || 'contactable');
      trackingService().applyProspectPayload(id, b.tracking || {}, a);
      syncEmails(id, b.emails);
      syncPhones(id, b.phones);
      db.prepare('INSERT INTO prospect_sources(id,prospect_id,source_type,source_reference,created_by_actor) VALUES(?,?,?,?,?)').run(randomUUID(), id, 'manual', 'VIPER manual entry', a.id);
      audit(a, 'prospect', id, 'create', null, b, 'manual');
    })();
  } catch (e) {
    return sendTrackingError(res, e, 'Enregistrement impossible');
  }
  res.status(201).json({ id });
});

app.put('/api/prospects/:id', (req, res) => {
  const b = req.body || {};
  const before = db.prepare('SELECT * FROM prospects WHERE id=?').get(req.params.id) as Record<string, unknown> | undefined;
  if (!before) return res.status(404).json({ error: 'Prospect introuvable' });
  const a = actor(req);
  const contactability = before.contactability_status === 'do_not_contact' ? 'do_not_contact' : (b.contactability_status || before.contactability_status);
  const companyChanged = b.company_id !== undefined && String(b.company_id || '') !== String(before.company_id || '');
  const employmentChanged = ['company_id', 'role_id', 'exact_job_title', 'activity_status'].some(k => b[k] !== undefined && String(b[k] || '') !== String(before[k] || ''));
  const verifiedAt = (b.mark_employment_verified || employmentChanged) ? nowIso() : before.employment_verified_at;
  try {
    db.transaction(() => {
      db.prepare("UPDATE prospects SET company_id=?,civility=?,first_name=?,last_name=?,role_id=?,exact_job_title=?,activity_status=?,employment_verified_at=?,contactability_status=?,do_not_contact_at=CASE WHEN ?='do_not_contact' THEN coalesce(do_not_contact_at,CURRENT_TIMESTAMP) ELSE NULL END,do_not_contact_reason=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(b.company_id || before.company_id, b.civility ?? before.civility, b.first_name ?? before.first_name, b.last_name ?? before.last_name, b.role_id ?? before.role_id, b.exact_job_title ?? before.exact_job_title, b.activity_status || before.activity_status, verifiedAt, contactability, contactability, b.do_not_contact_reason ?? before.do_not_contact_reason, req.params.id);
      if (companyChanged) {
        db.prepare("UPDATE emails SET verification_status='unverified',last_verified_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE prospect_id=? AND is_active=1").run(req.params.id);
        db.prepare("UPDATE phones SET verification_status='unverified',last_verified_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE prospect_id=? AND is_active=1").run(req.params.id);
      }
      syncEmails(req.params.id, b.emails, companyChanged);
      syncPhones(req.params.id, b.phones, companyChanged);
      trackingService().applyProspectPayload(req.params.id, b.tracking, a);
      audit(a, 'prospect', req.params.id, 'update', before, b, 'manual');
    })();
    res.json({ ok: true, contactability, employment_verified_at: verifiedAt });
  } catch (e) {
    sendTrackingError(res, e, 'Enregistrement impossible');
  }
});

// Suivi manuel (Task 04) : routes minces, logique dans contactTrackingService.ts.
app.get('/api/prospects/:id/tracking', (req, res) => {
  try {
    const service = trackingService();
    res.json({ tracking: service.getTracking(req.params.id), history: service.getHistory(req.params.id) });
  } catch (e) {
    sendTrackingError(res, e, 'Lecture du suivi impossible');
  }
});
app.patch('/api/prospects/:id/tracking', (req, res) => {
  try {
    res.json(trackingService().updateTracking(req.params.id, parseTrackingPatch(req.body), actor(req)));
  } catch (e) {
    sendTrackingError(res, e, 'Mise à jour du suivi impossible');
  }
});

// Messages Contact/R1/R2 (Task 12) : routes minces, machine d'état dans contactMessageService.ts. Aucune route ne permet
// d'écrire un statut directement ; `sent` est réservé au dispatcher interne (Task 16), dont l'état réel (`dispatch.active`)
// accompagne la liste des messages (texte de confirmation de programmation, avertissement si rien ne partira).
app.get('/api/prospects/:id/messages', (req, res) => {
  try { res.json({ ...messageService().listMessages(req.params.id), dispatch: dispatcher.status() }); } catch (e) { sendMessageError(res, e, 'Lecture des messages impossible'); }
});
app.get('/api/prospects/:id/messages/:step', (req, res) => {
  try { res.json(messageService().getMessage(req.params.id, parseMessageStep(req.params.step))); } catch (e) { sendMessageError(res, e, 'Lecture du message impossible'); }
});
app.put('/api/prospects/:id/messages/:step', (req, res) => {
  try {
    const result = messageService().saveMessage(req.params.id, parseMessageStep(req.params.step), parseMessageContent(req.body), actor(req));
    res.status(result.created ? 201 : 200).json(result);
  } catch (e) { sendMessageError(res, e, 'Enregistrement du message impossible'); }
});
// Génération / régénération IA : contenu toujours `draft`, aucune transition prospect, rien d'écrit si l'IA échoue.
app.post('/api/prospects/:id/messages/:step/generate', async (req, res) => {
  try {
    const step = parseMessageStep(req.params.step);
    res.json(await generationService().generate(req.params.id, step, parseGenerateRequest(req.body), actor(req)));
  } catch (e) { sendMessageError(res, e, 'Génération du message impossible'); }
});
// Brouillon distant créé après la validation/programmation (hors transaction) ; la réponse porte le message relu (id distant compris).
async function withRemoteDraft(service: ReturnType<typeof messageService>, result: ReturnType<ReturnType<typeof messageService>['validate']>, a: Actor) {
  const remoteDraft = await service.syncRemoteDraft(result.message.id, a);
  return { ...result, message: getContactMessageById(db, result.message.id) ?? result.message, remoteDraft };
}
app.post('/api/prospects/:id/messages/:step/:action', async (req, res) => {
  try {
    const service = messageService();
    const step = parseMessageStep(req.params.step);
    const a = actor(req);
    switch (req.params.action) {
      case 'validate': {
        return res.json(await withRemoteDraft(service, service.validate(req.params.id, step, parseExpectedRevision(req.body), a), a));
      }
      case 'schedule': {
        return res.json(await withRemoteDraft(service, service.schedule(req.params.id, step, parseSchedule(req.body), a), a));
      }
      case 'unschedule': return res.json(service.unschedule(req.params.id, step, parseExpectedRevision(req.body), a));
      case 'cancel': return res.json(service.cancel(req.params.id, step, parseExpectedRevision(req.body), a));
      case 'reopen': return res.json(service.reopen(req.params.id, step, parseExpectedRevision(req.body), a));
      default: return res.status(404).json({ error: 'Action de message inconnue', code: 'unknown_action' });
    }
  } catch (e) { sendMessageError(res, e, 'Action sur le message impossible'); }
});

// CIRCOE Toolbox (Task 15) : état de connexion sans secret, démarrage du flux OAuth (URL d'autorisation renvoyée au navigateur),
// oubli du jeton. Aucun envoi ici (Task 16).
app.get('/api/toolbox/status', (_req, res) => res.json(toolbox.status()));
app.post('/api/toolbox/connect', async (req, res) => {
  try { res.json(await toolbox.startAuthorization(actor(req))); } catch (e) { sendToolboxError(res, e, 'Connexion à la Toolbox impossible'); }
});
app.post('/api/toolbox/disconnect', (_req, res) => {
  try { toolbox.disconnect(); res.json(toolbox.status()); } catch (e) { sendToolboxError(res, e, 'Déconnexion de la Toolbox impossible'); }
});

app.get('/api/companies', (_req, res) => res.json(rows('SELECT c.*,count(p.id) prospect_count FROM companies c LEFT JOIN prospects p ON p.company_id=c.id GROUP BY c.id ORDER BY c.display_name')));
app.post('/api/companies', (req, res) => {
  if (!req.body?.display_name) return res.status(400).json({ error: 'Nom requis' });
  const id = randomUUID();
  db.prepare('INSERT INTO companies(id,display_name,email_domain,website_url,siren) VALUES(?,?,?,?,?)').run(id, req.body.display_name, req.body.email_domain || null, req.body.website_url || null, req.body.siren || null);
  audit(actor(req), 'company', id, 'create', null, req.body, 'manual');
  res.status(201).json({ id });
});

for (const [route, table] of [['roles', 'roles'], ['segments', 'commercial_segments'], ['categories', 'activity_categories']] as const) {
  app.get(`/api/settings/${route}`, (_req, res) => res.json(rows(`SELECT * FROM ${table}${table === 'roles' ? ' WHERE active=1' : ''} ORDER BY label`)));
  app.post(`/api/settings/${route}`, (req, res) => {
    const id = randomUUID(), label = String(req.body.label || '').trim();
    if (!label) return res.status(400).json({ error: 'Libellé requis' });
    if (table === 'roles') db.prepare('INSERT INTO roles(id,label,slug) VALUES(?,?,?)').run(id, label, norm(label).replace(/\s+/g, '-'));
    else db.prepare(`INSERT INTO ${table}(id,label) VALUES(?,?)`).run(id, label);
    audit(actor(req), table, id, 'create', null, req.body, 'settings');
    res.status(201).json({ id });
  });
}
app.get('/api/settings/referents', (_req, res) => res.json(rows('SELECT * FROM internal_referents ORDER BY active DESC,last_name,first_name')));
app.post('/api/settings/referents', (req, res) => {
  const id = randomUUID();
  db.prepare('INSERT INTO internal_referents(id,first_name,last_name,email) VALUES(?,?,?,?)').run(id, req.body.first_name, req.body.last_name, req.body.email || null);
  res.status(201).json({ id });
});

app.post('/api/import/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier requis' });
  try {
    const preview = parseWorkbook(req.file.buffer, req.file.originalname, new Date());
    archiveImportedWorkbook(req.file.buffer, req.file.originalname, preview.fingerprint);
    saveDraftRecord(db, 'import-preview', preview);
    res.json(preview);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Import impossible' });
  }
});

type ImportedProspect = { id: string; employment_verified_at: string | null };
app.post('/api/import/commit', (req, res) => {
  const p = req.body;
  if (!p?.rows) return res.status(400).json({ error: 'Prévisualisation requise' });
  const batchId = randomUUID();
      const importActor: Actor = { type: 'import', id: batchId, display: p.filename };
  let accepted = 0, rejected = 0, updated = 0;
  try {
    db.transaction(() => {
      db.prepare('INSERT INTO import_batches(id,filename,sheets,imported_at,status,row_count,actor_id,file_fingerprint) VALUES(?,?,?,?,?,?,?,?)')
        .run(batchId, p.filename, JSON.stringify(p.sheets), p.importedAt || nowIso(), 'committed', p.rows.length, actor(req).id, p.fingerprint || null);
      for (const r of p.rows) {
        if (r.excluded || r.diagnostics?.some((d: { level?: string }) => d.level === 'error')) { rejected++; continue; }
        const n = r.normalized || {};
        let company = db.prepare('SELECT * FROM companies WHERE lower(display_name)=lower(?)').get(n.company) as { id: string } | undefined;
        if (!company) {
          company = { id: randomUUID() };
          db.prepare('INSERT INTO companies(id,display_name,project_done_with_circoe,project_type,circoe_references,client_approach) VALUES(?,?,?,?,?,?)')
            .run(company.id, n.company, n.project_done_with_circoe || null, n.project_type || null, n.circoe_references || null, n.client_approach || null);
        } else {
          db.prepare(`UPDATE companies SET
            project_done_with_circoe=coalesce(nullif(?,''),project_done_with_circoe),
            project_type=coalesce(nullif(?,''),project_type),
            circoe_references=coalesce(nullif(?,''),circoe_references),
            client_approach=coalesce(nullif(?,''),client_approach),updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(n.project_done_with_circoe || '', n.project_type || '', n.circoe_references || '', n.client_approach || '', company.id);
        }
        if (n.category) {
          const categoryId = ensureCategory(String(n.category));
          if (categoryId) db.prepare('INSERT OR IGNORE INTO company_activity_categories(company_id,category_id) VALUES(?,?)').run(company.id, categoryId);
        }
        if (n.address && !db.prepare('SELECT id FROM establishments WHERE company_id=? AND lower(line1)=lower(?)').get(company.id, n.address)) {
          db.prepare('INSERT INTO establishments(id,company_id,line1,is_primary) VALUES(?,?,?,?)').run(randomUUID(), company.id, n.address, 1);
        }

        let prospect = n.email
          ? db.prepare('SELECT p.* FROM prospects p JOIN emails e ON e.prospect_id=p.id WHERE lower(e.address)=lower(?)').get(n.email) as ImportedProspect | undefined
          : null;
        if (!prospect && !n.identity_unknown) {
          prospect = db.prepare('SELECT * FROM prospects WHERE company_id=? AND lower(first_name)=lower(?) AND lower(last_name)=lower(?)').get(company.id, n.first_name, n.last_name) as ImportedProspect | undefined;
        }
        const storedFirstName = n.first_name || '';
        const storedLastName = n.last_name || 'Inconnu';
        const inferredRole = n.role_slug ? db.prepare('SELECT id FROM roles WHERE slug=?').get(n.role_slug) as { id: string } | undefined : null;
        const inferredRoleId = inferredRole?.id || null;
        const verifiedAt = n.verification_state === 'verified' ? (n.employment_verified_at || p.importedAt || nowIso()) : null;
        if (!prospect) {
          prospect = { id: randomUUID(), employment_verified_at: verifiedAt };
          db.prepare('INSERT INTO prospects(id,company_id,civility,first_name,last_name,role_id,exact_job_title,activity_status,employment_verified_at) VALUES(?,?,?,?,?,?,?,?,?)')
            .run(prospect.id, company.id, n.civility || null, storedFirstName, storedLastName, inferredRoleId, n.job_title || null, n.activity_status_suggestion || 'unknown', verifiedAt);
        } else {
          updated++;
          const nextVerifiedAt = verifiedAt || prospect.employment_verified_at || null;
          db.prepare(`UPDATE prospects SET civility=coalesce(nullif(?,''),civility),role_id=coalesce(role_id,?),exact_job_title=coalesce(nullif(?,''),exact_job_title),activity_status=CASE WHEN ?='inactive' THEN 'inactive' ELSE activity_status END,employment_verified_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(n.civility || '', inferredRoleId, n.job_title || '', n.activity_status_suggestion || '', nextVerifiedAt, prospect.id);
        }

        const referentId = n.referent ? ensureReferent(String(n.referent)) : null;
        trackingService().applyImport(prospect.id, { status: n.tracking_status, contactYear: n.contact_year, contactWeek: n.contact_week, plannedContactAt: n.planned_contact_at || null, referentId, importedAt: p.importedAt || nowIso() }, importActor);

        if (n.email) {
          const existingEmail = db.prepare('SELECT * FROM emails WHERE lower(address)=lower(?)').get(n.email) as { id: string; prospect_id: string; verification_status: string } | undefined;
          if (!existingEmail) {
            db.prepare('INSERT INTO emails(id,prospect_id,address,is_primary,verification_status,origin_type,last_verified_at,source_reference) VALUES(?,?,?,?,?,?,?,?)')
              .run(randomUUID(), prospect.id, n.email, 1, n.email_verification_status || 'unverified', 'imported', n.email_verified_at || null, `${n.sheet}:${r.row}`);
          } else if (existingEmail.prospect_id === prospect.id && n.email_verification_status === 'verified' && existingEmail.verification_status !== 'verified') {
            db.prepare("UPDATE emails SET verification_status='verified',last_verified_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(n.email_verified_at || p.importedAt || nowIso(), existingEmail.id);
          }
        }
        for (const [number, type] of [[n.phone, 'landline'], [n.mobile, 'mobile']] as const) {
          if (number && !db.prepare('SELECT id FROM phones WHERE prospect_id=? AND number=?').get(prospect.id, number)) {
            const hasPrimary = db.prepare('SELECT id FROM phones WHERE prospect_id=? AND is_primary=1 AND is_active=1').get(prospect.id);
            db.prepare('INSERT INTO phones(id,prospect_id,number,type,is_primary,verification_status,origin_type,source_reference) VALUES(?,?,?,?,?,?,?,?)')
              .run(randomUUID(), prospect.id, number, type, hasPrimary ? 0 : 1, 'unverified', 'imported', `${n.sheet}:${r.row}`);
          }
        }
        db.prepare('INSERT INTO prospect_sources(id,prospect_id,source_type,source_reference,created_by_actor) VALUES(?,?,?,?,?)')
          .run(randomUUID(), prospect.id, 'excel_import', `${p.filename}:${n.sheet}:${r.row}`, actor(req).id);
        db.prepare('INSERT INTO import_row_metadata(id,batch_id,source_sheet,source_row_number,prospect_id,company_id,legacy_metadata) VALUES(?,?,?,?,?,?,?)')
          .run(randomUUID(), batchId, n.sheet, r.row, prospect.id, company.id, JSON.stringify(r.raw));
        accepted++;
      }
      db.prepare('UPDATE import_batches SET accepted_count=?,rejected_count=? WHERE id=?').run(accepted, rejected, batchId);
    })();
    deleteDraftRecord(db, 'import-preview');
    audit(importActor, 'import_batch', batchId, 'commit', null, { accepted, rejected, updated }, 'excel_import');
    res.json({ batchId, accepted, rejected, updated });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Import impossible' });
  }
});

app.get('/api/export.xlsx', (_req, res) => {
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('viper-export.xlsx').send(buildExport());
});

const safe = new Set(['companies', 'establishments', 'prospects', 'emails', 'phones', 'roles', 'commercial_segments', 'activity_categories', 'company_activity_categories', 'internal_referents', 'contact_tracking', 'contact_tracking_status_history', 'prospect_sources', 'import_batches', 'import_row_metadata', 'audit_log']);
app.get('/api/database/tables', (_req, res) => res.json(rows("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").filter(r => safe.has(String(r.name)))));
app.get('/api/database/table/:name', (req, res) => {
  if (!safe.has(req.params.name)) return res.status(400).json({ error: 'Table non exposée' });
  res.json({ data: rows(`SELECT * FROM ${req.params.name} LIMIT 100`), columns: rows(`PRAGMA table_info(${req.params.name})`), count: (db.prepare(`SELECT count(*) n FROM ${req.params.name}`).get() as { n: number }).n });
});
app.post('/api/database/sql', (req, res) => {
  try { res.json({ rows: db.prepare(assertReadOnlySql(String(req.body?.sql || ''))).all().slice(0, 500) }); }
  catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'SQL refusé' }); }
});
app.get('/api/search', (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  if (q === '%%') return res.json([]);
  res.json(rows("SELECT 'prospect' type,p.id,p.first_name||' '||p.last_name label,c.display_name detail FROM prospects p JOIN companies c ON c.id=p.company_id WHERE p.first_name||' '||p.last_name LIKE ? OR c.display_name LIKE ? UNION ALL SELECT 'company',c.id,c.display_name,c.email_domain FROM companies c WHERE c.display_name LIKE ? LIMIT 15", [q, q, q]));
});

app.listen(Number(process.env.PORT || 3001), () => console.log(`VIPER API on :${process.env.PORT || 3001}`));
