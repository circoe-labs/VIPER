import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { schema } from './schema.js';
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

function ensureColumn(table:string,column:string,definition:string){
  const cols=db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if(!cols.some(c=>c.name===column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function migrate(){
  db.exec(schema);
  ensureColumn('contact_tracking','contact_year','INTEGER');
  ensureColumn('contact_tracking','contact_week','INTEGER');
}

export function rows(sql:string, params: unknown[]=[]){
  return db.prepare(sql).all(...params) as Record<string,unknown>[];
}

export function serializeDatabase() {
  return db.serialize();
}

export function isBusinessStateEmpty() {
  migrate();
  return Number((db.prepare('SELECT count(*) AS n FROM prospects').get() as any)?.n || 0) === 0;
}

export function restoreDatabase(buffer: Buffer) {
  const probe = new Database(buffer);
  const integrity = probe.pragma('integrity_check', { simple: true });
  probe.close();
  if (integrity !== 'ok') throw new Error('Sauvegarde SQLite invalide');

  const tempPath = `${dbPath}.restore-${Date.now()}`;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(tempPath, buffer, { mode: 0o600 });

  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${dbPath}${suffix}`;
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  }
  fs.renameSync(tempPath, dbPath);
  db = openDatabase();
  migrate();
}
