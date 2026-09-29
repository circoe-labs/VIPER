import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../src/server/schema.js';
import { migrateContactTracking } from '../src/server/contactTrackingSchema.js';
import {
  LEGACY_STATUS_MIGRATION_ID, legacyTrackingStatuses, mapLegacyTrackingStatus, reconcileLegacyTrackingStatuses, toProspectStateForWrite
} from '../src/server/contactTrackingReconciliation.js';

// DDL de `contact_tracking` avant la Task 02 (statut par défaut `to_contact`, semaine legacy).
const LEGACY_CONTACT_TRACKING = "CREATE TABLE contact_tracking(id TEXT PRIMARY KEY,prospect_id TEXT NOT NULL UNIQUE,planned_contact_at TEXT,contact_year INTEGER,contact_week INTEGER,status TEXT NOT NULL DEFAULT 'to_contact',referent_id TEXT,response_received_at TEXT,appointment_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(prospect_id) REFERENCES prospects(id) ON DELETE CASCADE,FOREIGN KEY(referent_id) REFERENCES internal_referents(id))";

// Fixture synthétique : une ligne par statut legacy + cas limites (blocage durable, valeur inattendue, `ignored` non protégé).
type FixtureRow = { id: string; status: string; dnc?: boolean; week?: [number, number]; planned?: string; activity?: string };
const fixture: FixtureRow[] = [
  { id: 'to_contact', status: 'to_contact', week: [2026, 40] },
  { id: 'to_contact_planned', status: 'to_contact', planned: '2026-10-05' },
  { id: 'to_contact_bad_week', status: 'to_contact', week: [2025, 53] },
  { id: 'contacted', status: 'contacted', week: [2026, 42], activity: 'active' },
  { id: 'follow_up_1', status: 'follow_up_1', week: [2026, 44] },
  { id: 'follow_up_2', status: 'follow_up_2', week: [2026, 53] },
  { id: 'response_received', status: 'response_received' },
  { id: 'appointment_obtained', status: 'appointment_obtained' },
  { id: 'quote_sent', status: 'quote_sent' },
  { id: 'quote_follow_up', status: 'quote_follow_up' },
  { id: 'won', status: 'won', activity: 'inactive' },
  { id: 'not_interested', status: 'not_interested' },
  { id: 'not_interested_dnc', status: 'not_interested', dnc: true },
  { id: 'contacted_dnc', status: 'contacted', dnc: true },
  { id: 'ignored_unprotected', status: 'ignored' },
  { id: 'unexpected', status: 'pending_review' }
];
const expectedStatus: Record<string, string> = {
  to_contact: 'neutral', to_contact_planned: 'neutral', to_contact_bad_week: 'neutral', contacted: 'contacted', follow_up_1: 'r1', follow_up_2: 'r2',
  response_received: 'response_received', appointment_obtained: 'appointment_obtained', quote_sent: 'appointment_obtained',
  quote_follow_up: 'appointment_obtained', won: 'appointment_obtained', not_interested: 'failure', not_interested_dnc: 'ignored',
  contacted_dnc: 'contacted', ignored_unprotected: 'ignored', unexpected: 'pending_review'
};
const CONVERTED = 10; // lignes dont le statut legacy change de valeur

