import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { schema } from '../src/server/schema.js';
import { CONTACT_TRACKING_MIGRATION_ID, migrateContactTracking, resolveIncomingNextAction, toNextActionWeek } from '../src/server/contactTrackingSchema.js';

// DDL exact de `contact_tracking` avant la Task 02 (schéma initial + colonnes ajoutées par l'ancien ensureColumn).
const LEGACY_CONTACT_TRACKING = "CREATE TABLE contact_tracking(id TEXT PRIMARY KEY,prospect_id TEXT NOT NULL UNIQUE,planned_contact_at TEXT,contact_year INTEGER,contact_week INTEGER,status TEXT NOT NULL DEFAULT 'to_contact',referent_id TEXT,response_received_at TEXT,appointment_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,FOREIGN KEY(prospect_id) REFERENCES prospects(id) ON DELETE CASCADE,FOREIGN KEY(referent_id) REFERENCES internal_referents(id))";

const legacyStatuses = ['to_contact', 'contacted', 'follow_up_1', 'follow_up_2', 'response_received', 'appointment_obtained', 'quote_sent', 'quote_follow_up', 'won', 'not_interested'];
// [année, semaine, date planifiée] par ligne : couples valides, S53 aux frontières d'année, couples incomplets.
const weeks: [number | null, number | null, string | null][] = [
  [2026, 37, null], [2026, 53, null], [2025, 53, null], [2027, 1, null], [null, 40, null],
  [2026, null, null], [null, null, '2026-10-05'], [null, null, null], [2026, 39, '2026-09-21'], [2020, 53, null]
];

function openDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

function seed(db: Database.Database) {
  db.prepare("INSERT INTO companies(id,display_name) VALUES('c1','Synthetic Co')").run();
  legacyStatuses.forEach((status, i) => {
    const [year, week, planned] = weeks[i];
    db.prepare("INSERT INTO prospects(id,company_id,first_name,last_name) VALUES(?,'c1','P','Test')").run(`p${i}`);
    db.prepare('INSERT INTO contact_tracking(id,prospect_id,planned_contact_at,contact_year,contact_week,status) VALUES(?,?,?,?,?,?)').run(`t${i}`, `p${i}`, planned, year, week, status);
    db.prepare("INSERT INTO contact_tracking_status_history(id,contact_tracking_id,from_status,to_status,actor_type) VALUES(?,?,NULL,'to_contact','import')").run(`h${i}a`, `t${i}`);
    if (status !== 'to_contact') db.prepare("INSERT INTO contact_tracking_status_history(id,contact_tracking_id,from_status,to_status,actor_type,actor_id) VALUES(?,?,'to_contact',?,'human','u1')").run(`h${i}b`, `t${i}`, status);
  });
}

function legacyDb() {
  const db = openDb();
  db.exec(LEGACY_CONTACT_TRACKING);
  db.exec(schema);
  seed(db);
  return db;
}

const statusDefault = (db: Database.Database) => (db.prepare('PRAGMA table_info(contact_tracking)').all() as { name: string; dflt_value: string }[]).find(c => c.name === 'status')?.dflt_value;
const tracking = (db: Database.Database) => db.prepare('SELECT * FROM contact_tracking ORDER BY id').all() as Record<string, unknown>[];
const history = (db: Database.Database) => db.prepare('SELECT * FROM contact_tracking_status_history ORDER BY id').all();

describe('migration contact_tracking — base neuve', () => {
  it('crée l’état neutral par défaut et une prochaine échéance NULL', () => {
    const db = openDb();
    db.exec(schema);
    const report = migrateContactTracking(db);
    expect(report).toMatchObject({ id: CONTACT_TRACKING_MIGRATION_ID, rebuilt: false, trackingRows: 0, nextActionBackfilled: 0, preservedLegacyColumns: [] });
    db.prepare("INSERT INTO companies(id,display_name) VALUES('c1','Synthetic Co')").run();
    db.prepare("INSERT INTO prospects(id,company_id,first_name,last_name) VALUES('p1','c1','P','Test')").run();
    db.prepare("INSERT INTO contact_tracking(id,prospect_id) VALUES('t1','p1')").run();
    expect(db.prepare("SELECT status,next_action_year,next_action_week FROM contact_tracking WHERE id='t1'").get()).toEqual({ status: 'neutral', next_action_year: null, next_action_week: null });
    const names = (db.prepare('PRAGMA table_info(contact_tracking)').all() as { name: string }[]).map(c => c.name);
    expect(names).not.toContain('contact_week');
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='ix_contact_tracking_next_action'").get()).toBeTruthy();
  });

  it('refuse une échéance incomplète ou hors bornes', () => {
    const db = openDb();
    db.exec(schema);
    migrateContactTracking(db);
    db.prepare("INSERT INTO companies(id,display_name) VALUES('c1','Synthetic Co')").run();
    db.prepare("INSERT INTO prospects(id,company_id,first_name,last_name) VALUES('p1','c1','P','Test')").run();
    const insert = db.prepare("INSERT INTO contact_tracking(id,prospect_id,next_action_year,next_action_week) VALUES('t1','p1',?,?)");
    expect(() => insert.run(2026, null)).toThrow(/CHECK/);
    expect(() => insert.run(null, 40)).toThrow(/CHECK/);
    expect(() => insert.run(2026, 54)).toThrow(/CHECK/);
    expect(() => insert.run(2026, 0)).toThrow(/CHECK/);
    insert.run(2026, 53);
  });
});

