import Database from 'better-sqlite3';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isoWeekMonday, type IsoWeek } from '../src/shared/contactWorkflow';
import { contactFilters, contactListSearchParams, parseContactListQuery, type ContactListQuery } from '../src/shared/contactDashboard';
import { schema } from '../src/server/schema.js';
import { contactCounters, contactDashboard, contactProspects, countContactFilter } from '../src/server/contactDashboard.js';
import { prospectionCounters } from '../src/server/prospectionDashboard.js';
import { contactCards, contactStateOptions, nextStepLabel, toggleCardFilter, weekFilterOptions, weekOptionLabel, withWeekFilter } from '../src/client/contactDisplay';
import { ContactPage } from '../src/client/ContactPage';

const S = (week: number, year = 2026): IsoWeek => ({ year, week });
const today = isoWeekMonday(S(40)); // lundi 28 sept. 2026

type Row = { id: string; status: string; week?: IsoWeek; history?: string[] };

// Base temporaire synthétique : chaque ligne isole un cas.
const rowsFixture: Row[] = [
  { id: 'n_now', status: 'neutral', week: S(40) },             // premier contact, semaine courante
  { id: 'n_late', status: 'neutral', week: S(38) },            // premier contact échu
  { id: 'n_prev_year', status: 'neutral', week: S(52, 2025) }, // premier contact échu (année ISO précédente)
  { id: 'n_future', status: 'neutral', week: S(42) },          // futur : pas à traiter cette semaine
  { id: 'n_none', status: 'neutral' },                         // sans échéance : jamais dans le planning par défaut
  { id: 'c_now', status: 'contacted', week: S(40) },           // relance R1
  { id: 'r1_late', status: 'r1', week: S(39) },                // relance R2 échue
  { id: 'r1_next_year', status: 'r1', week: S(1, 2027) },      // futur, année suivante
  { id: 'r2_now', status: 'r2', week: S(40) },                 // revue R2
  { id: 'resp_now', status: 'response_received', week: S(40) },// semaine reposée par un humain : pas « à traiter »
  { id: 'rdv', status: 'appointment_obtained', history: ['neutral', 'contacted', 'appointment_obtained'] },
  { id: 'rdv_week', status: 'appointment_obtained', week: S(41), history: ['appointment_obtained', 'appointment_obtained'] }, // historique en double
  { id: 'rdv_undone', status: 'contacted', week: S(44), history: ['appointment_obtained', 'contacted'] }, // RDV corrigé par l'humain
  { id: 'fail', status: 'failure' },
  { id: 'ign', status: 'ignored' },
  { id: 'ign_week', status: 'ignored', week: S(40) }            // incohérence forcée en base : toujours exclu
];

function setup() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(schema);
  db.prepare("INSERT INTO companies(id,display_name) VALUES('c1','Synthetic Co')").run();
  for (const r of rowsFixture) {
    db.prepare("INSERT INTO prospects(id,company_id,first_name,last_name) VALUES(?,'c1',?,'Test')").run(r.id, r.id);
    db.prepare('INSERT INTO contact_tracking(id,prospect_id,status,next_action_year,next_action_week) VALUES(?,?,?,?,?)')
      .run(`t_${r.id}`, r.id, r.status, r.week?.year ?? null, r.week?.week ?? null);
    (r.history || []).forEach((to, i) => db.prepare("INSERT INTO contact_tracking_status_history(id,contact_tracking_id,to_status,actor_type,changed_at) VALUES(?,?,?,'human',?)")
      .run(`h_${r.id}_${i}`, `t_${r.id}`, to, `2026-09-0${i + 1}T10:00:00Z`));
  }
  const list = (query: ContactListQuery, at = today) => contactProspects(db, query, at).map(r => r.id).sort();
  return { db, list };
}

