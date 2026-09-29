// Réconciliation des statuts legacy de `contact_tracking` (Task 03) vers la taxonomie Contact (`src/shared/contactWorkflow.ts`).
// Mapping exécuté = docs/06-data-model.md §2 du handoff. Non destructive : aucune ligne supprimée, historique ancien jamais réécrit ;
// chaque conversion ajoute une ligne d'historique `actor_type='system'`, `actor_id=<id migration>`, `from_status=<ancien statut>`.
// Valeurs inattendues : jamais écrasées, laissées telles quelles et comptées dans le rapport (file de revue explicite).
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { DEFAULT_PROSPECT_STATE, isProspectState, prospectStates, type ProspectState } from '../shared/contactWorkflow.js';

export const LEGACY_STATUS_MIGRATION_ID = '2026-09-contact-03-legacy-statuses';

export const legacyTrackingStatuses = ['to_contact', 'contacted', 'follow_up_1', 'follow_up_2', 'response_received', 'appointment_obtained', 'quote_sent', 'quote_follow_up', 'won', 'not_interested'] as const;
export type LegacyTrackingStatus = typeof legacyTrackingStatuses[number];
export const isLegacyTrackingStatus = (value: unknown): value is LegacyTrackingStatus => legacyTrackingStatuses.includes(value as LegacyTrackingStatus);

/** Mapping direct ; `not_interested` dépend du blocage durable (voir `mapLegacyTrackingStatus`). */
const legacyMapping: Readonly<Record<Exclude<LegacyTrackingStatus, 'not_interested'>, ProspectState>> = {
  to_contact: 'neutral', contacted: 'contacted', follow_up_1: 'r1', follow_up_2: 'r2',
  response_received: 'response_received', appointment_obtained: 'appointment_obtained',
  // Post-RDV : hors périmètre Contact V1, convergence vers `appointment_obtained` (ancien statut tracé dans l'historique).
  quote_sent: 'appointment_obtained', quote_follow_up: 'appointment_obtained', won: 'appointment_obtained'
};

/** `not_interested` -> `ignored` si `contactability_status=do_not_contact` (blocage durable), sinon `failure`. */
export function mapLegacyTrackingStatus(status: LegacyTrackingStatus, doNotContact: boolean): ProspectState {
  if (status === 'not_interested') return doNotContact ? 'ignored' : 'failure';
  return legacyMapping[status];
}

/**
 * État à écrire depuis une saisie (API, import) : vide -> `neutral`, état du contrat -> inchangé, statut legacy -> converti.
 * Toute autre valeur est rejetée : aucun nouveau statut legacy ou inconnu n'est écrit après la réconciliation.
 */
export function toProspectStateForWrite(value: unknown, doNotContact: boolean): ProspectState {
  if (value === undefined || value === null || value === '') return DEFAULT_PROSPECT_STATE;
  if (isProspectState(value)) return value;
  if (isLegacyTrackingStatus(value)) return mapLegacyTrackingStatus(value, doNotContact);
  throw new Error('État de suivi invalide');
}

/** Compteurs non-PII (codes d'état et nombres uniquement), journalisés et stockés dans `schema_migrations.report`. */
export type LegacyStatusReconciliationReport = {
  id: string;
  dryRun: boolean;
  trackingRows: number;
  historyRowsBefore: number;
  historyRowsAdded: number;
  statusCountsBefore: Record<string, number>;
  statusCountsAfter: Record<string, number>;
  /** Clé `ancien->nouveau` ; seules les lignes dont la valeur change. */
  conversions: Record<string, number>;
  /** Valeurs hors legacy et hors contrat : laissées telles quelles, à revoir humainement. */
  unexpectedStatuses: Record<string, number>;
  /** Lignes `ignored` dont le prospect n'était pas `do_not_contact` : protection renforcée (jamais l'inverse). */
  doNotContactReinforced: number;
  /** Prospects `do_not_contact` dont l'état n'est ni `ignored` ni `failure` après réconciliation (non modifiés, à revoir). */
  doNotContactNotIgnored: number;
  /** États neutres avec une date legacy `planned_contact_at` mais sans prochaine semaine (date non convertie). */
  neutralWithPlannedDateOnly: number;
  /** Couples legacy `contact_year/contact_week` non recopiés en Task 02 (incomplets ou semaine ISO inexistante). */
  legacyWeekUnmapped: number;
  /** `prospects.activity_status='unknown'` : compté seulement (nettoyage hors périmètre). */
  activityStatusUnknown: number;
};