function seed(db: Database.Database) {
  db.prepare("INSERT INTO companies(id,display_name) VALUES('c1','Synthetic Co')").run();
  for (const row of fixture) {
    db.prepare("INSERT INTO prospects(id,company_id,first_name,last_name,activity_status,contactability_status,do_not_contact_at) VALUES(?,'c1','P','Test',?,?,?)")
      .run(`p_${row.id}`, row.activity || 'unknown', row.dnc ? 'do_not_contact' : 'contactable', row.dnc ? '2026-01-01T00:00:00Z' : null);
    db.prepare('INSERT INTO contact_tracking(id,prospect_id,planned_contact_at,contact_year,contact_week,status) VALUES(?,?,?,?,?,?)')
      .run(`t_${row.id}`, `p_${row.id}`, row.planned || null, row.week?.[0] ?? null, row.week?.[1] ?? null, row.status);
    db.prepare("INSERT INTO contact_tracking_status_history(id,contact_tracking_id,from_status,to_status,changed_at,actor_type) VALUES(?,?,NULL,'to_contact','2026-01-01 00:00:00','import')").run(`h_${row.id}_a`, `t_${row.id}`);
    if (row.status !== 'to_contact') db.prepare("INSERT INTO contact_tracking_status_history(id,contact_tracking_id,from_status,to_status,changed_at,actor_type,actor_id) VALUES(?,?,'to_contact',?,'2026-02-01 00:00:00','human','u1')").run(`h_${row.id}_b`, `t_${row.id}`, row.status);
  }
}

/** Base legacy synthétique, migration Task 02 appliquée (précondition de la réconciliation). */
function legacyDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(LEGACY_CONTACT_TRACKING);
  db.exec(schema);
  seed(db);
  migrateContactTracking(db);
  return db;
}

const statuses = (db: Database.Database) => Object.fromEntries((db.prepare('SELECT id,status FROM contact_tracking').all() as { id: string; status: string }[]).map(r => [r.id.slice(2), r.status]));
const snapshot = (db: Database.Database) => ['contact_tracking', 'contact_tracking_status_history', 'prospects', 'audit_log', 'schema_migrations']
  .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());

describe('mapping des statuts legacy', () => {
  it('applique exactement la table du modèle de données', () => {
    expect(Object.fromEntries(legacyTrackingStatuses.map(s => [s, mapLegacyTrackingStatus(s, false)]))).toEqual({
      to_contact: 'neutral', contacted: 'contacted', follow_up_1: 'r1', follow_up_2: 'r2', response_received: 'response_received',
      appointment_obtained: 'appointment_obtained', quote_sent: 'appointment_obtained', quote_follow_up: 'appointment_obtained',
      won: 'appointment_obtained', not_interested: 'failure'
    });
    expect(mapLegacyTrackingStatus('not_interested', true)).toBe('ignored');
    expect(mapLegacyTrackingStatus('contacted', true)).toBe('contacted');
  });

  it('n’écrit jamais de statut legacy ou inconnu', () => {
    expect(toProspectStateForWrite(undefined, false)).toBe('neutral');
    expect(toProspectStateForWrite('', false)).toBe('neutral');
    expect(toProspectStateForWrite('r1', false)).toBe('r1');
    expect(toProspectStateForWrite('to_contact', false)).toBe('neutral');
    expect(toProspectStateForWrite('follow_up_2', false)).toBe('r2');
    expect(toProspectStateForWrite('won', false)).toBe('appointment_obtained');
    expect(toProspectStateForWrite('not_interested', true)).toBe('ignored');
    expect(() => toProspectStateForWrite('pending_review', false)).toThrow('État de suivi invalide');
  });
});