describe('migration contact_tracking — base legacy', () => {
  it('reconstruit la table sans perte : lignes, statuts, historique, colonnes legacy', () => {
    const db = legacyDb();
    const before = tracking(db);
    const historyBefore = history(db);
    const report = migrateContactTracking(db)!;
    expect(report).toMatchObject({ rebuilt: true, trackingRows: 10, historyRows: 19, nextActionBackfilled: 5, legacyWeekUnmapped: 3, plannedDateWithoutWeek: 1, preservedLegacyColumns: ['contact_year', 'contact_week'] });
    expect(statusDefault(db)).toBe("'neutral'");
    const after = tracking(db);
    expect(after).toHaveLength(before.length);
    after.forEach((row, i) => {
      expect(row).toEqual({ ...before[i], next_action_year: row.next_action_year, next_action_week: row.next_action_week }); // statuts legacy inchangés (Task 03), colonnes legacy conservées
    });
    expect(history(db)).toEqual(historyBefore);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('ne copie que des semaines ISO cohérentes aux frontières d’année', () => {
    const db = legacyDb();
    migrateContactTracking(db);
    const next = Object.fromEntries((db.prepare('SELECT id,next_action_year y,next_action_week w FROM contact_tracking').all() as { id: string; y: number | null; w: number | null }[]).map(r => [r.id, [r.y, r.w]]));
    expect(next).toEqual({
      t0: [2026, 37], t1: [2026, 53], t2: [null, null], t3: [2027, 1], t4: [null, null],
      t5: [null, null], t6: [null, null], t7: [null, null], t8: [2026, 39], t9: [2020, 53]
    });
    // L'ancienne valeur non convertible reste lisible pour la réconciliation (Task 03).
    expect(db.prepare("SELECT contact_year,contact_week FROM contact_tracking WHERE id='t2'").get()).toEqual({ contact_year: 2025, contact_week: 53 });
  });

  it('est idempotente : un second passage ne change rien, même après une édition', () => {
    const db = legacyDb();
    expect(migrateContactTracking(db)).not.toBeNull();
    db.prepare("UPDATE contact_tracking SET next_action_year=NULL,next_action_week=NULL WHERE id='t0'").run();
    const snapshot = [tracking(db), history(db)];
    expect(migrateContactTracking(db)).toBeNull();
    expect([tracking(db), history(db)]).toEqual(snapshot);
    expect(db.prepare('SELECT count(*) n FROM schema_migrations').get()).toEqual({ n: 1 });
  });

  it('garde les clés étrangères actives après reconstruction (cascade historique)', () => {
    const db = legacyDb();
    migrateContactTracking(db);
    db.prepare("DELETE FROM prospects WHERE id='p1'").run();
    expect(db.prepare("SELECT count(*) n FROM contact_tracking_status_history WHERE contact_tracking_id='t1'").get()).toEqual({ n: 0 });
    expect(() => db.prepare("INSERT INTO contact_tracking(id,prospect_id) VALUES('tx','missing')").run()).toThrow(/FOREIGN KEY/);
  });

  it('préserve les index existants et appelle le hook d’instantané avant reconstruction', () => {
    const db = legacyDb();
    db.exec('CREATE INDEX ix_legacy_status ON contact_tracking(status)');
    const beforeRebuild = vi.fn();
    migrateContactTracking(db, { beforeRebuild });
    expect(beforeRebuild).toHaveBeenCalledOnce();
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='ix_legacy_status' AND tbl_name='contact_tracking'").get()).toBeTruthy();
  });

  it('annule tout et rétablit les clés étrangères si la copie échoue', () => {
    const db = openDb();
    db.exec(LEGACY_CONTACT_TRACKING.replace('contact_week INTEGER,', 'contact_week INTEGER,next_action_year INTEGER,next_action_week INTEGER,'));
    db.exec(schema);
    seed(db);
    db.prepare("UPDATE contact_tracking SET next_action_year=2026,next_action_week=60 WHERE id='t0'").run();
    const before = tracking(db);
    expect(() => migrateContactTracking(db)).toThrow(/CHECK/);
    expect(tracking(db)).toEqual(before);
    expect(statusDefault(db)).toBe("'to_contact'");
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare('SELECT count(*) n FROM schema_migrations').get()).toEqual({ n: 0 });
  });

  it('migre une sauvegarde legacy restaurée (même chemin que restoreDatabase)', () => {
    const buffer = legacyDb().serialize();
    const restored = new Database(buffer);
    restored.pragma('foreign_keys = ON');
    restored.exec(schema);
    expect(migrateContactTracking(restored)).toMatchObject({ rebuilt: true, trackingRows: 10, historyRows: 19 });
    expect(statusDefault(restored)).toBe("'neutral'");
  });
});

describe('prochaine échéance entrante', () => {
  it('valide le couple année/semaine ISO', () => {
    expect(toNextActionWeek(null, undefined)).toBeNull();
    expect(toNextActionWeek('', '')).toBeNull();
    expect(toNextActionWeek(2026, '53')).toEqual({ year: 2026, week: 53 });
    expect(() => toNextActionWeek(2025, 53)).toThrow('Semaine de prochaine action invalide');
    expect(() => toNextActionWeek(2026, null)).toThrow();
    expect(() => toNextActionWeek(null, 12)).toThrow();
  });

  it('priorise next_action_*, accepte les alias legacy, sinon conserve la valeur courante', () => {
    const current = { year: 2026, week: 40 };
    expect(resolveIncomingNextAction({ status: 'contacted' }, current)).toBe(current);
    expect(resolveIncomingNextAction({ contact_year: 2027, contact_week: 2 }, current)).toEqual({ year: 2027, week: 2 });
    expect(resolveIncomingNextAction({ next_action_year: null, next_action_week: null, contact_year: 2026, contact_week: 37 }, current)).toBeNull();
    expect(resolveIncomingNextAction({ next_action_year: 2026, next_action_week: 41, contact_year: 2026, contact_week: 37 }, current)).toEqual({ year: 2026, week: 41 });
  });
});

describe('migrate() du serveur sur une base persistante legacy', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('prend un instantané, migre, puis restaure/migre une sauvegarde legacy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-migration-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'viper.sqlite');
    // Fixture construite en mémoire puis écrite d'un bloc : sur disque, chaque INSERT en autocommit coûte un fsync
    // (plusieurs secondes sous charge parallèle, timeout Vitest dépassé).
    const legacy = new Database(':memory:');
    legacy.pragma('foreign_keys = ON');
    legacy.exec(LEGACY_CONTACT_TRACKING);
    legacy.exec(schema);
    seed(legacy);
    const legacyBackup = legacy.serialize();
    fs.writeFileSync(dbPath, legacyBackup);
    legacy.close();
    vi.stubEnv('VIPER_DB_PATH', dbPath);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const server = await import('../src/server/db.js');
    try {
      server.migrate();
      server.migrate();
      const snapshots = fs.readdirSync(dir).filter(f => f.includes(`.before-${CONTACT_TRACKING_MIGRATION_ID}-`));
      expect(snapshots).toHaveLength(1);
      const snapshot = new Database(path.join(dir, snapshots[0]), { readonly: true });
      expect(statusDefault(snapshot)).toBe("'to_contact'");
      expect(snapshot.prepare('SELECT count(*) n FROM contact_tracking_status_history').get()).toEqual({ n: 19 });
      snapshot.close();
      expect(statusDefault(server.db)).toBe("'neutral'");
      expect(server.db.prepare('SELECT count(*) n FROM contact_tracking WHERE next_action_week IS NOT NULL').get()).toEqual({ n: 5 });

      server.db.prepare('DELETE FROM prospects').run();
      server.restoreDatabase(legacyBackup);
      expect(statusDefault(server.db)).toBe("'neutral'");
      // 19 lignes d'origine intactes + 7 lignes de conversion ajoutées par la réconciliation legacy (Task 03).
      expect(server.db.prepare("SELECT count(*) n FROM contact_tracking_status_history WHERE actor_type<>'system'").get()).toEqual({ n: 19 });
      expect(server.db.prepare('SELECT count(*) n FROM contact_tracking_status_history').get()).toEqual({ n: 26 });
    } finally {
      server.db.close();
    }
  });
});
