// Requêtes de l'Accueil (`GET /api/dashboard`) sur le modèle Contact. Lecture seule, aucun état modifié (décision 10).
// Définitions : `src/shared/homeDashboard.ts`. Les cases reprennent les SQL existants (Prospection, dashboard Contact).
import type Database from 'better-sqlite3';
import { monthOutcomeKeys, monthOutcomeStates, type HomeAuditEntry, type HomeDashboard, type MonthOutcomes } from '../shared/homeDashboard.js';
import { countContactFilter } from './contactDashboard.js';
import { prospectionCounters } from './prospectionDashboard.js';

const DAY_MS = 86400000;
const sqlTime = (date: Date) => date.toISOString().replace('T', ' ').slice(0, 19); // format de CURRENT_TIMESTAMP (UTC)
const count = (db: Database.Database, sql: string, params: (string | number)[] = []) => Number((db.prepare(sql).get(...params) as { n: number } | undefined)?.n || 0);

/** Prospects ayant reçu une réponse (passage humain à `response_received` ou `appointment_obtained`) dans [from, to[. */
export function responsesBetween(db: Database.Database, from: Date, to: Date): number {
  return count(db, "SELECT count(DISTINCT h.contact_tracking_id) n FROM contact_tracking_status_history h WHERE h.actor_type='human' AND h.to_status IN ('response_received','appointment_obtained') AND datetime(h.changed_at)>=datetime(?) AND datetime(h.changed_at)<datetime(?)", [sqlTime(from), sqlTime(to)]);
}

/** Répartition des états courants posés par un humain depuis le 1er du mois (UTC) ; `neutral` n'est pas un résultat. */
export function monthOutcomes(db: Database.Database, now: Date): MonthOutcomes {
  const start = sqlTime(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const result = Object.fromEntries(monthOutcomeKeys.map(k => [k, 0])) as MonthOutcomes;
  for (const key of monthOutcomeKeys) {
    const states = monthOutcomeStates[key];
    result[key] = count(db, `SELECT count(*) n FROM contact_tracking ct WHERE ct.status IN (${states.map(() => '?').join(',')}) AND EXISTS(SELECT 1 FROM contact_tracking_status_history h WHERE h.contact_tracking_id=ct.id AND h.to_status=ct.status AND h.actor_type='human' AND datetime(h.changed_at)>=datetime(?))`, [...states, start]);
  }
  return result;
}

export function homeDashboard(db: Database.Database, now: Date): HomeDashboard {
  const counters = prospectionCounters(db, { today: now });
  const notBlocked = "NOT EXISTS(SELECT 1 FROM prospects pb WHERE pb.id=ct.prospect_id AND pb.contactability_status='do_not_contact')";
  return {
    total: counters.total,
    appointments: countContactFilter(db, 'appointments', now),
    failures: count(db, "SELECT count(*) n FROM contact_tracking WHERE status='failure'"),
    incompleteContact: counters.incompleteContact,
    responseTrend: {
      // Borne haute +1 s : `changed_at` est à la seconde, une réponse enregistrée dans la seconde courante reste comptée.
      current: responsesBetween(db, new Date(now.getTime() - 7 * DAY_MS), new Date(now.getTime() + 1000)),
      previous: responsesBetween(db, new Date(now.getTime() - 14 * DAY_MS), new Date(now.getTime() - 7 * DAY_MS))
    },
    activity: {
      inSequence: count(db, `SELECT count(*) n FROM contact_tracking ct WHERE (ct.status IN ('contacted','r1','r2') OR (ct.status='neutral' AND ct.next_action_year IS NOT NULL)) AND ${notBlocked}`),
      withoutResponse: count(db, `SELECT count(*) n FROM contact_tracking ct WHERE ct.status IN ('contacted','r1','r2') AND ct.response_received_at IS NULL AND ${notBlocked}`),
      appointments: countContactFilter(db, 'appointments', now)
    },
    month: monthOutcomes(db, now),
    recent: db.prepare('SELECT id,entity_type,entity_id,action,actor_display,created_at FROM audit_log WHERE datetime(created_at)>=datetime(?) ORDER BY created_at DESC LIMIT 50')
      .all(sqlTime(new Date(now.getTime() - DAY_MS))) as HomeAuditEntry[]
  };
}