describe('compteurs Contact (Task 09)', () => {
  it('à traiter cette semaine = premier contact + relances + revues R2, RDV pris cumulés', () => {
    const { db } = setup();
    expect(contactCounters(db, today)).toEqual({ toHandle: 6, firstContact: 3, followUp: 2, review: 1, appointments: 2 });
  });

  it('chaque carte compte exactement les prospects de son filtre', () => {
    const { db, list } = setup();
    expect(list({ filter: 'first_contact' })).toEqual(['n_late', 'n_now', 'n_prev_year']);
    expect(list({ filter: 'follow_up' })).toEqual(['c_now', 'r1_late']);
    expect(list({ filter: 'review' })).toEqual(['r2_now']);
    expect(list({ filter: 'to_handle' })).toEqual(['c_now', 'n_late', 'n_now', 'n_prev_year', 'r1_late', 'r2_now']);
    expect(list({ filter: 'appointments' })).toEqual(['rdv', 'rdv_week']);
    const counters = contactCounters(db, today);
    const cards = contactCards(counters, S(40));
    for (const card of [cards.toHandle, ...cards.breakdown, cards.appointments]) expect(list({ filter: card.filter })).toHaveLength(card.count);
    expect(cards.breakdown.reduce((n, c) => n + c.count, 0)).toBe(cards.toHandle.count);
    for (const filter of contactFilters) expect(countContactFilter(db, filter, today)).toBe(list({ filter }).length);
  });

  it('premier contact = « Contacts dus » de Prospection (même définition)', () => {
    const { db } = setup();
    expect(contactCounters(db, today).firstContact).toBe(prospectionCounters(db, { today }).due);
  });

  it('semaine courante, semaine future et bord d’année ISO', () => {
    const { db, list } = setup();
    expect(list({ week: S(40) })).toEqual(['c_now', 'n_now', 'r2_now', 'resp_now']);
    expect(list({ week: S(42) })).toEqual(['n_future']);
    expect(list({ week: S(1, 2027) })).toEqual(['r1_next_year']);
    expect(list({ week: S(1, 2026) })).toEqual([]); // S1 d'une autre année ISO : jamais confondue
    expect(list({ week: S(52, 2025) })).toEqual(['n_prev_year']);
    // En S1 2027, tout ce qui est planifié jusqu'à S1 2027 devient à traiter (sauf états hors séquence).
    const s1 = isoWeekMonday(S(1, 2027));
    expect(contactCounters(db, s1)).toEqual({ toHandle: 9, firstContact: 4, followUp: 4, review: 1, appointments: 2 });
    expect(list({ filter: 'to_handle' }, s1)).toContain('r1_next_year');
    // 31 déc. 2026 (jeudi) appartient à S53 2026 : r1_next_year pas encore dû.
    expect(list({ filter: 'follow_up' }, new Date(Date.UTC(2026, 11, 31)))).not.toContain('r1_next_year');
  });

  it('RDV pris cumulés : état courant, sans double comptage de l’historique ni RDV annulé par l’humain', () => {
    const { db, list } = setup();
    expect(contactCounters(db, today).appointments).toBe(2);
    expect(list({ filter: 'appointments' })).not.toContain('rdv_undone');
    expect(contactCounters(db, isoWeekMonday(S(10, 2030))).appointments).toBe(2); // cumul : ne dépend pas de la semaine
  });

  it('exclut toujours Ignoré ; aucun prospect sans échéance sauf filtre d’état explicite', () => {
    const { db, list } = setup();
    const all = [...list({}), ...list({ week: S(40) }), ...list({ filter: 'to_handle' }), ...list({ status: 'neutral' })];
    expect(all).not.toContain('ign');
    expect(all).not.toContain('ign_week');
    expect(list({})).not.toContain('n_none');
    expect(list({})).not.toContain('fail');
    expect(list({})).toHaveLength(11);
    expect(list({ status: 'neutral' })).toContain('n_none');
    expect(list({ status: 'failure' })).toEqual(['fail']);
    expect(list({ week: S(40), status: 'neutral' })).toEqual(['n_now']);
    expect(contactDashboard(db, today).weeks.some(w => w.year === 2026 && w.week === 40 && w.count === 4)).toBe(true);
  });

  it('liste triée par (année, semaine), sans semaine en dernier', () => {
    const { db } = setup();
    const weeks = contactProspects(db, {}, today).map(r => `${r.next_action_year}-${r.next_action_week}`);
    expect(weeks[0]).toBe('2025-52');
    expect(weeks.at(-1)).toBe('2027-1');
  });

  it('un filtre ne modifie aucun état ni historique', () => {
    const { db } = setup();
    const snapshot = () => JSON.stringify([db.prepare('SELECT * FROM contact_tracking ORDER BY id').all(), db.prepare('SELECT count(*) n FROM contact_tracking_status_history').get()]);
    const before = snapshot();
    for (const filter of contactFilters) contactProspects(db, { filter }, today);
    contactDashboard(db, today);
    contactProspects(db, { week: S(40), status: 'r2' }, today);
    expect(snapshot()).toBe(before);
  });
});

