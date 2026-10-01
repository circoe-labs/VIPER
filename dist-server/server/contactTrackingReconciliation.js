import { randomUUID } from 'node:crypto';
import { DEFAULT_PROSPECT_STATE, isLegacyTrackingStatus, isProspectState, legacyTrackingStatuses, mapLegacyTrackingStatus, prospectStates } from '../shared/contactWorkflow.js';
export const LEGACY_STATUS_MIGRATION_ID = '2026-09-contact-03-legacy-statuses';
// Codes legacy et mapping : définis dans le contrat partagé (aussi lus par le client pour l'historique).
export { isLegacyTrackingStatus, legacyTrackingStatuses, mapLegacyTrackingStatus } from '../shared/contactWorkflow.js';
/**
 * État à écrire depuis une saisie (API, import) : vide -> `neutral`, état du contrat -> inchangé, statut legacy -> converti.
 * Toute autre valeur est rejetée : aucun nouveau statut legacy ou inconnu n'est écrit après la réconciliation.
 */
export function toProspectStateForWrite(value, doNotContact) {
    if (value === undefined || value === null || value === '')
        return DEFAULT_PROSPECT_STATE;
    if (isProspectState(value))
        return value;
    if (isLegacyTrackingStatus(value))
        return mapLegacyTrackingStatus(value, doNotContact);
    throw new Error('État de suivi invalide');
}
class DryRunRollback extends Error {
}
const count = (db, sql) => Number(db.prepare(sql).get().n);
const statusCounts = (db) => Object.fromEntries(db.prepare('SELECT status,count(*) n FROM contact_tracking GROUP BY status ORDER BY status').all().map(r => [r.status, r.n]));
const hasColumn = (db, table, column) => db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
const knownStatusesSql = [...new Set([...legacyTrackingStatuses, ...prospectStates])].map(s => `'${s}'`).join(',');
const LEGACY_PENDING_SQL = `SELECT count(*) n FROM contact_tracking ct LEFT JOIN prospects p ON p.id=ct.prospect_id WHERE ct.status IN (${legacyTrackingStatuses.filter(s => !isProspectState(s)).map(s => `'${s}'`).join(',')}) OR (ct.status='ignored' AND p.contactability_status<>'do_not_contact')`;
function apply(db, dryRun) {
    const trackingRows = count(db, 'SELECT count(*) n FROM contact_tracking');
    const historyRowsBefore = count(db, 'SELECT count(*) n FROM contact_tracking_status_history');
    const statusCountsBefore = statusCounts(db);
    const candidates = db.prepare('SELECT ct.id,ct.status,p.contactability_status contactability FROM contact_tracking ct LEFT JOIN prospects p ON p.id=ct.prospect_id ORDER BY ct.id').all();
    const updateStatus = db.prepare('UPDATE contact_tracking SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?');
    const addHistory = db.prepare("INSERT INTO contact_tracking_status_history(id,contact_tracking_id,from_status,to_status,actor_type,actor_id) VALUES(?,?,?,?,'system',?)");
    const conversions = {};
    let historyRowsAdded = 0;
    for (const row of candidates) {
        if (!isLegacyTrackingStatus(row.status) || isProspectState(row.status))
            continue; // contrat ou inattendu : inchangé
        const next = mapLegacyTrackingStatus(row.status, row.contactability === 'do_not_contact');
        updateStatus.run(next, row.id);
        addHistory.run(randomUUID(), row.id, row.status, next, LEGACY_STATUS_MIGRATION_ID);
        historyRowsAdded++;
        conversions[`${row.status}->${next}`] = (conversions[`${row.status}->${next}`] || 0) + 1;
    }
    // `ignored` implique `do_not_contact` (décision 7) : on renforce uniquement vers le blocage, audité par prospect.
    const toProtect = db.prepare("SELECT p.id,p.contactability_status FROM prospects p JOIN contact_tracking ct ON ct.prospect_id=p.id WHERE ct.status='ignored' AND p.contactability_status<>'do_not_contact'").all();
    const protect = db.prepare("UPDATE prospects SET contactability_status='do_not_contact',do_not_contact_at=coalesce(do_not_contact_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?");
    const auditProspect = db.prepare("INSERT INTO audit_log(id,actor_type,actor_id,entity_type,entity_id,action,changed_fields,before_payload,after_payload,source_context) VALUES(?,'system',?,'prospect',?,'reinforce_do_not_contact','[\"contactability_status\"]',?,?,'migration')");
    for (const p of toProtect) {
        protect.run(p.id);
        auditProspect.run(randomUUID(), LEGACY_STATUS_MIGRATION_ID, p.id, JSON.stringify({ contactability_status: p.contactability_status }), JSON.stringify({ contactability_status: 'do_not_contact' }));
    }
    if (count(db, 'SELECT count(*) n FROM contact_tracking') !== trackingRows
        || count(db, 'SELECT count(*) n FROM contact_tracking_status_history') !== historyRowsBefore + historyRowsAdded)
        throw new Error('Réconciliation des statuts annulée : nombre de lignes incohérent');
    const unexpectedStatuses = Object.fromEntries(db.prepare(`SELECT substr(status,1,40) status,count(*) n FROM contact_tracking WHERE status NOT IN (${knownStatusesSql}) GROUP BY 1 ORDER BY 1`).all().map(r => [r.status, r.n]));
    const report = {
        id: LEGACY_STATUS_MIGRATION_ID, dryRun, trackingRows, historyRowsBefore, historyRowsAdded,
        statusCountsBefore, statusCountsAfter: statusCounts(db), conversions, unexpectedStatuses,
        doNotContactReinforced: toProtect.length,
        doNotContactNotIgnored: count(db, "SELECT count(*) n FROM contact_tracking ct JOIN prospects p ON p.id=ct.prospect_id WHERE p.contactability_status='do_not_contact' AND ct.status NOT IN ('ignored','failure')"),
        neutralWithPlannedDateOnly: count(db, "SELECT count(*) n FROM contact_tracking WHERE status='neutral' AND planned_contact_at IS NOT NULL AND next_action_week IS NULL"),
        legacyWeekUnmapped: hasColumn(db, 'contact_tracking', 'contact_week') && hasColumn(db, 'contact_tracking', 'contact_year')
            ? count(db, 'SELECT count(*) n FROM contact_tracking WHERE next_action_week IS NULL AND (contact_year IS NOT NULL OR contact_week IS NOT NULL)') : 0,
        activityStatusUnknown: count(db, "SELECT count(*) n FROM prospects WHERE activity_status='unknown'")
    };
    if (dryRun)
        throw new DryRunRollback(JSON.stringify(report));
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
export function reconcileLegacyTrackingStatuses(db, options = {}) {
    const dryRun = Boolean(options.dryRun);
    if (!dryRun && db.prepare('SELECT 1 FROM schema_migrations WHERE id=?').get(LEGACY_STATUS_MIGRATION_ID))
        return null;
    if (!dryRun && count(db, LEGACY_PENDING_SQL) > 0)
        options.beforeApply?.();
    try {
        return db.transaction(() => apply(db, dryRun))();
    }
    catch (error) {
        if (error instanceof DryRunRollback)
            return JSON.parse(error.message);
        throw error;
    }
}
