import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { schema } from './schema.js';
import { CONTACT_TRACKING_MIGRATION_ID, migrateContactTracking } from './contactTrackingSchema.js';
import { LEGACY_STATUS_MIGRATION_ID, reconcileLegacyTrackingStatuses } from './contactTrackingReconciliation.js';
import { migrateContactMessages } from './contactMessageSchema.js';
import { dbPath, preparePersistentStorage } from './storage.js';
preparePersistentStorage();
function openDatabase() {
    const next = new Database(dbPath);
    next.pragma('foreign_keys = ON');
    next.pragma('journal_mode = WAL');
    next.pragma('synchronous = FULL');
    return next;
}
export let db = openDatabase();
// Instantané complet de la base avant une migration qui reconstruit une table (à côté de la base, même dossier privé).
function snapshotBeforeMigration(migrationId) {
    const target = `${dbPath}.before-${migrationId}-${Date.now()}-${randomUUID().slice(0, 8)}.sqlite`;
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
}
export function migrate() {
    db.exec(schema);
    const report = migrateContactTracking(db, { beforeRebuild: () => snapshotBeforeMigration(CONTACT_TRACKING_MIGRATION_ID) });
    if (report)
        console.log(`VIPER migration ${report.id} appliquée : ${JSON.stringify(report)}`);
    const reconciliation = reconcileLegacyTrackingStatuses(db, { beforeApply: () => snapshotBeforeMigration(LEGACY_STATUS_MIGRATION_ID) });
    if (reconciliation)
        console.log(`VIPER migration ${reconciliation.id} appliquée : ${JSON.stringify(reconciliation)}`);
    if (reconciliation && Object.keys(reconciliation.unexpectedStatuses).length)
        console.warn(`VIPER migration ${reconciliation.id} : statuts inattendus laissés tels quels, revue requise : ${JSON.stringify(reconciliation.unexpectedStatuses)}`);
    // Additive (nouvelles tables) : pas d'instantané nécessaire.
    const messages = migrateContactMessages(db);
    if (messages)
        console.log(`VIPER migration ${messages.id} appliquée : ${JSON.stringify(messages)}`);
}
export function rows(sql, params = []) {
    return db.prepare(sql).all(...params);
}
export function serializeDatabase() {
    return db.serialize();
}
export function isBusinessStateEmpty() {
    migrate();
    return Number(db.prepare('SELECT count(*) AS n FROM prospects').get()?.n || 0) === 0;
}
export function restoreDatabase(buffer) {
    const probe = new Database(buffer);
    const integrity = probe.pragma('integrity_check', { simple: true });
    probe.close();
    if (integrity !== 'ok')
        throw new Error('Sauvegarde SQLite invalide');
    const tempPath = `${dbPath}.restore-${Date.now()}`;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(tempPath, buffer, { mode: 0o600 });
    db.close();
    for (const suffix of ['', '-wal', '-shm']) {
        const target = `${dbPath}${suffix}`;
        if (fs.existsSync(target))
            fs.rmSync(target, { force: true });
    }
    fs.renameSync(tempPath, dbPath);
    db = openDatabase();
    migrate();
}
