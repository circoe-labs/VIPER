import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { schema } from '../src/server/schema.js';
import { deleteDraftRecord, loadDraftRecord, saveDraftRecord } from '../src/server/drafts.js';
import { parseWorkbook } from '../src/server/importer.js';

const tempDirs: string[] = [];

function openPersistentTestDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viper-draft-'));
  tempDirs.push(dir);
  const dbPath = path.join(dir, 'viper.sqlite');
  const db = new Database(dbPath);
  db.exec(schema);
  return { db, dbPath };
}

function workbook(rows: Record<string, unknown>[]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'BASE CLIENT');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('persistent drafts', () => {
  it('survives a full database close and reopen', () => {
    const { db, dbPath } = openPersistentTestDb();
    const draft = { filename: 'prospects.xlsx', rows: [{ row: 2, excluded: false, normalized: { company: 'Acme' } }] };

    saveDraftRecord(db, 'import-preview', draft);
    db.close();

    const reopened = new Database(dbPath);
    reopened.exec(schema);
    expect(loadDraftRecord(reopened, 'import-preview')?.value).toEqual(draft);
    reopened.close();
  });

  it('restores the exact modified import preview after reload', () => {
    const { db, dbPath } = openPersistentTestDb();
    const preview = parseWorkbook(workbook([
      { Entreprise: 'Acme', Nom: 'Martin', Prénom: 'Luc', Mail: 'luc@acme.fr', 'A contacter ': 'S37' },
      { Entreprise: 'Beta', Nom: 'Durand', Prénom: 'Léa', Mail: 'lea@beta.fr', 'A contacter ': 'S40' }
    ]), 'prospects.xlsx', new Date('2026-09-29T09:00:00Z'));

    preview.rows[0].excluded = true;
    preview.rows[1].normalized.job_title = 'Responsable logistique';
    saveDraftRecord(db, 'import-preview', preview);
    db.close();

    const reopened = new Database(dbPath);
    reopened.exec(schema);
    const restored = loadDraftRecord<typeof preview>(reopened, 'import-preview');

    expect(restored).not.toBeNull();
    expect(restored?.value).toEqual(preview);
    expect(restored?.value.rows[0].excluded).toBe(true);
    expect(restored?.value.rows[1].normalized.job_title).toBe('Responsable logistique');

    deleteDraftRecord(reopened, 'import-preview');
    expect(loadDraftRecord(reopened, 'import-preview')).toBeNull();
    reopened.close();
  });
});
