import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { db, migrate, rows } from './db.js';
import { login, logout, me, requireAuth } from './auth.js';
import { audit, type Actor } from './audit.js';
import { parseWorkbook } from './importer.js';
import { buildExport } from './exporter.js';
import { assertReadOnlySql } from './sqlSafety.js';

migrate();
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.post('/api/auth/login', login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', me);
app.use('/api', requireAuth);

const actor = (req: express.Request) => (req as any).actor || { type: 'human', id: 'pilot-user', display: 'Commercial VIPER' };
const nowIso = () => new Date().toISOString();
const norm = (v: unknown) => String(v || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function ensureCategory(label: string) {
  const clean = label.trim();
  if (!clean) return null;
  let category = db.prepare('SELECT id FROM activity_categories WHERE lower(label)=lower(?)').get(clean) as any;
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
  let ref = db.prepare("SELECT id FROM internal_referents WHERE lower(trim(first_name||' '||last_name))=lower(?)").get(clean) as any;
  if (!ref) {
    ref = { id: randomUUID() };
    db.prepare('INSERT INTO internal_referents(id,first_name,last_name) VALUES(?,?,?)').run(ref.id, firstName, lastName);
  }
  return ref.id as string;
}

function addTrackingHistory(trackingId: string, fromStatus: string | null, toStatus: string, a: any) {
  if (fromStatus === toStatus) return;
  db.prepare('INSERT INTO contact_tracking_status_history(id,contact_tracking_id,from_status,to_status,actor_type,actor_id) VALUES(?,?,?,?,?,?)')
    .run(randomUUID(), trackingId, fromStatus, toStatus, a.type || 'human', a.id || null);
}

function syncEmails(prospectId: string, items: any[] | undefined, forceUnverified = false) {
  if (!Array.isArray(items)) return;
  const existing = rows('SELECT * FROM emails WHERE prospect_id=?', [prospectId]) as any[];
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

function syncPhones(prospectId: string, items: any[] | undefined, forceUnverified = false) {
  if (!Array.isArray(items)) return;
  const existing = rows('SELECT * FROM phones WHERE prospect_id=?', [prospectId]) as any[];
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

function updateTracking(prospectId: string, incoming: any, a: any) {
  if (!incoming) return;
  let current = db.prepare('SELECT * FROM contact_tracking WHERE prospect_id=?').get(prospectId) as any;
  if (!current) {
    const id = randomUUID();
    const status = incoming.status || 'to_contact';
    const responseAt = status === 'response_received' ? nowIso() : (incoming.response_received_at || null);
    db.prepare('INSERT INTO contact_tracking(id,prospect_id,planned_contact_at,status,referent_id,response_received_at,appointment_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, prospectId, incoming.planned_contact_at || null, status, incoming.referent_id || null, responseAt, incoming.appointment_at || null);
    addTrackingHistory(id, null, status, a);
    return;
  }
  const status = incoming.status || current.status;
  const planned = incoming.planned_contact_at !== undefined ? (incoming.planned_contact_at || null) : current.planned_contact_at;
  const referentId = incoming.referent_id !== undefined ? (incoming.referent_id || null) : current.referent_id;
  const appointmentAt = incoming.appointment_at !== undefined ? (incoming.appointment_at || null) : current.appointment_at;
  const responseAt = current.response_received_at || (status === 'response_received' ? nowIso() : null);
  db.prepare('UPDATE contact_tracking SET planned_contact_at=?,status=?,referent_id=?,response_received_at=?,appointment_at=?,updated_at=CURRENT_TIMESTAMP WHERE prospect_id=?')
    .run(planned, status, referentId, responseAt, appointmentAt, prospectId);
  addTrackingHistory(current.id, current.status, status, a);
}

app.get('/api/dashboard', (_req, res) => {
  const one = (sql: string) => Number((db.prepare(sql).get() as any)?.n || 0);
  res.json({
    total: one('SELECT count(*) n FROM prospects'),
    neverVerified: one('SELECT count(*) n FROM prospects WHERE employment_verified_at IS NULL'),
    active: one("SELECT count(*) n FROM prospects WHERE activity_status='active'"),
    unknown: one("SELECT count(*) n FROM prospects WHERE activity_status='unknown'"),
    inactive: one("SELECT count(*) n FROM prospects WHERE activity_status='inactive'"),
    due: one("SELECT count(*) n FROM contact_tracking WHERE planned_contact_at<=date('now') AND status='to_contact'"),
    contacted: one("SELECT count(*) n FROM contact_tracking WHERE status<>'to_contact' AND status<>'not_interested'"),
    responses: one('SELECT count(*) n FROM contact_tracking WHERE response_received_at IS NOT NULL'),
    appointments: one('SELECT count(*) n FROM contact_tracking WHERE appointment_at IS NOT NULL'),
    emailIssues: one("SELECT count(*) n FROM prospects p WHERE NOT EXISTS(SELECT 1 FROM emails e WHERE e.prospect_id=p.id AND e.is_primary=1 AND e.is_active=1 AND e.verification_status='verified')"),
    nextActions: rows("SELECT p.id,p.first_name,p.last_name,c.display_name company,ct.planned_contact_at,ct.status FROM contact_tracking ct JOIN prospects p ON p.id=ct.prospect_id JOIN companies c ON c.id=p.company_id WHERE ct.planned_contact_at IS NOT NULL AND ct.status='to_contact' ORDER BY ct.planned_contact_at LIMIT 8"),
    recent: rows('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 8')
  });
});

app.get('/api/prospects', (req, res) => {
  const q = String(req.query.q || '').trim();
  const filter = String(req.query.filter || '');
  const company = String(req.query.company || '');
  const ps: any[] = [];
  let w = '1=1';
  if (q) {
    w += " AND (p.first_name||' '||p.last_name LIKE ? OR c.display_name LIKE ? OR e.address LIKE ? OR p.exact_job_title LIKE ?)";
    ps.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (company) { w += ' AND p.company_id=?'; ps.push(company); }
  if (filter === 'never_verified') w += ' AND p.employment_verified_at IS NULL';
  if (filter === 'verified') w += " AND p.employment_verified_at IS NOT NULL AND e.verification_status='verified'";
  if (filter === 'partial_verification') w += " AND p.employment_verified_at IS NOT NULL AND (e.id IS NULL OR e.verification_status<>'verified')";
  if (['active', 'inactive', 'unknown'].includes(filter)) { w += ' AND p.activity_status=?'; ps.push(filter); }
  if (filter === 'due') w += " AND ct.planned_contact_at<=date('now') AND ct.status='to_contact'";
  if (filter === 'contacted') w += " AND ct.status IN ('contacted','follow_up_1','follow_up_2')";
  if (filter === 'responses') w += ' AND ct.response_received_at IS NOT NULL';
  if (filter === 'appointments') w += ' AND ct.appointment_at IS NOT NULL';
  if (filter.startsWith('status:')) { w += ' AND ct.status=?'; ps.push(filter.slice(7)); }
  res.json(rows(`SELECT p.*,c.display_name company,r.label role,e.address primary_email,e.verification_status email_verification,e.last_verified_at email_verified_at,ct.status tracking_status,ct.planned_contact_at,ct.response_received_at,ct.appointment_at,trim(coalesce(ir.first_name,'')||' '||coalesce(ir.last_name,'')) referent,(SELECT max(h.changed_at) FROM contact_tracking_status_history h WHERE h.contact_tracking_id=ct.id AND h.to_status=ct.status) tracking_status_since FROM prospects p JOIN companies c ON c.id=p.company_id LEFT JOIN roles r ON r.id=p.role_id LEFT JOIN emails e ON e.prospect_id=p.id AND e.is_primary=1 AND e.is_active=1 LEFT JOIN contact_tracking ct ON ct.prospect_id=p.id LEFT JOIN internal_referents ir ON ir.id=ct.referent_id WHERE ${w} ORDER BY CASE WHEN ct.planned_contact_at IS NULL THEN 1 ELSE 0 END,ct.planned_contact_at,p.updated_at DESC LIMIT 500`, ps));
});

app.get('/api/prospects/:id', (req, res) => {
  const prospect = db.prepare('SELECT * FROM prospects WHERE id=?').get(req.params.id) as any;
  if (!prospect) return res.status(404).json({ error: 'Prospect introuvable' });
  const tracking = db.prepare('SELECT * FROM contact_tracking WHERE prospect_id=?').get(req.params.id) as any || null;
  res.json({
    prospect,
    company: db.prepare('SELECT * FROM companies WHERE id=?').get(prospect.company_id) || null,
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
  db.transaction(() => {
    db.prepare('INSERT INTO prospects(id,company_id,civility,first_name,last_name,role_id,exact_job_title,activity_status,employment_verified_at,contactability_status) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(id, b.company_id, b.civility || null, b.first_name, b.last_name, b.role_id || null, b.exact_job_title || null, b.activity_status || 'unknown', b.mark_employment_verified ? nowIso() : null, b.contactability_status || 'contactable');
    const trackingId = randomUUID();
    const initialStatus = b.tracking?.status || 'to_contact';
    db.prepare('INSERT INTO contact_tracking(id,prospect_id,status,planned_contact_at,referent_id,response_received_at,appointment_at) VALUES(?,?,?,?,?,?,?)')
      .run(trackingId, id, initialStatus, b.tracking?.planned_contact_at || null, b.tracking?.referent_id || null, initialStatus === 'response_received' ? nowIso() : null, b.tracking?.appointment_at || null);
    addTrackingHistory(trackingId, null, initialStatus, a);
    syncEmails(id, b.emails);
    syncPhones(id, b.phones);
    db.prepare('INSERT INTO prospect_sources(id,prospect_id,source_type,source_reference,created_by_actor) VALUES(?,?,?,?,?)').run(randomUUID(), id, 'manual', 'VIPER manual entry', a.id);
    audit(a, 'prospect', id, 'create', null, b, 'manual');
  })();
  res.status(201).json({ id });
});

app.put('/api/prospects/:id', (req, res) => {
  const b = req.body || {};
  const before = db.prepare('SELECT * FROM prospects WHERE id=?').get(req.params.id) as any;
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
      updateTracking(req.params.id, b.tracking, a);
      audit(a, 'prospect', req.params.id, 'update', before, b, 'manual');
    })();
    res.json({ ok: true, contactability, employment_verified_at: verifiedAt });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : 'Enregistrement impossible' });
  }
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
  app.get(`/api/settings/${route}`, (_req, res) => res.json(rows(`SELECT * FROM ${table} ORDER BY active DESC,label`)));
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
  try { res.json(parseWorkbook(req.file.buffer, req.file.originalname, new Date())); }
  catch (e) { res.status(400).json({ error: e instanceof Error ? e.message : 'Import impossible' }); }
});

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
        if (r.excluded || r.diagnostics?.some((d: any) => d.level === 'error')) { rejected++; continue; }
        const n = r.normalized || {};
        let company = db.prepare('SELECT * FROM companies WHERE lower(display_name)=lower(?)').get(n.company) as any;
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

        let prospect = db.prepare('SELECT * FROM prospects WHERE company_id=? AND lower(first_name)=lower(?) AND lower(last_name)=lower(?)').get(company.id, n.first_name, n.last_name) as any;
        const verifiedAt = n.verification_state === 'verified' ? (n.employment_verified_at || p.importedAt || nowIso()) : null;
        if (!prospect) {
          prospect = { id: randomUUID(), employment_verified_at: verifiedAt };
          db.prepare('INSERT INTO prospects(id,company_id,civility,first_name,last_name,exact_job_title,activity_status,employment_verified_at) VALUES(?,?,?,?,?,?,?,?)')
            .run(prospect.id, company.id, n.civility || null, n.first_name, n.last_name, n.job_title || null, n.activity_status_suggestion || 'unknown', verifiedAt);
        } else {
          updated++;
          const nextVerifiedAt = verifiedAt || prospect.employment_verified_at || null;
          db.prepare(`UPDATE prospects SET civility=coalesce(nullif(?,''),civility),exact_job_title=coalesce(nullif(?,''),exact_job_title),activity_status=CASE WHEN ?='inactive' THEN 'inactive' ELSE activity_status END,employment_verified_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(n.civility || '', n.job_title || '', n.activity_status_suggestion || '', nextVerifiedAt, prospect.id);
        }

        let tracking = db.prepare('SELECT * FROM contact_tracking WHERE prospect_id=?').get(prospect.id) as any;
        const referentId = n.referent ? ensureReferent(String(n.referent)) : null;
        const importedStatus = n.tracking_status || 'to_contact';
        if (!tracking) {
          tracking = { id: randomUUID(), status: importedStatus };
          db.prepare('INSERT INTO contact_tracking(id,prospect_id,planned_contact_at,status,referent_id,response_received_at) VALUES(?,?,?,?,?,?)')
            .run(tracking.id, prospect.id, n.planned_contact_at || null, importedStatus, referentId, importedStatus === 'response_received' ? (p.importedAt || nowIso()) : null);
          addTrackingHistory(tracking.id, null, importedStatus, importActor);
        } else {
          const nextStatus = tracking.status === 'to_contact' && importedStatus !== 'to_contact' ? importedStatus : tracking.status;
          const nextResponseAt = tracking.response_received_at || (nextStatus === 'response_received' ? (p.importedAt || nowIso()) : null);
          db.prepare('UPDATE contact_tracking SET planned_contact_at=coalesce(?,planned_contact_at),status=?,referent_id=coalesce(?,referent_id),response_received_at=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
            .run(n.planned_contact_at || null, nextStatus, referentId, nextResponseAt, tracking.id);
          addTrackingHistory(tracking.id, tracking.status, nextStatus, importActor);
        }

        if (n.email) {
          const existingEmail = db.prepare('SELECT * FROM emails WHERE lower(address)=lower(?)').get(n.email) as any;
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
  res.json({ data: rows(`SELECT * FROM ${req.params.name} LIMIT 100`), columns: rows(`PRAGMA table_info(${req.params.name})`), count: (db.prepare(`SELECT count(*) n FROM ${req.params.name}`).get() as any).n });
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
