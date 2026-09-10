import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dbPath = process.env.VIPER_DB_PATH || './data/viper.sqlite3';
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
export const db = new Database(dbPath);
db.pragma('foreign_keys = ON');
db.pragma('journal_mode = WAL');
export function migrate() {
  const sql = fs.readFileSync(path.resolve('migrations/001_init.sql'),'utf8');
  db.exec(sql);
}
export function queryAll<T=Record<string,unknown>>(sql:string, params:unknown[]=[]){ return db.prepare(sql).all(...params) as T[]; }
export function queryOne<T=Record<string,unknown>>(sql:string, params:unknown[]=[]){ return db.prepare(sql).get(...params) as T|undefined; }
