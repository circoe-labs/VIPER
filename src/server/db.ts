import Database from 'better-sqlite3'; import fs from 'node:fs'; import path from 'node:path'; import { schema } from './schema.js';
const dbPath=process.env.VIPER_DB_PATH || './data/viper.sqlite'; fs.mkdirSync(path.dirname(dbPath),{recursive:true});
export const db=new Database(dbPath); db.pragma('foreign_keys = ON'); export function migrate(){db.exec(schema)}
export function rows(sql:string, params: unknown[]=[]){return db.prepare(sql).all(...params) as Record<string,unknown>[]}
