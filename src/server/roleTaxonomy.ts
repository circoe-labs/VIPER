import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export type DefaultRole = {
  slug: string;
  label: string;
  aliases: string[];
};

export const DEFAULT_ROLES: DefaultRole[] = [
  { slug: 'direction', label: 'Direction / Gérance', aliases: ['Direction', 'Gérance'] },
  { slug: 'logistique', label: 'Logistique', aliases: [] },
  { slug: 'exploitation', label: 'Exploitation / Opérations', aliases: ['Exploitation', 'Opérations'] },
  { slug: 'developpement-commercial', label: 'Développement commercial', aliases: ['Développement', 'Business development'] },
  { slug: 'commercial', label: 'Commercial / Ventes', aliases: ['Commercial', 'Ventes'] },
  { slug: 'achats', label: 'Achats', aliases: [] },
  { slug: 'finance-administration', label: 'Finance / Administration', aliases: ['Finance', 'Administration'] },
  { slug: 'ressources-humaines', label: 'Ressources humaines', aliases: ['RH'] },
  { slug: 'technique-it', label: 'Technique / IT', aliases: ['Technique', 'IT'] }
];

function normalized(value: unknown) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function hasAny(title: string, terms: string[]) {
  return terms.some(term => {
    const t = normalized(term);
    return title === t || title.startsWith(t + ' ') || title.endsWith(' ' + t) || title.includes(' ' + t + ' ');
  });
}

export function inferRoleSlug(jobTitle: unknown): string | null {
  const title = normalized(jobTitle);
  if (!title) return null;

  // Domain-specific responsibilities take precedence over hierarchy.
  if (hasAny(title, ['logistique', 'supply chain', 'transport', 'entrepot'])) return 'logistique';
  if (hasAny(title, ['exploitation', 'operations', 'operationnel', 'production'])) return 'exploitation';
  if (
    hasAny(title, ['developpement commercial', 'business developer', 'business development', 'charge de developpement', 'chargee de developpement', 'partenariats'])
  ) return 'developpement-commercial';
  if (hasAny(title, ['commercial', 'ventes', 'sales', 'account manager', 'grands comptes'])) return 'commercial';
  if (hasAny(title, ['achats', 'achat', 'procurement', 'approvisionnement'])) return 'achats';
  if (hasAny(title, ['ressources humaines', 'recrutement', 'talent', 'rh'])) return 'ressources-humaines';
  if (hasAny(title, ['finance', 'financier', 'comptabilite', 'comptable', 'administratif', 'administration', 'daf', 'cfo'])) return 'finance-administration';
  if (hasAny(title, ['informatique', 'it', 'technique', 'dsi', 'cto', 'systemes d information'])) return 'technique-it';

  // Generic company leadership only when no clearer functional domain matched above.
  if (
    hasAny(title, ['gerant', 'gerante', 'dirigeant', 'dirigeante', 'directeur general', 'directrice generale', 'president', 'presidente', 'pdg', 'ceo', 'fondateur', 'fondatrice', 'cofondateur', 'cofondatrice', 'managing director'])
  ) return 'direction';

  return null;
}

export function roleLabelForSlug(slug: string | null | undefined) {
  return DEFAULT_ROLES.find(role => role.slug === slug)?.label || null;
}

export function ensureDefaultRoles(db: Database.Database) {
  const ids = new Map<string, string>();
  for (const role of DEFAULT_ROLES) {
    let current = db.prepare('SELECT id,label,slug FROM roles WHERE slug=?').get(role.slug) as any;
    if (!current) {
      const candidates = [role.label, ...role.aliases];
      for (const alias of candidates) {
        current = db.prepare('SELECT id,label,slug FROM roles WHERE lower(label)=lower(?)').get(alias) as any;
        if (current) break;
      }
    }
    if (!current) {
      current = { id: randomUUID(), slug: role.slug, label: role.label };
      db.prepare('INSERT INTO roles(id,label,slug) VALUES(?,?,?)').run(current.id, role.label, role.slug);
    } else {
      const labelOwner = db.prepare('SELECT id FROM roles WHERE lower(label)=lower(?) AND id<>?').get(role.label, current.id) as any;
      if (!labelOwner) db.prepare('UPDATE roles SET label=?,slug=?,active=1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(role.label, role.slug, current.id);
    }
    ids.set(role.slug, current.id);
  }
  return ids;
}

export function backfillUnassignedProspectRoles(db: Database.Database) {
  const ids = ensureDefaultRoles(db);
  const prospects = db.prepare("SELECT id,exact_job_title FROM prospects WHERE role_id IS NULL AND coalesce(trim(exact_job_title),'')<>''").all() as any[];
  let updated = 0;
  const update = db.prepare('UPDATE prospects SET role_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND role_id IS NULL');
  for (const prospect of prospects) {
    const slug = inferRoleSlug(prospect.exact_job_title);
    const roleId = slug ? ids.get(slug) : null;
    if (roleId) updated += update.run(roleId, prospect.id).changes;
  }
  return updated;
}