describe('paramètres de la liste Contact', () => {
  it('valide filtre, couple année/semaine ISO et état', () => {
    expect(parseContactListQuery({})).toEqual({ ok: true, query: {} });
    expect(parseContactListQuery({ filter: 'review', year: '2026', week: '53', status: 'r2' })).toEqual({ ok: true, query: { filter: 'review', week: S(53), status: 'r2' } });
    expect(parseContactListQuery({ year: '2027', week: '53' }).ok).toBe(false); // 2027 n'a que 52 semaines ISO
    expect(parseContactListQuery({ week: '40' }).ok).toBe(false);
    expect(parseContactListQuery({ filter: 'contacted' }).ok).toBe(false);
    expect(parseContactListQuery({ status: 'ignored' }).ok).toBe(false);
    expect(parseContactListQuery({ status: 'to_contact' }).ok).toBe(false);
  });

  it('aller-retour URL', () => {
    const query: ContactListQuery = { week: S(1, 2027), status: 'r1' };
    const params = Object.fromEntries(new URLSearchParams(contactListSearchParams(query)));
    expect(parseContactListQuery(params)).toEqual({ ok: true, query });
  });
});

describe('affichage Contact', () => {
  it('seulement les deux métriques actées, cliquables', () => {
    const cards = contactCards({ toHandle: 6, firstContact: 3, followUp: 2, review: 1, appointments: 2 }, S(40));
    expect([cards.toHandle, ...cards.breakdown, cards.appointments].map(c => [c.label, c.count, c.filter])).toEqual([
      ['À traiter cette semaine', 6, 'to_handle'], ['Premier contact', 3, 'first_contact'], ['Relances', 2, 'follow_up'],
      ['Revues R2', 1, 'review'], ['RDV pris', 2, 'appointments']
    ]);
  });

  it('cartes et semaine : une carte remplace les critères, re-cliquer la désactive', () => {
    expect(toggleCardFilter({ week: S(41), status: 'r1' }, 'to_handle')).toEqual({ filter: 'to_handle' });
    expect(toggleCardFilter({ filter: 'to_handle' }, 'to_handle')).toEqual({});
    expect(withWeekFilter({ filter: 'review', status: 'r2' }, S(42))).toEqual({ week: S(42), status: 'r2' });
  });

  it('options semaine : semaine courante toujours proposée, année affichée hors année courante', () => {
    const options = weekFilterOptions([{ ...S(1, 2027), count: 1 }, { ...S(38), count: 2 }], S(40));
    expect(options.map(o => weekOptionLabel(o, S(40)))).toEqual(['S38', 'S40', 'S1 · 2027']);
    expect(contactStateOptions.map(o => o.value)).not.toContain('ignored');
  });

  it('R2 + semaine = revue, pas une relance ; pas d’étape sans semaine', () => {
    expect(nextStepLabel('neutral', true)).toBe('Premier contact');
    expect(nextStepLabel('contacted', true)).toBe('Relance R1');
    expect(nextStepLabel('r1', true)).toBe('Relance R2');
    expect(nextStepLabel('r2', true)).toMatch(/^Revue/);
    expect(nextStepLabel('neutral', false)).toBeNull();
    expect(nextStepLabel('appointment_obtained', true)).toBeNull();
  });

  it('la page Contact affiche les cartes-filtres et aucune autre métrique', () => {
    const markup = renderToStaticMarkup(createElement(ContactPage, { onPlanInProspection: () => undefined }));
    expect(markup).toContain('À traiter cette semaine');
    expect(markup).toContain('RDV pris');
    expect(markup.match(/aria-pressed=/g)).toHaveLength(5);
    expect(markup).not.toMatch(/Contactés|Réponses|Inconnu/);
  });
});
