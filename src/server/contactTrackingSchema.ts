// Migration du suivi prospect (Task 02) : défaut `neutral` + prochaine échéance `next_action_year/next_action_week`.
// Non destructive : aucune ligne supprimée, colonnes legacy `contact_year/contact_week` conservées gelées (nettoyage en 2e temps),
// historique `contact_tracking_status_history` intact. Exécutée une seule fois (table `schema_migrations`), atomique.
// Les statuts legacy (`to_contact`, `follow_up_1`...) ne sont PAS convertis ici : réconciliation = Task 03.
import type Database from 'better-sqlite3';
import { DEFAULT_PROSPECT_STATE, isValidIsoWeek, type IsoWeek } from '../shared/contactWorkflow.js';
import { contactTrackingColumns, contactTrackingConstraints } from './schema.js';

export const CONTACT_TRACKING_MIGRATION_ID = '2026-09-contact-02-next-action';
const NEXT_ACTION_INDEX_SQL = 'CREATE INDEX IF NOT EXISTS ix_contact_tracking_next_action ON contact_tracking(next_action_year,next_action_week)';

/** Compteurs non-PII de la migration (journalisés et stockés dans `schema_migrations.report`). */
export type ContactTrackingMigrationReport = {
  id: string;
  rebuilt: boolean;
  trackingRows: number;
  historyRows: number;
  nextActionBackfilled: number;
  /** Couple legacy incomplet ou semaine ISO inexistante : laissé tel quel dans `contact_year/contact_week` (à arbitrer Task 03). */
  legacyWeekUnmapped: number;
  /** Lignes avec `planned_contact_at` mais sans prochaine semaine (date legacy non convertie en semaine métier). */
  plannedDateWithoutWeek: number;
  preservedLegacyColumns: string[];
};

type Column = { name: string; type: string; dflt_value: string | null };
type Db = Database.Database;