describe('réconciliation contact_tracking — base legacy', () => {
  it('convertit chaque statut legacy sans perte et laisse les valeurs inattendues en revue', () => {
    const db = legacyDb();
    const report = reconcileLegacyTrackingStatuses(db)!;
    expect(statuses(db)).toEqual(expectedStatus);
    expect(report).toMatchObject({
      id: LEGACY_STATUS_MIGRATION_ID, dryRun: false, trackingRows: fixture.length, historyRowsAdded: CONVERTED,
      statusCountsBefore: { to_contact: 3, contacted: 2, follow_up_1: 1, follow_up_2: 1, response_received: 1, appointment_obtained: 1, quote_sent: 1, quote_follow_up: 1, won: 1, not_interested: 2, ignored: 1, pending_review: 1 },
      statusCountsAfter: { neutral: 3, contacted: 2, r1: 1, r2: 1, response_received: 1, appointment_obtained: 4, failure: 1, ignored: 2, pending_review: 1 },
      conversions: {
        'to_contact->neutral': 3, 'follow_up_1->r1': 1, 'follow_up_2->r2': 1, 'quote_sent->appointment_obtained': 1,
        'quote_follow_up->appointment_obtained': 1, 'won->appointment_obtained': 1, 'not_interested->failure': 1, 'not_interested->ignored': 1
      },
      unexpectedStatuses: { pending_review: 1 },
      doNotContactReinforced: 1, doNotContactNotIgnored: 1, neutralWithPlannedDateOnly: 1, legacyWeekUnmapped: 1,
      activityStatusUnknown: fixture.length - 2
    });
    // Aucun statut legacy hors contrat ne reste actif ; aucun prospect perdu.
    const remainingLegacy = db.prepare("SELECT count(*) n FROM contact_tracking WHERE status IN ('to_contact','follow_up_1','follow_up_2','quote_sent','quote_follow_up','won','not_interested')").get();
    expect(remainingLegacy).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM prospects').get()).toEqual({ n: fixture.length });
    expect(JSON.stringify(report)).not.toMatch(/Synthetic|Test|"[pt]_/); // rapport non-PII
  });

  it('conserve la prochaine semaine des anciens to_contact', () => {
    const db = legacyDb();
    reconcileLegacyTrackingStatuses(db);
    const row = (id: string) => db.prepare('SELECT status,next_action_year y,next_action_week w,planned_contact_at planned FROM contact_tracking WHERE id=?').get(`t_${id}`);
    expect(row('to_contact')).toEqual({ status: 'neutral', y: 2026, w: 40, planned: null });
    expect(row('to_contact_planned')).toEqual({ status: 'neutral', y: null, w: null, planned: '2026-10-05' });
    expect(row('follow_up_2')).toEqual({ status: 'r2', y: 2026, w: 53, planned: null });
  });

  it('préserve l’historique ancien et trace chaque conversion (ancien statut conservé)', () => {
    const db = legacyDb();
    const historyBefore = db.prepare('SELECT * FROM contact_tracking_status_history ORDER BY id').all();
    reconcileLegacyTrackingStatuses(db);
    expect(db.prepare("SELECT * FROM contact_tracking_status_history WHERE actor_type<>'system' ORDER BY id").all()).toEqual(historyBefore);
    const added = db.prepare("SELECT contact_tracking_id t,from_status f,to_status s,actor_id a FROM contact_tracking_status_history WHERE actor_type='system' ORDER BY contact_tracking_id").all() as { t: string; f: string; s: string; a: string }[];
    expect(added).toHaveLength(CONVERTED);
    expect(added.every(h => h.a === LEGACY_STATUS_MIGRATION_ID && h.s === expectedStatus[h.t.slice(2)])).toBe(true);
    expect(added.filter(h => h.s === 'appointment_obtained').map(h => h.f).sort()).toEqual(['quote_follow_up', 'quote_sent', 'won']);
    expect(db.prepare("SELECT action FROM audit_log WHERE entity_type='schema_migration' AND entity_id=?").get(LEGACY_STATUS_MIGRATION_ID)).toEqual({ action: 'legacy_status_reconciliation' });
  });

  it('respecte do_not_contact : jamais rendu contactable, renforcé pour un ignored', () => {
    const db = legacyDb();
    reconcileLegacyTrackingStatuses(db);
    const dnc = (db.prepare("SELECT id FROM prospects WHERE contactability_status='do_not_contact' ORDER BY id").all() as { id: string }[]).map(r => r.id);
    expect(dnc).toEqual(['p_contacted_dnc', 'p_ignored_unprotected', 'p_not_interested_dnc']);
    expect(db.prepare("SELECT do_not_contact_at FROM prospects WHERE id='p_not_interested_dnc'").get()).toEqual({ do_not_contact_at: '2026-01-01T00:00:00Z' });
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE entity_id='p_ignored_unprotected' AND action='reinforce_do_not_contact'").get()).toEqual({ n: 1 });
  });

  it('est idempotente et enregistrée une seule fois', () => {
    const db = legacyDb();
    expect(reconcileLegacyTrackingStatuses(db)).not.toBeNull();
    const after = snapshot(db);
    expect(reconcileLegacyTrackingStatuses(db)).toBeNull();
    expect(snapshot(db)).toEqual(after);
    expect(db.prepare('SELECT count(*) n FROM schema_migrations WHERE id=?').get(LEGACY_STATUS_MIGRATION_ID)).toEqual({ n: 1 });
  });

  it('dry-run : même rapport, aucune écriture', () => {
    const db = legacyDb();
    const before = snapshot(db);
    const beforeApply = vi.fn();
    const dry = reconcileLegacyTrackingStatuses(db, { dryRun: true, beforeApply })!;
    expect(snapshot(db)).toEqual(before);
    expect(beforeApply).not.toHaveBeenCalled();
    expect(reconcileLegacyTrackingStatuses(db)).toEqual({ ...dry, dryRun: false });
  });

  it('appelle le hook d’instantané uniquement si des lignes vont changer', () => {
    const legacy = legacyDb();
    const hook = vi.fn();
    reconcileLegacyTrackingStatuses(legacy, { beforeApply: hook });
    expect(hook).toHaveBeenCalledOnce();

    const fresh = new Database(':memory:');
    fresh.exec(schema);
    migrateContactTracking(fresh);
    const freshHook = vi.fn();
    expect(reconcileLegacyTrackingStatuses(fresh, { beforeApply: freshHook })).toMatchObject({ trackingRows: 0, historyRowsAdded: 0, conversions: {} });
    expect(freshHook).not.toHaveBeenCalled();
  });

  it('annule tout si une écriture échoue', () => {
    const db = legacyDb();
    db.exec("CREATE TRIGGER fail_on_won BEFORE INSERT ON contact_tracking_status_history WHEN NEW.from_status='won' BEGIN SELECT RAISE(ABORT,'boom'); END");
    const before = snapshot(db);
    expect(() => reconcileLegacyTrackingStatuses(db)).toThrow('boom');
    expect(snapshot(db)).toEqual(before);
  });
});

describe('migrate() du serveur — réconciliation', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prend un instantané, convertit une fois et journalise un rapport', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-reconciliation-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'viper.sqlite');
    // Fixture construite en mémoire puis écrite d'un bloc : sur disque, chaque INSERT en autocommit coûte un fsync
    // (plusieurs secondes sous charge parallèle, timeout Vitest dépassé).
    const legacy = new Database(':memory:');
    legacy.pragma('foreign_keys = ON');
    legacy.exec(LEGACY_CONTACT_TRACKING);
    legacy.exec(schema);
    seed(legacy);
    fs.writeFileSync(dbPath, legacy.serialize());
    legacy.close();
    vi.stubEnv('VIPER_DB_PATH', dbPath);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = await import('../src/server/db.js');
    try {
      server.migrate();
      server.migrate();
      const snapshots = fs.readdirSync(dir).filter(f => f.includes(`.before-${LEGACY_STATUS_MIGRATION_ID}-`));
      expect(snapshots).toHaveLength(1);
      const snap = new Database(path.join(dir, snapshots[0]), { readonly: true });
      expect(snap.prepare("SELECT count(*) n FROM contact_tracking WHERE status='to_contact'").get()).toEqual({ n: 3 });
      snap.close();
      expect(statuses(server.db)).toEqual(expectedStatus);
      expect(log.mock.calls.filter(c => String(c[0]).includes(LEGACY_STATUS_MIGRATION_ID))).toHaveLength(1);
      expect(warn.mock.calls.some(c => String(c[0]).includes('pending_review'))).toBe(true);
    } finally {
      server.db.close();
    }
  });
});
