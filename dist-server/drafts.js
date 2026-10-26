export function saveDraftRecord(db, key, value) {
    const payload = JSON.stringify(value);
    db.prepare(`
    INSERT INTO drafts(key,payload,updated_at)
    VALUES(?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET payload=excluded.payload, updated_at=CURRENT_TIMESTAMP
  `).run(key, payload);
    return loadDraftRecord(db, key);
}
export function loadDraftRecord(db, key) {
    const row = db.prepare('SELECT key,payload,updated_at FROM drafts WHERE key=?').get(key);
    if (!row)
        return null;
    return { key: row.key, updatedAt: row.updated_at, value: JSON.parse(row.payload) };
}
export function deleteDraftRecord(db, key) {
    return db.prepare('DELETE FROM drafts WHERE key=?').run(key).changes > 0;
}
