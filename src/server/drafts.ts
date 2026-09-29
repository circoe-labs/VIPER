import type Database from 'better-sqlite3';

export type StoredDraft<T = unknown> = {
  key: string;
  updatedAt: string;
  value: T;
};

export function saveDraftRecord<T>(db: Database.Database, key: string, value: T) {
  const payload = JSON.stringify(value);
  db.prepare(`
    INSERT INTO drafts(key,payload,updated_at)
    VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, updated_at=CURRENT_TIMESTAMP
  `).run(key, payload);
  return loadDraftRecord<T>(db, key);
}

export function loadDraftRecord<T>(db: Database.Database, key: string): StoredDraft<T> | null {
  const row = db.prepare('SELECT key,payload,updated_at FROM drafts WHERE key=?').get(key) as { key: string; payload: string; updated_at: string } | undefined;
  if (!row) return null;
  return { key: row.key, updatedAt: row.updated_at, value: JSON.parse(row.payload) as T };
}

export function deleteDraftRecord(db: Database.Database, key: string) {
  return db.prepare('DELETE FROM drafts WHERE key=?').run(key).changes > 0;
}
