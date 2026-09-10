import * as XLSX from 'xlsx';
import { db } from './db.js';

const statusLabels: Record<string, string> = {
  to_contact: 'À contacter', contacted: 'Contacté', follow_up_1: 'Relance 1', follow_up_2: 'Relance 2',
  response_received: 'Réponse reçue', appointment_obtained: 'Rendez-vous obtenu', quote_sent: 'Devis envoyé',
  quote_follow_up: 'Devis relancé', won: 'Commande passée', not_interested: 'Non intéressé'
};
const activityLabels: Record<string, string> = { active: 'Actif', inactive: 'Inactif', unknown: 'Inconnu' };
const emailLabels: Record<string, string> = { verified: 'Vérifié', unverified: 'À vérifier', invalid: 'Invalide', unknown: 'Inconnu' };

function isoWeek(value: unknown) {
  if (!value) return '';
  const d = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  const target = new Date(d);
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return `S${Math.ceil((((target.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)}`;
}

export function buildExport() {
  const raw = db.prepare(`SELECT
    trim(coalesce(ir.first_name,'')||' '||coalesce(ir.last_name,'')) AS referent,
    c.display_name AS company,c.email_domain,c.project_done_with_circoe,c.project_type,c.circoe_references,c.client_approach,
    ct.planned_contact_at,p.civility,p.last_name,p.first_name,r.label role,p.exact_job_title,p.activity_status,p.employment_verified_at,
    e.address email,e.verification_status email_verification,e.last_verified_at email_verified_at,
    ph.number phone,ct.status tracking_status,p.contactability_status,ct.response_received_at,ct.appointment_at
    FROM prospects p
    JOIN companies c ON c.id=p.company_id
    LEFT JOIN roles r ON r.id=p.role_id
    LEFT JOIN emails e ON e.prospect_id=p.id AND e.is_primary=1 AND e.is_active=1
    LEFT JOIN phones ph ON ph.prospect_id=p.id AND ph.is_primary=1 AND ph.is_active=1
    LEFT JOIN contact_tracking ct ON ct.prospect_id=p.id
    LEFT JOIN internal_referents ir ON ir.id=ct.referent_id
    ORDER BY c.display_name,p.last_name,p.first_name`).all() as any[];

  const data = raw.map(x => ({
    'Référent': x.referent || '',
    'Entreprise': x.company,
    'Contact planifié': x.planned_contact_at || '',
    'Semaine contact': isoWeek(x.planned_contact_at),
    'Civilité': x.civility || '',
    'Nom': x.last_name,
    'Prénom': x.first_name,
    'Rôle': x.role || '',
    'Fonction / intitulé exact': x.exact_job_title || '',
    'Statut activité': activityLabels[x.activity_status] || x.activity_status || '',
    'Vérification emploi': x.employment_verified_at ? 'Vérifié' : 'À vérifier',
    'Vérifié le': x.employment_verified_at || '',
    'Mail': x.email || '',
    'Statut email': emailLabels[x.email_verification] || x.email_verification || '',
    'Email vérifié le': x.email_verified_at || '',
    'Téléphone': x.phone || '',
    'Suivi de contact': statusLabels[x.tracking_status] || x.tracking_status || 'À contacter',
    'Contactabilité': x.contactability_status === 'do_not_contact' ? 'À ne plus contacter' : 'Contactable',
    'Réponse reçue le': x.response_received_at || '',
    'Rendez-vous le': x.appointment_at || '',
    'Projet déjà réalisé avec Circoe': x.project_done_with_circoe || '',
    'Type de projet': x.project_type || '',
    'Références Circoe': x.circoe_references || '',
    'Approche client': x.client_approach || '',
    'Domaine email entreprise': x.email_domain || ''
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Prospects');
  const aliases = db.prepare(`SELECT p.first_name||' '||p.last_name AS Prospect,e.address AS Email,e.is_primary AS Principal,e.verification_status AS Verification,e.last_verified_at AS Verifie_le,e.origin_type AS Origine,e.source_reference AS Source FROM emails e JOIN prospects p ON p.id=e.prospect_id WHERE e.is_active=1 ORDER BY Prospect,e.is_primary DESC`).all();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(aliases), 'Aliases emails');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}
