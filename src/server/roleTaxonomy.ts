import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type DefaultRole = {
  slug: string;
  label: string;
  aliases: string[];
};

export const DEFAULT_ROLES: DefaultRole[] = [
  { slug: 'gouvernance', label: 'Direction générale / Gouvernance', aliases: ['DG', 'PDG', 'Présidence', 'Gérance'] },
  { slug: 'direction', label: 'Direction', aliases: ['Directeur', 'Directrice'] },
  { slug: 'direction-adjointe', label: 'Direction adjointe / Vice-présidence', aliases: ['Adjoint', 'Vice-présidence'] },
  { slug: 'management', label: 'Responsable / Management', aliases: ['Responsable', 'Manager'] },
  { slug: 'pilotage', label: 'Chef / Pilotage', aliases: ['Chef', 'Pilotage'] },
  { slug: 'charge-mission-affaires', label: 'Chargé de mission / Affaires / Études', aliases: ['Chargé de mission', 'Chargé d’affaires', 'Chargé d’études'] },
  { slug: 'commercial-developpement', label: 'Commercial / Développement', aliases: ['Commercial', 'Développement commercial'] },
  { slug: 'technique-ingenierie-it', label: 'Technique / Ingénierie / IT', aliases: ['Ingénierie', 'Technique', 'IT'] },
  { slug: 'support-admin-rh-juridique', label: 'Support / Admin / RH / Juridique', aliases: ['RH', 'Administration', 'Juridique'] },
  { slug: 'institutionnel-conseil-autre', label: 'Institutionnel / Conseil / Autre', aliases: ['Institutionnel', 'Conseil', 'Autre'] }
];

const LEGACY_SYSTEM_ROLE_SLUGS = new Set([
  'direction',
  'logistique',
  'exploitation',
  'developpement-commercial',
  'commercial',
  'achats',
  'finance-administration',
  'ressources-humaines',
  'technique-it'
]);

function normalized(value: unknown) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function contains(title: string, pattern: RegExp) {
  return pattern.test(title);
}

export function inferRoleSlug(jobTitle: unknown): string | null {
  const title = normalized(jobTitle);
  if (!title) return null;

  // 1. Gouvernance / direction générale.
  if (contains(title, /(^| )(dg|pdg|ceo|gerant|gerante|dirigeant|dirigeante|president|presidente|fondateur|fondatrice|associe)( |$)/)) {
    return 'gouvernance';
  }
  if (contains(title, /(^| )(directeur general|directrice generale|president directeur general|chef d entreprise)( |$)/)) {
    return 'gouvernance';
  }

  // 2. Direction adjointe / vice-présidence avant la règle générique "direction".
  if (contains(title, /(^| )(adjoint|adjointe|vice president|senior vice president|sdg)( |$)/)) {
    return 'direction-adjointe';
  }

  // 3. Direction.
  if (contains(title, /(^| )(directeur|directrice|director|direction|dst|delegue general|executive officer)( |$)/)) {
    return 'direction';
  }

  // 4. Responsable / management.
  if (contains(title, /(^| )(responsable|manager|rrh)( |$)/)) {
    return 'management';
  }

  // 5. Chef / pilotage.
  if (contains(title, /(^| )chef( |$)/)) {
    return 'pilotage';
  }

  // 6. Chargé de mission / affaires / études.
  if (contains(title, /(^| )(charge|chargee)( |$)/)) {
    return 'charge-mission-affaires';
  }

  // 7. Commercial / développement.
  if (contains(title, /(^| )(commercial|commerciale|sales|ventes|business developer|business development)( |$)/)) {
    return 'commercial-developpement';
  }

  // 8. Technique / ingénierie / IT.
  if (contains(title, /(^| )(ingenieur|ingenieure|technical|digital|informatique|it|dsi|cto)( |$)/)) {
    return 'technique-ingenierie-it';
  }
  if (title.includes('product development') || title.includes('design and application architecture')) {
    return 'technique-ingenierie-it';
  }

  // 9. Fonctions support.
  if (contains(title, /(^| )(rh|ressources humaines|administrative|financial|secretaire|assistante|juriste|finance|comptable)( |$)/)) {
    return 'support-admin-rh-juridique';
  }

  // 10. Institutionnel / conseil / cas non standard.
  return 'institutionnel-conseil-autre';
}

export function roleLabelForSlug(slug: string | null | undefined) {
  return DEFAULT_ROLES.find(role => role.slug === slug)?.label || null;
}

export function ensureDefaultRoles(db: Database.Database) {
  const ids = new Map<string, string>();

  // Les anciennes catégories automatiques deviennent inactives, sauf "direction"
  // qui est réutilisée pour le nouveau groupe Direction.
  for (const slug of LEGACY_SYSTEM_ROLE_SLUGS) {
    if (slug !== 'direction') db.prepare('UPDATE roles SET active=0,updated_at=CURRENT_TIMESTAMP WHERE slug=?').run(slug);
  }

  for (const role of DEFAULT_ROLES) {
    let current = db.prepare('SELECT id,label,slug FROM roles WHERE slug=?').get(role.slug) as any;
    if (!current) {
      current = { id: randomUUID(), slug: role.slug, label: role.label };
      db.prepare('INSERT INTO roles(id,label,slug,active) VALUES(?,?,?,1)').run(current.id, role.label, role.slug);
    } else {
      db.prepare('UPDATE roles SET label=?,active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(role.label, current.id);
    }
    ids.set(role.slug, current.id);
  }

  return ids;
}

export function backfillUnassignedProspectRoles(db: Database.Database) {
  const ids = ensureDefaultRoles(db);
  const legacySlugs = Array.from(LEGACY_SYSTEM_ROLE_SLUGS);
  const placeholders = legacySlugs.map(() => '?').join(',');
  const prospects = db.prepare(`
    SELECT p.id,p.exact_job_title,r.slug current_role_slug
    FROM prospects p
    LEFT JOIN roles r ON r.id=p.role_id
    WHERE coalesce(trim(p.exact_job_title),'')<>''
      AND (p.role_id IS NULL OR r.slug IN (${placeholders}))
  `).all(...legacySlugs) as any[];

  let updated = 0;
  const update = db.prepare('UPDATE prospects SET role_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?');
  for (const prospect of prospects) {
    const slug = inferRoleSlug(prospect.exact_job_title);
    const roleId = slug ? ids.get(slug) : null;
    if (roleId) updated += update.run(roleId, prospect.id).changes;
  }
  return updated;
}