const quoteId = (name: string) => `"${name.replace(/"/g, '""')}"`;
const tableColumns = (db: Db, table: string) => db.prepare(`PRAGMA table_info(${table})`).all() as Column[];
const count = (db: Db, sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
const fkViolations = (db: Db) => ['contact_tracking', 'contact_tracking_status_history']
  .reduce((n, table) => n + (db.pragma(`foreign_key_check(${table})`) as unknown[]).length, 0);
// `contactTrackingColumns` ne contient aucune virgule hors séparateurs de colonnes.
const canonicalColumns = contactTrackingColumns.split(',').map(def => def.trim().split(/\s+/)[0]);

const needsRebuild = (columns: Column[]) => {
  const names = new Set(columns.map(c => c.name));
  const status = columns.find(c => c.name === 'status');
  return !names.has('next_action_year') || !names.has('next_action_week') || status?.dflt_value !== `'${DEFAULT_PROSPECT_STATE}'`;
};

// Procédure SQLite « 12 étapes » : nouvelle table, copie de toutes les colonnes, DROP/RENAME, index/triggers recréés.
// Appelée dans une transaction avec foreign_keys=OFF (sinon le DROP cascaderait sur l'historique).
function rebuildContactTracking(db: Db, legacy: Column[]) {
  const extra = legacy.filter(c => !canonicalColumns.includes(c.name))
    .map(c => `${quoteId(c.name)} ${c.type}${c.dflt_value !== null ? ` DEFAULT ${c.dflt_value}` : ''}`);
  const dependents = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='contact_tracking' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as { sql: string }[];
  const copied = legacy.map(c => quoteId(c.name)).join(',');
  db.exec(`CREATE TABLE contact_tracking__next(${[contactTrackingColumns, ...extra, contactTrackingConstraints].join(',')})`);
  db.exec(`INSERT INTO contact_tracking__next(${copied}) SELECT ${copied} FROM contact_tracking`);
  db.exec('DROP TABLE contact_tracking');
  db.exec('ALTER TABLE contact_tracking__next RENAME TO contact_tracking');
  for (const { sql } of dependents) db.exec(sql);
}

// Copie `contact_year/contact_week` -> `next_action_*` uniquement pour un couple complet et valide en calendrier ISO.
function backfillNextAction(db: Db) {
  const names = new Set(tableColumns(db, 'contact_tracking').map(c => c.name));
  if (!names.has('contact_year') || !names.has('contact_week')) return { backfilled: 0, unmapped: 0 };
  const candidates = db.prepare('SELECT id,contact_year year,contact_week week FROM contact_tracking WHERE next_action_year IS NULL AND next_action_week IS NULL AND (contact_year IS NOT NULL OR contact_week IS NOT NULL)').all() as { id: string; year: unknown; week: unknown }[];
  const update = db.prepare('UPDATE contact_tracking SET next_action_year=?,next_action_week=? WHERE id=?');
  let backfilled = 0;
  for (const row of candidates) {
    const week = { year: row.year, week: row.week };
    if (!isValidIsoWeek(week)) continue;
    update.run(week.year, week.week, row.id);
    backfilled++;
  }
  return { backfilled, unmapped: candidates.length - backfilled };
}

/**
 * Applique la migration si elle ne l'a pas déjà été ; `null` = déjà appliquée (idempotent).
 * Précondition : `db.exec(schema)` exécuté. `beforeRebuild` permet un instantané de la base avant reconstruction.
 */
export function migrateContactTracking(db: Db, options: { beforeRebuild?: () => void } = {}): ContactTrackingMigrationReport | null {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(CONTACT_TRACKING_MIGRATION_ID)) {
    db.exec(NEXT_ACTION_INDEX_SQL);
    return null;
  }
  const legacy = tableColumns(db, 'contact_tracking');
  const rebuilt = needsRebuild(legacy);
  if (rebuilt) options.beforeRebuild?.();
  const restoreForeignKeys = rebuilt && Number(db.pragma('foreign_keys', { simple: true })) === 1;
  if (restoreForeignKeys) db.pragma('foreign_keys = OFF');
  try {
    return db.transaction(() => {
      const trackingRows = count(db, 'SELECT count(*) n FROM contact_tracking');
      const historyRows = count(db, 'SELECT count(*) n FROM contact_tracking_status_history');
      if (rebuilt) {
        const violationsBefore = fkViolations(db);
        rebuildContactTracking(db, legacy);
        if (count(db, 'SELECT count(*) n FROM contact_tracking') !== trackingRows
          || count(db, 'SELECT count(*) n FROM contact_tracking_status_history') !== historyRows) throw new Error('Migration contact_tracking annulée : nombre de lignes modifié');
        if (fkViolations(db) > violationsBefore) throw new Error('Migration contact_tracking annulée : clés étrangères incohérentes');
      }
      const { backfilled, unmapped } = backfillNextAction(db);
      db.exec(NEXT_ACTION_INDEX_SQL);
      const report: ContactTrackingMigrationReport = {
        id: CONTACT_TRACKING_MIGRATION_ID, rebuilt, trackingRows, historyRows,
        nextActionBackfilled: backfilled, legacyWeekUnmapped: unmapped,
        plannedDateWithoutWeek: count(db, 'SELECT count(*) n FROM contact_tracking WHERE planned_contact_at IS NOT NULL AND next_action_week IS NULL'),
        preservedLegacyColumns: tableColumns(db, 'contact_tracking').map(c => c.name).filter(name => !canonicalColumns.includes(name))
      };
      db.prepare('INSERT INTO schema_migrations(id,report) VALUES(?,?)').run(CONTACT_TRACKING_MIGRATION_ID, JSON.stringify(report));
      return report;
    })();
  } finally {
    if (restoreForeignKeys) db.pragma('foreign_keys = ON');
  }
}

const isBlank = (value: unknown) => value === null || value === undefined || value === '';

/** Valide un couple (année ISO, semaine ISO) entrant : `null` si vide, erreur si incomplet ou inexistant (ex. S53 d'une année à 52 semaines). */
export function toNextActionWeek(year: unknown, week: unknown): IsoWeek | null {
  if (isBlank(year) && isBlank(week)) return null;
  const value = { year: Number(year), week: Number(week) };
  if (isBlank(year) || isBlank(week) || !isValidIsoWeek(value)) throw new Error('Semaine de prochaine action invalide');
  return value;
}

/**
 * Prochaine échéance résultant d'une saisie : `next_action_*` prioritaire, puis alias legacy `contact_year/contact_week`
 * (compatibilité des clients/imports existants), sinon valeur courante inchangée.
 */
export function resolveIncomingNextAction(incoming: Record<string, unknown>, current: IsoWeek | null): IsoWeek | null {
  if (incoming.next_action_year !== undefined || incoming.next_action_week !== undefined) return toNextActionWeek(incoming.next_action_year, incoming.next_action_week);
  if (incoming.contact_year !== undefined || incoming.contact_week !== undefined) return toNextActionWeek(incoming.contact_year, incoming.contact_week);
  return current;
}
