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
  it('normalizes civility and preserves S37 as campaign week 37 of 2026', () => {
    const p = parseWorkbook(workbook([{ Entreprise: 'Acme', Civilité: 'Monsieur', Nom: 'Martin', Prénom: 'Luc', Mail: 'LUC@ACME.TEST', 'A contacter ': 'S37' }]), 'test.xlsx', ref);
    expect(p.rows[0].normalized.civility).toBe('M.');
    expect(p.rows[0].normalized.email).toBe('luc@acme.test');
    expect(p.rows[0].normalized.planned_contact_at).toBeNull();
    expect(p.rows[0].normalized.contact_year).toBe(2026);
    expect(p.rows[0].normalized.contact_week).toBe(37);
    expect(p.rows[0].normalized.verification_state).toBe('verified');
    expect(p.rows[0].normalized.email_verification_status).toBe('verified');
    expect(p.rows[0].normalized.tracking_status).toBe('contacted');
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
  it('applies the agreed S37/S39/S40 campaign history rules', () => {
    const p = parseWorkbook(workbook([
      { Entreprise: 'S37', Nom: 'Un', Prénom: 'A', Mail: 'a@s37.fr', 'A contacter ': 'S37' },
      { Entreprise: 'S39', Nom: 'Deux', Prénom: 'B', Mail: 'b@s39.fr', 'A contacter ': 'S39' },
      { Entreprise: 'S40', Nom: 'Trois', Prénom: 'C', Mail: 'c@s40.fr', 'A contacter ': 'S40' }
    ]), 'test.xlsx', ref);
    expect(p.rows.map(r => r.normalized.verification_state)).toEqual(['verified', 'verified', 'verified']);
    expect(p.rows.map(r => r.normalized.email_verification_status)).toEqual(['verified', 'verified', 'verified']);
    expect(p.rows.map(r => r.normalized.tracking_status)).toEqual(['contacted', 'contacted', 'to_contact']);
    expect(p.rows.map(r => r.normalized.contact_week)).toEqual([37, 39, 40]);
    expect(p.rows.map(r => r.normalized.contact_year)).toEqual([2026, 2026, 2026]);
  });
  it('suggests a normalized role while preserving the exact function', () => {
    const p = parseWorkbook(workbook([
      { Entreprise: 'Acme', Nom: 'Martin', Prénom: 'Luc', Fonction: 'Directeur logistique' },
      { Entreprise: 'Beta', Nom: 'Durand', Prénom: 'Léa', Fonction: 'Chargée de développement' }
    ]), 'test.xlsx', ref);
    expect(p.rows[0].normalized.job_title).toBe('Directeur logistique');
    expect(p.rows[0].normalized.role_slug).toBe('direction');
    expect(p.rows[0].normalized.role_label).toBe('Direction');
    expect(p.rows[1].normalized.role_slug).toBe('charge-mission-affaires');
    expect(p.rows[1].diagnostics.some(d => d.code === 'role_suggested')).toBe(true);
  });
  it('keeps a missing identity as an unknown contact instead of an error', () => {
    const p = parseWorkbook(workbook([{ Entreprise: 'Acme', Mail: 'contact@acme.fr' }]), 'test.xlsx', ref);
    expect(p.rows[0].normalized.identity_unknown).toBe(true);
    expect(p.rows[0].diagnostics.some(d => d.code === 'missing_identity' && d.level === 'error')).toBe(false);
    expect(p.rows[0].diagnostics.some(d => d.code === 'missing_identity' && d.level === 'warning')).toBe(true);
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
  it('keeps legacy week labels in the fixed 2026 campaign year', () => {
    expect(resolveLegacyWeek('S01')).toEqual({ week: 1, year: 2026 });
  });
});