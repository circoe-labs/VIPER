import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const configuredDbPath = String(process.env.VIPER_DB_PATH || '').trim();
const configuredStorageDir = String(process.env.VIPER_STORAGE_DIR || '').trim();
export const storageDir = path.resolve(configuredStorageDir ||
    (configuredDbPath ? path.dirname(configuredDbPath) : path.join(os.homedir(), '.viper')));
export const dbPath = path.resolve(configuredDbPath || path.join(storageDir, 'viper.sqlite'));
export const importArchiveDir = path.join(storageDir, 'imports');
const legacyDbPath = path.resolve('./data/viper.sqlite');
function ensurePrivateDir(dir) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
function copyIfPresent(from, to) {
    if (fs.existsSync(from) && !fs.existsSync(to))
        fs.copyFileSync(from, to);
}
export function preparePersistentStorage() {
    ensurePrivateDir(storageDir);
    ensurePrivateDir(importArchiveDir);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    if (!configuredDbPath && dbPath !== legacyDbPath && !fs.existsSync(dbPath) && fs.existsSync(legacyDbPath)) {
        copyIfPresent(legacyDbPath, dbPath);
        copyIfPresent(`${legacyDbPath}-wal`, `${dbPath}-wal`);
        copyIfPresent(`${legacyDbPath}-shm`, `${dbPath}-shm`);
    }
}
function safeFilename(filename) {
    const base = path.basename(filename || 'import.xlsx').replace(/[^A-Za-z0-9._-]+/g, '_');
    return base || 'import.xlsx';
}
export function archiveImportedWorkbook(buffer, filename, fingerprint) {
    preparePersistentStorage();
    const prefix = String(fingerprint || 'import').replace(/[^a-fA-F0-9]/g, '').slice(0, 16) || 'import';
    const target = path.join(importArchiveDir, `${prefix}-${safeFilename(filename)}`);
    if (!fs.existsSync(target))
        fs.writeFileSync(target, buffer, { mode: 0o600 });
    return target;
}
preparePersistentStorage();
