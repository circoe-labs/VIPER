// Accueil (retour « PARTIE PROSPECTION », fusion main) : compteurs sur le modèle Contact, tendance, camembert, journal 24 h.
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { schema } from '../src/server/schema.js';
import { homeDashboard } from '../src/server/homeDashboard.js';
import { cohortSchedule, monthPie, responseTrendView } from '../src/client/homeDisplay';

const now = new Date('2026-09-30T10:00:00Z'); // mercredi, semaine ISO 40
const at = (iso: string) => iso.replace('T', ' ').slice(0, 19);

type Row = { id: string; status?: string; week?: number; email?: boolean; phone?: boolean; dnc?: boolean; history?: [string, string, string][]; responseAt?: string };
// history : [to_status, changed_at ISO, actor_type]
const fixture: Row[] = [
  { id: 'a', status: 'neutral', week: 41, email: true, phone: true },                       // premier contact planifié
  { id: 'b', status: 'neutral' },                                                           // sans semaine : hors séquence, coordonnées incomplètes
  { id: 'c', status: 'contacted', week: 42, email: true, history: [['contacted', '2026-09-28T09:00:00Z', 'human']] },
  { id: 'd', status: 'r1', week: 42, email: true, phone: true, dnc: true },                // bloqué : hors activité
  { id: 'e', status: 'response_received', email: true, phone: true, responseAt: '2026-09-29T08:00:00Z', history: [['response_received', '2026-09-29T08:00:00Z', 'human']] },
  { id: 'f', status: 'appointment_obtained', email: true, phone: true, history: [['appointment_obtained', '2026-09-20T08:00:00Z', 'human']] },
  { id: 'g', status: 'failure', email: true, phone: true, history: [['failure', '2026-08-15T08:00:00Z', 'human']] },  // Failure du mois précédent
  { id: 'h', status: 'response_received', email: true, phone: true, history: [['response_received', '2026-09-30T06:00:00Z', 'system']] } // migration : pas une réponse humaine
];

function setup() {
  const db = new Database(':memory:');
  db.exec(schema);
  db.prepare("INSERT INTO companies(id,display_name) VALUES('c1','Synthetic Co')").run();
  for (const r of fixture) {
    db.prepare("INSERT INTO prospects(id,company_id,first_name,last_name,contactability_status) VALUES(?,?,?,'Test',?)").run(r.id, 'c1', r.id, r.dnc ? 'do_not_contact' : 'contactable');
    if (r.email) db.prepare('INSERT INTO emails(id,prospect_id,address,is_primary,is_active) VALUES(?,?,?,1,1)').run(`e_${r.id}`, r.id, `${r.id}@example.test`);
    if (r.phone) db.prepare("INSERT INTO phones(id,prospect_id,number,type,is_primary,is_active) VALUES(?,?,'0600000000','mobile',1,1)").run(`ph_${r.id}`, r.id);
    if (!r.status) continue;
    db.prepare('INSERT INTO contact_tracking(id,prospect_id,status,next_action_year,next_action_week,response_received_at) VALUES(?,?,?,?,?,?)')
      .run(`t_${r.id}`, r.id, r.status, r.week ? 2026 : null, r.week ?? null, r.responseAt ?? null);
    for (const [to, changed, actor] of r.history || []) db.prepare('INSERT INTO contact_tracking_status_history(id,contact_tracking_id,to_status,changed_at,actor_type) VALUES(?,?,?,?,?)')
      .run(`h_${r.id}_${to}`, `t_${r.id}`, to, at(changed), actor);
  }
  db.prepare("INSERT INTO audit_log(id,actor_type,entity_type,entity_id,action,created_at) VALUES('recent','human','prospect','a','update',?),('old','human','prospect','b','update',?)")
    .run(at('2026-09-29T12:00:00Z'), at('2026-09-28T12:00:00Z'));
  return db;
}

describe('Accueil — compteurs (modèle Contact)', () => {
  it('BASE : prospects, RDV pris, Failure, coordonnées incomplètes', () => {
    const d = homeDashboard(setup(), now);
    expect([d.total, d.appointments, d.failures, d.incompleteContact]).toEqual([8, 1, 1, 2]); // b (rien) + c (pas de téléphone)
  });

  it('activité : séquence en cours et sans réponse excluent le blocage durable ; aucun devis', () => {
    const d = homeDashboard(setup(), now);
    expect(d.activity).toEqual({ inSequence: 2, withoutResponse: 1, appointments: 1 }); // a + c ; c
    expect(Object.keys(d.activity)).not.toContain('quotes');
  });

  it('tendance : réponses humaines des 7 derniers jours vs les 7 précédents (hors migration système)', () => {
    expect(homeDashboard(setup(), now).responseTrend).toEqual({ current: 1, previous: 1 }); // e (29/09) ; f (20/09)
  });

  it('camembert : états courants posés par un humain depuis le 1er du mois', () => {
    expect(homeDashboard(setup(), now).month).toEqual({ sequence: 1, response_received: 1, appointment_obtained: 1, failure: 0, ignored: 0 });
  });

  it('journal : seulement les 24 dernières heures', () => {
    expect(homeDashboard(setup(), now).recent.map(r => r.id)).toEqual(['recent']);
  });
});

describe('Accueil — affichage', () => {
  it('flèche verte montante, rouge descendante, neutre à égalité', () => {
    expect(responseTrendView({ current: 5, previous: 2 })).toMatchObject({ tone: 'up', label: '+3' });
    expect(responseTrendView({ current: 1, previous: 4 })).toMatchObject({ tone: 'down', label: '-3' });
    expect(responseTrendView({ current: 2, previous: 2 })).toMatchObject({ tone: 'flat', label: '0' });
  });

  it('camembert cumulé jusqu’à 100 % avec un code couleur par état ; gris sans résultat', () => {
    const pie = monthPie({ sequence: 2, response_received: 1, appointment_obtained: 1, failure: 0, ignored: 0 });
    expect(pie.total).toBe(4);
    expect(pie.segments.at(-1)?.to).toBeCloseTo(100);
    expect(new Set(pie.segments.map(s => s.color)).size).toBe(5);
    expect(monthPie({ sequence: 0, response_received: 0, appointment_obtained: 0, failure: 0, ignored: 0 }).background).toContain('#26312d');
  });

  it('planning : S37 le lundi, S39 le mardi, S40 le mercredi (prochaine occurrence, aujourd’hui inclus)', () => {
    const plan = cohortSchedule(new Date(2026, 8, 30, 9)); // mercredi 30 sept. 2026 (heure locale)
    expect(plan.map(p => [p.week, p.day, p.date.getDate(), p.date.getMonth()])).toEqual([[37, 'lundi', 5, 9], [39, 'mardi', 6, 9], [40, 'mercredi', 30, 8]]);
  });
});
