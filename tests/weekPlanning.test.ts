import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { isoWeekMonday, type IsoWeek } from '../src/shared/contactWorkflow';
import {
  cadenceSuggestion, canPlanWeek, initialPlanningWeek, legacyDateWeek, planningWeekOptions, planningYearOptions, relativeWeekLabel,
  shiftPlanningWeek, storedWeek, weekPlanningPatch, withoutPlannedWeek, withPlanningWeek, withPlanningYear
} from '../src/client/weekPlanning';
import { WeekPlanner } from '../src/client/WeekPlanner';
import { schema } from '../src/server/schema.js';
import { createContactTrackingService, parseTrackingPatch } from '../src/server/contactTrackingService.js';
import { nextActionDueFilter, nextActionOrderSql } from '../src/server/contactTrackingSchema.js';

const S = (week: number, year = 2026): IsoWeek => ({ year, week });
const monday = (w: IsoWeek) => isoWeekMonday(w);
const today = monday(S(40)); // lundi 28 sept. 2026
const human = { type: 'human' as const, id: 'pilot-user' };

describe('planification de semaine — logique client', () => {
  it('pré-remplit avec la semaine enregistrée, sinon l’ancienne date prévue, sinon la cadence, sinon la semaine courante', () => {
    const cadence = cadenceSuggestion('contacted', monday(S(40)).toISOString(), today);
    expect(initialPlanningWeek({ current: S(45), legacyPlannedAt: '2026-10-12', cadence, today })).toEqual({ week: S(45), source: 'current' });
    expect(initialPlanningWeek({ current: null, legacyPlannedAt: '2026-10-12', cadence, today })).toEqual({ week: S(42), source: 'legacy_date' });
    expect(initialPlanningWeek({ current: null, legacyPlannedAt: null, cadence, today })).toEqual({ week: S(42), source: 'cadence' });
    expect(initialPlanningWeek({ current: null, legacyPlannedAt: 'n/a', cadence: null, today })).toEqual({ week: S(40), source: 'this_week' });
  });

  it('propose la cadence +2/+2/+4 depuis la semaine du choix de l’état, jamais pour neutral ni les états hors séquence', () => {
    expect(cadenceSuggestion('contacted', monday(S(40)).toISOString(), today)).toEqual({ week: S(42), label: 'Contacté + 2 sem.' });
    expect(cadenceSuggestion('r1', monday(S(42)).toISOString(), today)?.week).toEqual(S(44));
    expect(cadenceSuggestion('r2', monday(S(44)).toISOString(), today)).toEqual({ week: S(48), label: 'R2 + 4 sem.' });
    expect(cadenceSuggestion('r1', null, today)?.week).toEqual(S(42)); // sans date d'état : depuis aujourd'hui
    for (const status of ['neutral', 'response_received', 'appointment_obtained', 'failure', 'ignored', 'to_contact', null]) {
      expect(cadenceSuggestion(status, null, today)).toBeNull();
    }
  });

  it('change d’année : S52/S53 -> S1, S1 -> S52/S53, et proposition de cadence à cheval sur deux années', () => {
    expect(shiftPlanningWeek(S(53, 2026), 1)).toEqual(S(1, 2027));
    expect(shiftPlanningWeek(S(52, 2027), 1)).toEqual(S(1, 2028));
    expect(shiftPlanningWeek(S(1, 2027), -1)).toEqual(S(53, 2026));
    expect(shiftPlanningWeek(S(1, 2028), -1)).toEqual(S(52, 2027));
    expect(cadenceSuggestion('r2', monday(S(51)).toISOString(), today)?.week).toEqual(S(2, 2027));
    expect(cadenceSuggestion('contacted', monday(S(52, 2027)).toISOString(), today)?.week).toEqual(S(2, 2028));
  });

  it('borne la semaine à l’année choisie (S53 inexistante en 2027) et liste 52 ou 53 options', () => {
    expect(withPlanningYear(S(53, 2026), 2027)).toEqual(S(52, 2027));
    expect(withPlanningYear(S(40, 2026), 2027)).toEqual(S(40, 2027));
    expect(withPlanningWeek(S(1, 2027), 53)).toEqual(S(52, 2027));
    expect(planningWeekOptions(2026)).toHaveLength(53);
    expect(planningWeekOptions(2027)).toHaveLength(52);
    expect(planningWeekOptions(2026)[39].label).toMatch(/^S40 · lun\. 28 sept\.$/);
    expect(planningYearOptions(S(40), today)).toEqual([2025, 2026, 2027, 2028]);
    expect(planningYearOptions(S(3, 2031), today)).toEqual([2025, 2026, 2027, 2028, 2031]);
  });

  it('construit le PATCH de semaine seule (jamais de status) et refuse un couple ISO invalide', () => {
    expect(weekPlanningPatch(S(40))).toEqual({ next_action_year: 2026, next_action_week: 40 });
    expect(weekPlanningPatch(null)).toEqual({ next_action_year: null, next_action_week: null });
    expect(() => weekPlanningPatch(S(53, 2027))).toThrow(/S53/);
    expect(storedWeek(2027, 53)).toBeNull();
    expect(storedWeek('2026', '40')).toEqual(S(40));
    expect(storedWeek(null, 40)).toBeNull();
  });

  it('lit l’ancienne date prévue en semaine ISO, y compris au bord d’année', () => {
    expect(legacyDateWeek('2026-12-31')).toEqual(S(53, 2026));
    expect(legacyDateWeek('2027-01-03T09:00:00.000Z')).toEqual(S(53, 2026));
    expect(legacyDateWeek('2027-01-04')).toEqual(S(1, 2027));
    expect(legacyDateWeek('2026-02-30')).toBeNull();
    expect(legacyDateWeek(null)).toBeNull();
  });

  it('libellé relatif et verrou sur ignored', () => {
    expect(relativeWeekLabel(S(40), today)).toBe('cette semaine');
    expect(relativeWeekLabel(S(2, 2027), today)).toBe('dans 15 semaines');
    expect(relativeWeekLabel(S(39), today)).toBe('il y a 1 semaine (échue)');
    expect(canPlanWeek('ignored')).toBe(false);
    expect(canPlanWeek('neutral')).toBe(true);
    expect(canPlanWeek(undefined)).toBe(true);
  });

  it('rend un sélecteur clavier (selects libellés, boutons précédent/suivant) et bloque ignored', () => {
    const markup = renderToStaticMarkup(createElement(WeekPlanner, { prospectId: 'p1', tracking: { status: 'neutral', next_action_year: 2026, next_action_week: 53 }, onSaved: () => undefined }));
    expect(markup).toContain('aria-label="Semaine précédente"');
    expect(markup).toContain('aria-label="Semaine suivante"');
    expect(markup).toContain('for="week-planner-p1-year"');
    expect(markup).toContain('for="week-planner-p1-week"');
    expect(markup).toContain('Retirer l’échéance');
    expect(markup).not.toContain('state-badge');
    const ignored = renderToStaticMarkup(createElement(WeekPlanner, { prospectId: 'p2', tracking: { status: 'ignored' }, onSaved: () => undefined }));
    expect(ignored).not.toContain('<select');
  });
});

