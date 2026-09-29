// Requêtes du dashboard Contact (Task 09) : une seule définition SQL par filtre, partagée par la liste
// (`GET /api/contact/prospects`), les compteurs (`GET /api/contact/dashboard`) et le compteur « Rendez-vous » de l'Accueil.
// Lecture seule : aucun filtre ni compteur ne modifie un état (décision 10).
import type Database from 'better-sqlite3';
import { isoWeekOf, type IsoWeek } from '../shared/contactWorkflow.js';
import type { ContactCounters, ContactDashboard, ContactFilter, ContactListItem, ContactListQuery, ContactWeekOption } from '../shared/contactDashboard.js';
import { nextActionDueFilter, nextActionOrderSql } from './contactTrackingSchema.js';
import type { SqlCondition } from './prospectionDashboard.js';

/** Périmètre de Contact : prospects suivis, hors `ignored` (terminal). Alias `ct` = contact_tracking. */
const CONTACT_SCOPE = "ct.status<>'ignored'";
const CONTACT_FROM = 'contact_tracking ct JOIN prospects p ON p.id=ct.prospect_id JOIN companies c ON c.id=p.company_id';

const dueWithStates = (states: string[], today: Date): SqlCondition => {
  const due = nextActionDueFilter(today);
  return { sql: `ct.status IN (${states.map(() => '?').join(',')}) AND ${due.sql}`, params: [...states, ...due.params] };
};

/** Condition d'une carte (définitions : `src/shared/contactDashboard.ts`). */
export function contactFilterSql(filter: ContactFilter, today: Date): SqlCondition {
  switch (filter) {
    case 'to_handle': return dueWithStates(['neutral', 'contacted', 'r1', 'r2'], today);
    case 'first_contact': return dueWithStates(['neutral'], today);
    case 'follow_up': return dueWithStates(['contacted', 'r1'], today);
    case 'review': return dueWithStates(['r2'], today);
    case 'appointments': return { sql: "ct.status='appointment_obtained'", params: [] };
  }
}

/** Prochaine semaine exactement égale au couple (année ISO, semaine ISO). */
export const contactWeekSql = ({ year, week }: IsoWeek): SqlCondition => ({ sql: 'ct.next_action_year=? AND ct.next_action_week=?', params: [year, week] });

/** Condition complète de la liste ; sans critère = prospects planifiés (avec prochaine semaine), jamais sans échéance. */
export function contactListCondition(query: ContactListQuery, today: Date): SqlCondition {
  const parts: SqlCondition[] = [{ sql: CONTACT_SCOPE, params: [] }];
  if (query.filter) parts.push(contactFilterSql(query.filter, today));
  if (query.week) parts.push(contactWeekSql(query.week));
  if (query.status) parts.push({ sql: 'ct.status=?', params: [query.status] });
  if (!query.filter && !query.week && !query.status) parts.push({ sql: 'ct.next_action_year IS NOT NULL', params: [] });
  return { sql: parts.map(p => `(${p.sql})`).join(' AND '), params: parts.flatMap(p => p.params) };
}

/** Liste Contact triée par prochaine semaine (sans semaine en dernier), puis nom ; 500 lignes au plus comme Prospection. */
export function contactProspects(db: Database.Database, query: ContactListQuery, today: Date): ContactListItem[] {
  const where = contactListCondition(query, today);
  return db.prepare(`SELECT p.id,p.first_name,p.last_name,p.exact_job_title,c.display_name company,r.label role,e.address primary_email,ct.status tracking_status,ct.next_action_year,ct.next_action_week FROM ${CONTACT_FROM} LEFT JOIN roles r ON r.id=p.role_id LEFT JOIN emails e ON e.prospect_id=p.id AND e.is_primary=1 AND e.is_active=1 WHERE ${where.sql} ORDER BY ${nextActionOrderSql()},p.last_name,p.first_name,p.id LIMIT 500`)
    .all(...where.params) as ContactListItem[];
}

const countWhere = (db: Database.Database, condition: SqlCondition) =>
  Number((db.prepare(`SELECT count(DISTINCT ct.prospect_id) n FROM ${CONTACT_FROM} WHERE (${CONTACT_SCOPE}) AND (${condition.sql})`).get(...condition.params) as { n: number }).n);

/** Nombre de prospects d'une carte (même condition que la liste filtrée). */
export const countContactFilter = (db: Database.Database, filter: ContactFilter, today: Date) => countWhere(db, contactFilterSql(filter, today));

/** Compteurs des cartes : chacun = nombre de lignes du filtre correspondant (même condition SQL). */
export function contactCounters(db: Database.Database, today: Date): ContactCounters {
  const count = (filter: ContactFilter) => countContactFilter(db, filter, today);
  return { toHandle: count('to_handle'), firstContact: count('first_contact'), followUp: count('follow_up'), review: count('review'), appointments: count('appointments') };
}

/** Semaines présentes dans le planning (hors `ignored`), triées (année, semaine) : options du filtre semaine. */
export function contactWeekOptions(db: Database.Database): ContactWeekOption[] {
  return db.prepare(`SELECT ct.next_action_year year,ct.next_action_week week,count(DISTINCT ct.prospect_id) count FROM ${CONTACT_FROM} WHERE ${CONTACT_SCOPE} AND ct.next_action_year IS NOT NULL AND ct.next_action_week IS NOT NULL GROUP BY ct.next_action_year,ct.next_action_week ORDER BY ct.next_action_year,ct.next_action_week`)
    .all() as ContactWeekOption[];
}

export function contactDashboard(db: Database.Database, today: Date): ContactDashboard {
  return { currentWeek: isoWeekOf(today), counters: contactCounters(db, today), weeks: contactWeekOptions(db) };
}