type Db = Database.Database;
class DryRunRollback extends Error {}

const count = (db: Db, sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
const statusCounts = (db: Db) => Object.fromEntries((db.prepare('SELECT status,count(*) n FROM contact_tracking GROUP BY status ORDER BY status').all() as { status: string; n: number }[]).map(r => [r.status, r.n]));
const hasColumn = (db: Db, table: string, column: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some(c => c.name === column);
const knownStatusesSql = [...new Set<string>([...legacyTrackingStatuses, ...prospectStates])].map(s => `'${s}'`).join(',');
const LEGACY_PENDING_SQL = `SELECT count(*) n FROM contact_tracking ct LEFT JOIN prospects p ON p.id=ct.prospect_id WHERE ct.status IN (${legacyTrackingStatuses.filter(s => !isProspectState(s)).map(s => `'${s}'`).join(',')}) OR (ct.status='ignored' AND p.contactability_status<>'do_not_contact')`;

function apply(db: Db, dryRun: boolean): LegacyStatusReconciliationReport {
  const trackingRows = count(db, 'SELECT count(*) n FROM contact_tracking');
  const historyRowsBefore = count(db, 'SELECT count(*) n FROM contact_tracking_status_history');
  const statusCountsBefore = statusCounts(db);
  const candidates = db.prepare('SELECT ct.id,ct.status,p.contactability_status contactability FROM contact_tracking ct LEFT JOIN prospects p ON p.id=ct.prospect_id ORDER BY ct.id').all() as { id: string; status: string; contactability: string | null }[];
  const updateStatus = db.prepare('UPDATE contact_tracking SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?');
  const addHistory = db.prepare("INSERT INTO contact_tracking_status_history(id,contact_tracking_id,from_status,to_status,actor_type,actor_id) VALUES(?,?,?,?,'system',?)");
  const conversions: Record<string, number> = {};
  let historyRowsAdded = 0;
  for (const row of candidates) {
    if (!isLegacyTrackingStatus(row.status) || isProspectState(row.status)) continue; // contrat ou inattendu : inchangé
    const next = mapLegacyTrackingStatus(row.status, row.contactability === 'do_not_contact');
    updateStatus.run(next, row.id);
    addHistory.run(randomUUID(), row.id, row.status, next, LEGACY_STATUS_MIGRATION_ID);
    historyRowsAdded++;
    conversions[`${row.status}->${next}`] = (conversions[`${row.status}->${next}`] || 0) + 1;
  }
  // `ignored` implique `do_not_contact` (décision 7) : on renforce uniquement vers le blocage, audité par prospect.
  const toProtect = db.prepare("SELECT p.id,p.contactability_status FROM prospects p JOIN contact_tracking ct ON ct.prospect_id=p.id WHERE ct.status='ignored' AND p.contactability_status<>'do_not_contact'").all() as { id: string; contactability_status: string }[];
  const protect = db.prepare("UPDATE prospects SET contactability_status='do_not_contact',do_not_contact_at=coalesce(do_not_contact_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?");
  const auditProspect = db.prepare("INSERT INTO audit_log(id,actor_type,actor_id,entity_type,entity_id,action,changed_fields,before_payload,after_payload,source_context) VALUES(?,'system',?,'prospect',?,'reinforce_do_not_contact','[\"contactability_status\"]',?,?,'migration')");
  for (const p of toProtect) {
    protect.run(p.id);
    auditProspect.run(randomUUID(), LEGACY_STATUS_MIGRATION_ID, p.id, JSON.stringify({ contactability_status: p.contactability_status }), JSON.stringify({ contactability_status: 'do_not_contact' }));
  }
  if (count(db, 'SELECT count(*) n FROM contact_tracking') !== trackingRows
    || count(db, 'SELECT count(*) n FROM contact_tracking_status_history') !== historyRowsBefore + historyRowsAdded) throw new Error('Réconciliation des statuts annulée : nombre de lignes incohérent');
  const unexpectedStatuses = Object.fromEntries((db.prepare(`SELECT substr(status,1,40) status,count(*) n FROM contact_tracking WHERE status NOT IN (${knownStatusesSql}) GROUP BY 1 ORDER BY 1`).all() as { status: string; n: number }[]).map(r => [r.status, r.n]));
  const report: LegacyStatusReconciliationReport = {
    id: LEGACY_STATUS_MIGRATION_ID, dryRun, trackingRows, historyRowsBefore, historyRowsAdded,
    statusCountsBefore, statusCountsAfter: statusCounts(db), conversions, unexpectedStatuses,
    doNotContactReinforced: toProtect.length,
    doNotContactNotIgnored: count(db, "SELECT count(*) n FROM contact_tracking ct JOIN prospects p ON p.id=ct.prospect_id WHERE p.contactability_status='do_not_contact' AND ct.status NOT IN ('ignored','failure')"),
    neutralWithPlannedDateOnly: count(db, "SELECT count(*) n FROM contact_tracking WHERE status='neutral' AND planned_contact_at IS NOT NULL AND next_action_week IS NULL"),
    legacyWeekUnmapped: hasColumn(db, 'contact_tracking', 'contact_week') && hasColumn(db, 'contact_tracking', 'contact_year')
      ? count(db, 'SELECT count(*) n FROM contact_tracking WHERE next_action_week IS NULL AND (contact_year IS NOT NULL OR contact_week IS NOT NULL)') : 0,
    activityStatusUnknown: count(db, "SELECT count(*) n FROM prospects WHERE activity_status='unknown'")
  };
  if (dryRun) throw new DryRunRollback(JSON.stringify(report));
  db.prepare("INSERT INTO audit_log(id,actor_type,actor_id,entity_type,entity_id,action,after_payload,source_context) VALUES(?,'system',?,'schema_migration',?,'legacy_status_reconciliation',?,'migration')")
    .run(randomUUID(), LEGACY_STATUS_MIGRATION_ID, LEGACY_STATUS_MIGRATION_ID, JSON.stringify(report));
  db.prepare('INSERT INTO schema_migrations(id,report) VALUES(?,?)').run(LEGACY_STATUS_MIGRATION_ID, JSON.stringify(report));
  return report;
}

/**
 * Convertit les statuts legacy une seule fois (`schema_migrations`), dans une transaction ; `null` = déjà appliquée.
 * `dryRun` exécute exactement le même chemin puis annule tout (rapport seul, rien n'est enregistré).
 * Précondition : migration Task 02 (`migrateContactTracking`) appliquée. `beforeApply` = instantané si des lignes vont changer.
 */
export function reconcileLegacyTrackingStatuses(db: Db, options: { dryRun?: boolean; beforeApply?: () => void } = {}): LegacyStatusReconciliationReport | null {
  const dryRun = Boolean(options.dryRun);
  if (!dryRun && db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(LEGACY_STATUS_MIGRATION_ID)) return null;
  if (!dryRun && count(db, LEGACY_PENDING_SQL) > 0) options.beforeApply?.();
  try {
    return db.transaction(() => apply(db, dryRun))();
  } catch (error) {
    if (error instanceof DryRunRollback) return JSON.parse(error.message) as LegacyStatusReconciliationReport;
    throw error;
  }
}
