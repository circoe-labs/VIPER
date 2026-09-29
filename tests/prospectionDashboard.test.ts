import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { isoWeekMonday, type IsoWeek } from '../src/shared/contactWorkflow';
import { isProspectionFilter, prospectionFilters } from '../src/shared/prospectionDashboard';
import { schema } from '../src/server/schema.js';
import { prospectionCounters, prospectionFilterSql, prospectSearchSql } from '../src/server/prospectionDashboard.js';
import { employmentCheck, prospectionCards } from '../src/client/prospectionDisplay';

const S = (week: number, year = 2026): IsoWeek => ({ year, week });
const today = isoWeekMonday(S(40)); // lundi 28 sept. 2026

type Row = { id: string; name: string; employment?: boolean; email?: 'verified' | 'unverified' | 'invalid' | 'inactive'; status?: string; week?: IsoWeek; activity?: string };

// Base temporaire synthétique : chaque ligne isole un cas.
const rowsFixture: Row[] = [
  { id: 'p1', name: 'Alpha', employment: true, email: 'verified', status: 'neutral', week: S(40) },   // dû (semaine courante)
  { id: 'p2', name: 'Bravo', email: 'unverified', status: 'neutral', week: S(38) },                  // dû (échu), emploi + email à revoir
  { id: 'p3', name: 'Charlie', employment: true, status: 'neutral', week: S(41) },                   // semaine future, sans email
  { id: 'p4', name: 'Delta', employment: true, email: 'verified', status: 'contacted', week: S(39) }, // relance échue : pas un premier contact
  { id: 'p5', name: 'Echo', email: 'invalid', status: 'neutral' },                                    // neutre sans semaine
  { id: 'p6', name: 'Foxtrot', employment: true, email: 'inactive', activity: 'unknown' },           // email principal inactif, pas de suivi
  { id: 'p7', name: 'Golf', employment: true, email: 'verified', status: 'neutral', week: S(52, 2025), activity: 'unknown' } // dû (année précédente)
];

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  db.prepare("INSERT INTO companies(id,display_name) VALUES('c1','Synthetic Co'),('c2','Other Logistics')").run();
  for (const r of rowsFixture) {
    db.prepare("INSERT INTO prospects(id,company_id,first_name,last_name,activity_status,employment_verified_at) VALUES(?,?,?,'Test',?,?)")
      .run(r.id, r.id === 'p7' ? 'c2' : 'c1', r.name, r.activity || 'active', r.employment ? '2026-09-01T00:00:00Z' : null);
    if (r.email) db.prepare('INSERT INTO emails(id,prospect_id,address,is_primary,is_active,verification_status,origin_type) VALUES(?,?,?,1,?,?,?)')
      .run(`e_${r.id}`, r.id, `${r.id}@example.test`, r.email === 'inactive' ? 0 : 1, r.email === 'inactive' ? 'verified' : r.email, 'manual');
    if (r.status) db.prepare('INSERT INTO contact_tracking(id,prospect_id,status,next_action_year,next_action_week) VALUES(?,?,?,?,?)')
      .run(`t_${r.id}`, r.id, r.status, r.week?.year ?? null, r.week?.week ?? null);
  }
  // Même FROM/joins que `GET /api/prospects` (hors rôles/référents, sans effet sur le filtrage).
  const list = (filter: string, q = '') => {
    const search = prospectSearchSql(q);
    const f = isProspectionFilter(filter) ? prospectionFilterSql(filter, today) : { sql: '1=1', params: [] };
    return (db.prepare(`SELECT p.id FROM prospects p JOIN companies c ON c.id=p.company_id LEFT JOIN emails e ON e.prospect_id=p.id AND e.is_primary=1 AND e.is_active=1 LEFT JOIN contact_tracking ct ON ct.prospect_id=p.id WHERE ${search.sql} AND ${f.sql} ORDER BY p.id`)
      .all(...search.params, ...f.params) as { id: string }[]).map(r => r.id);
  };
  return { db, list };
}

