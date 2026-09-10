import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseWorkbook, resolveLegacyWeek } from '../src/server/importer.js';

function workbook(rows: any[], extra = false) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'BASE CLIENT');
  if (extra) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ x: 1 }]), 'actualité');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

describe('Excel preview', () => {
  const ref = new Date('2026-09-10T12:00:00Z');
  it('normalizes civility, email and resolves S37 to its Monday', () => {
    const p = parseWorkbook(workbook([{ Entreprise: 'Acme', Civilité: 'Monsieur', Nom: 'Martin', Prénom: 'Luc', Mail: 'LUC@ACME.TEST', 'A contacter ': 'S37' }]), 'test.xlsx', ref);
    expect(p.rows[0].normalized.civility).toBe('M.');
    expect(p.rows[0].normalized.email).toBe('luc@acme.test');
    expect(p.rows[0].normalized.planned_contact_at).toBe('2026-09-07');
    expect(p.rows[0].diagnostics.some(d => d.code === 'planned_week_resolved')).toBe(true);
  });
  it('uses the explicit verification column and timestamps verified rows at import when no date exists', () => {
    const p = parseWorkbook(workbook([{ Entreprise: 'Acme', Nom: 'Martin', Prénom: 'Luc', Vérification: 'Vérifié' }]), 'test.xlsx', ref);
    expect(p.rows[0].normalized.verification_state).toBe('verified');
    expect(p.rows[0].normalized.employment_verified_at).toBe(ref.toISOString());
  });
  it('keeps legacy v as a verification fallback but never as referent', () => {
    const p = parseWorkbook(workbook([{ Entreprise: 'Acme', Nom: 'Martin', Prénom: 'Luc', Référent: 'v' }]), 'test.xlsx', ref);
    expect(p.rows[0].normalized.verification_state).toBe('verified');
    expect(p.rows[0].normalized.referent).toBe('');
  });
  it('explicitly skips actualité', () => {
    const p = parseWorkbook(workbook([{ Entreprise: 'Acme', Nom: 'Martin', Prénom: 'Luc' }], true), 'test.xlsx', ref);
    expect(p.skippedSheets).toContain('actualité');
  });
  it('never silently loses opaque columns', () => {
    const p = parseWorkbook(workbook([{ Entreprise: 'Acme', Nom: 'Martin', Prénom: 'Luc', Mystère: 'conserver' }]), 'test.xlsx', ref);
    expect(p.rows[0].diagnostics.some(d => d.code === 'unknown_columns')).toBe(true);
    expect(p.rows[0].raw.Mystère).toBe('conserver');
  });
});

describe('legacy week continuity', () => {
  it('chooses the nearest ISO week year around a year boundary', () => {
    expect(resolveLegacyWeek('S01', new Date('2026-12-30T12:00:00Z'))?.date).toBe('2027-01-04');
  });
});