describe('planification de semaine — persistance et liste Prospection', () => {
  function setup() {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    db.prepare("INSERT INTO companies(id,display_name) VALUES('c1','Synthetic Co')").run();
    const service = createContactTrackingService(db, { now: () => today });
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      db.prepare("INSERT INTO prospects(id,company_id,first_name,last_name) VALUES(?,'c1','P','Test')").run(id);
      service.applyProspectPayload(id, {}, human);
    }
    return { db, service };
  }

  it('le PATCH construit côté client planifie S40 depuis neutral, déplace en S41, passe l’année puis efface, sans changer l’état', () => {
    const { service } = setup();
    const patch = (week: IsoWeek | null) => service.updateTracking('p1', parseTrackingPatch(weekPlanningPatch(week)), human);
    expect(patch(S(40))).toMatchObject({ stateChanged: false, changed: ['next_action'], tracking: { status: 'neutral', next_action_year: 2026, next_action_week: 40 } });
    expect(patch(S(41)).tracking).toMatchObject({ status: 'neutral', next_action_week: 41 });
    expect(patch(shiftPlanningWeek(S(53), 1)).tracking).toMatchObject({ status: 'neutral', next_action_year: 2027, next_action_week: 1 });
    expect(patch(null).tracking).toMatchObject({ status: 'neutral', next_action_year: null, next_action_week: null });
    expect(service.getHistory('p1')).toHaveLength(1);
  });

  it('l’enregistrement de la fiche ne renvoie pas la semaine : un brouillon ancien ne réécrit pas la semaine planifiée', () => {
    const { service } = setup();
    service.setNextActionWeek('p1', S(42), human);
    const staleDraft = { status: 'neutral', next_action_year: 2026, next_action_week: 40, contact_year: 2026, contact_week: 40, planned_contact_at: null };
    expect(withoutPlannedWeek(staleDraft)).toEqual({ status: 'neutral', planned_contact_at: null });
    expect(withoutPlannedWeek(null)).toBeNull();
    service.applyProspectPayload('p1', withoutPlannedWeek(staleDraft), human);
    expect(service.getTracking('p1')).toMatchObject({ status: 'neutral', next_action_year: 2026, next_action_week: 42 });
  });

  it('« contacts dus » = neutral avec semaine atteinte (échues incluses) ; tri par année puis semaine', () => {
    const { db, service } = setup();
    service.setNextActionWeek('p1', S(1, 2027), human);
    service.setNextActionWeek('p2', S(53, 2026), human);
    service.setNextActionWeek('p3', S(39, 2026), human);
    const due = nextActionDueFilter(today);
    const dueIds = (db.prepare(`SELECT ct.prospect_id id FROM contact_tracking ct WHERE ct.status='neutral' AND ${due.sql} ORDER BY ct.prospect_id`).all(...due.params) as { id: string }[]).map(r => r.id);
    expect(dueIds).toEqual(['p3']);
    const ordered = (db.prepare(`SELECT ct.prospect_id id FROM contact_tracking ct ORDER BY ${nextActionOrderSql()}`).all() as { id: string }[]).map(r => r.id);
    expect(ordered).toEqual(['p3', 'p2', 'p1', 'p4']);
    const newYear = nextActionDueFilter(monday(S(1, 2027)));
    expect((db.prepare(`SELECT count(*) n FROM contact_tracking ct WHERE ${newYear.sql}`).get(...newYear.params) as { n: number }).n).toBe(3);
  });
});