describe('compteurs Prospection (Task 07)', () => {
  it('compte total, contacts dus, emploi à vérifier et emails à fiabiliser', () => {
    const { db } = setup();
    expect(prospectionCounters(db, { today })).toEqual({ total: 7, due: 3, employmentUnverified: 2, emailToReview: 4 });
  });

  it('chaque filtre renvoie exactement les prospects comptés par sa carte', () => {
    const { db, list } = setup();
    expect(list('due')).toEqual(['p1', 'p2', 'p7']);
    expect(list('employment_unverified')).toEqual(['p2', 'p5']);
    expect(list('email_to_review')).toEqual(['p2', 'p3', 'p5', 'p6']);
    expect(list('')).toHaveLength(7);
    const counters = prospectionCounters(db, { today });
    const byFilter = Object.fromEntries(prospectionCards(counters).map(card => [card.filter, card.count]));
    for (const filter of ['', ...prospectionFilters]) expect(list(filter)).toHaveLength(byFilter[filter]);
  });

  it('les compteurs suivent la recherche texte comme la liste', () => {
    const { db, list } = setup();
    expect(prospectionCounters(db, { today, q: 'Other Logistics' })).toEqual({ total: 1, due: 1, employmentUnverified: 0, emailToReview: 0 });
    expect(prospectionCounters(db, { today, q: 'p2@example' })).toEqual({ total: 1, due: 1, employmentUnverified: 1, emailToReview: 1 });
    expect(list('due', 'golf')).toEqual(['p7']);
  });

  it('« contacts dus » suit la semaine ISO (changement d’année) et ignore les états non neutres', () => {
    const { db } = setup();
    expect(prospectionCounters(db, { today: isoWeekMonday(S(1, 2027)) }).due).toBe(4); // p3 (S41) devient dû, p4 (contacted) jamais
    expect(prospectionCounters(db, { today: isoWeekMonday(S(52, 2025)) }).due).toBe(1);
  });

  it('aucun compteur Inconnu ni statut global Validé / Non validé', () => {
    const { db } = setup();
    const counters = prospectionCounters(db, { today });
    expect(Object.keys(counters).sort()).toEqual(['due', 'emailToReview', 'employmentUnverified', 'total']);
    expect(prospectionFilters).not.toContain('unknown');
    for (const legacy of ['never_verified', 'verified', 'partial_verification', 'unknown']) expect(isProspectionFilter(legacy)).toBe(false);
  });
});

describe('cartes Prospection — affichage', () => {
  const cards = prospectionCards({ total: 7, due: 3, employmentUnverified: 2, emailToReview: 4 });

  it('au plus 6 cartes, toutes cliquables avec un filtre connu', () => {
    expect(cards.length).toBeLessThanOrEqual(6);
    expect(cards.map(c => [c.label, c.count, c.filter])).toEqual([
      ['Tous', 7, ''], ['Contacts dus', 3, 'due'], ['Emploi à vérifier', 2, 'employment_unverified'], ['Emails à fiabiliser', 4, 'email_to_review']
    ]);
    for (const card of cards) expect(card.filter === '' || isProspectionFilter(card.filter)).toBe(true);
  });

  it('aucun libellé Inconnu / Vérifiés / Non vérifiés / Incomplets', () => {
    const labels = cards.map(c => c.label).join(' | ');
    expect(labels).not.toMatch(/Inconnu|Vérifiés|Non vérifiés|Incomplets|Validé/);
  });

  it('la colonne Emploi ne reflète que la vérification des informations d’emploi', () => {
    const fmt = (v: string) => `le ${v.slice(0, 10)}`;
    expect(employmentCheck('2026-09-01T00:00:00Z', fmt)).toEqual({ tone: 'verified', label: 'Vérifié', detail: 'le 2026-09-01' });
    expect(employmentCheck(null, fmt)).toEqual({ tone: 'never', label: 'Non vérifié', detail: 'À vérifier' });
  });
});
