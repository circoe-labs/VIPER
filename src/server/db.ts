import Database from 'better-sqlite3';
import { schema } from './schema.js';
import { dbPath, preparePersistentStorage } from './storage.js';

preparePersistentStorage();

export const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');

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
