import { describe, it, expect } from 'vitest';
import * as XLSX from 'xlsx';
import { parseWorkbook, resolveLegacyWeek } from '../src/server/importer.js';

function workbook(rows: any[], extra = false) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'BASE CLIENT');
  if (extra) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ x: 1 }]), 'actualité');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function workbookWithNoise(rows: any[]) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Base client ');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['FBL', '', '', 'Commerciale'], ['Noise', '', '', 'Transport']]), 'Feuil1');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ Actualité: 'À ignorer' }]), 'actualité');
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
  it('maps Statut_verification values without collapsing them into unknown', () => {
    const p = parseWorkbook(workbook([
      { Entreprise: 'A', Nom: 'Un', Prénom: 'A', Mail: 'a@a.fr', Statut_verification: 'Validé', 'A contacter ': 'S37' },
      { Entreprise: 'B', Nom: 'Deux', Prénom: 'B', Mail: 'b@b.fr', Statut_verification: 'Inactif' },
      { Entreprise: 'C', Nom: 'Trois', Prénom: 'C', Mail: 'c@c.fr', Statut_verification: 'Inconnus' },
      { Entreprise: 'D', Nom: 'Quatre', Prénom: 'D', Mail: 'd@d.fr', Statut_verification: '' }
    ]), 'test.xlsx', new Date('2026-09-11T12:00:00Z'));
    expect(p.rows[0].normalized.verification_state).toBe('verified');
    expect(p.rows[0].normalized.activity_status_suggestion).toBe('active');
    expect(p.rows[0].normalized.email_verification_status).toBe('verified');
    expect(p.rows[0].normalized.tracking_status).toBe('contacted');
    expect(p.rows[1].normalized.verification_state).toBe('inactive');
    expect(p.rows[1].normalized.activity_status_suggestion).toBe('inactive');
    expect(p.rows[1].normalized.email_verification_status).toBe('invalid');
    expect(p.rows[2].normalized.verification_state).toBe('unknown');
    expect(p.rows[2].normalized.email_verification_status).toBe('unknown');
    expect(p.rows[3].normalized.verification_state).toBe('unverified');
  });
  it('keeps future weeks to contact and past weeks as contacted', () => {
    const p = parseWorkbook(workbook([
      { Entreprise: 'Future', Nom: 'Martin', Prénom: 'Luc', 'A contacter ': 'S39' },
      { Entreprise: 'Past', Nom: 'Durand', Prénom: 'Léa', 'A contacter ': 'S37', Statut_verification: 'Validé' }
    ]), 'test.xlsx', new Date('2026-09-11T12:00:00Z'));
    expect(p.rows[0].normalized.tracking_status).toBe('to_contact');
    expect(p.rows[1].normalized.tracking_status).toBe('contacted');
  });
  it('keeps legacy v as a verification fallback but never as referent', () => {
    const p = parseWorkbook(workbook([{ Entreprise: 'Acme', Nom: 'Martin', Prénom: 'Luc', Référent: 'v' }]), 'test.xlsx', ref);
    expect(p.rows[0].normalized.verification_state).toBe('verified');
    expect(p.rows[0].normalized.referent).toBe('');
  });
  it('skips sheets that do not contain prospect headers', () => {
    const p = parseWorkbook(workbookWithNoise([{ Entreprise: 'Acme', Nom: 'Martin', Prénom: 'Luc' }]), 'test.xlsx', ref);
    expect(p.sheets).toEqual(['Base client ']);
    expect(p.skippedSheets).toContain('Feuil1');
    expect(p.skippedSheets).toContain('actualité');
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