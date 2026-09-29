// Requêtes des cartes-filtres Prospection (Task 07) : une seule définition SQL par filtre, partagée par la liste
// (`GET /api/prospects?filter=`), les compteurs (`GET /api/prospection/counters`) et l'Accueil (`GET /api/dashboard`).
import type Database from 'better-sqlite3';
import type { ProspectionCounters, ProspectionFilter } from '../shared/prospectionDashboard.js';
import { nextActionDueFilter } from './contactTrackingSchema.js';

export type SqlCondition = { sql: string; params: (string | number)[] };

/** Condition sur les alias `p` (prospects) et `ct` (contact_tracking en LEFT JOIN). */
export function prospectionFilterSql(filter: ProspectionFilter, today: Date): SqlCondition {
  switch (filter) {
    case 'due': {
      const due = nextActionDueFilter(today);
      return { sql: `ct.status='neutral' AND ${due.sql}`, params: due.params };
    }
    case 'employment_unverified': return { sql: 'p.employment_verified_at IS NULL', params: [] };
    case 'email_to_review': return { sql: "NOT EXISTS(SELECT 1 FROM emails ev WHERE ev.prospect_id=p.id AND ev.is_primary=1 AND ev.is_active=1 AND ev.verification_status='verified')", params: [] };
  }
}

/** Recherche texte de la liste (nom, entreprise, email principal, fonction) sur les alias `p`, `c`, `e`. */
export function prospectSearchSql(q: string): SqlCondition {
  const term = q.trim();
  if (!term) return { sql: '1=1', params: [] };
  const like = `%${term}%`;
  return { sql: "(p.first_name||' '||p.last_name LIKE ? OR c.display_name LIKE ? OR e.address LIKE ? OR p.exact_job_title LIKE ?)", params: [like, like, like, like] };
}

const COUNTER_FROM = 'prospects p JOIN companies c ON c.id=p.company_id LEFT JOIN emails e ON e.prospect_id=p.id AND e.is_primary=1 AND e.is_active=1 LEFT JOIN contact_tracking ct ON ct.prospect_id=p.id';

/** Compteurs des cartes Prospection, restreints à la recherche `q` comme la liste (sans plafond de 500 lignes). */
export function prospectionCounters(db: Database.Database, options: { today: Date; q?: string }): ProspectionCounters {
  const search = prospectSearchSql(options.q || '');
  const count = (condition?: SqlCondition) => Number((db.prepare(`SELECT count(DISTINCT p.id) n FROM ${COUNTER_FROM} WHERE ${search.sql}${condition ? ` AND ${condition.sql}` : ''}`)
    .get(...search.params, ...(condition?.params || [])) as { n: number }).n);
  return {
    total: count(),
    due: count(prospectionFilterSql('due', options.today)),
    employmentUnverified: count(prospectionFilterSql('employment_unverified', options.today)),
    emailToReview: count(prospectionFilterSql('email_to_review', options.today))
  };
}
