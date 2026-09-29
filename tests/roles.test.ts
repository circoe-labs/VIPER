import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../src/server/schema.js';
import { backfillUnassignedProspectRoles, ensureDefaultRoles, inferRoleSlug, roleLabelForSlug } from '../src/server/roleTaxonomy.js';

describe('role taxonomy', () => {
  it.each([
    ['Gérant', 'direction'],
    ['Directeur général', 'direction'],
    ['Directeur logistique', 'logistique'],
    ['Responsable logistique', 'logistique'],
    ['Responsable exploitation', 'exploitation'],
    ['Directeur des opérations', 'exploitation'],
    ['Chargé de développement', 'developpement-commercial'],
    ['Chargé de dev', 'developpement-commercial'],
    ['Business developer', 'developpement-commercial'],
    ['Directeur commercial', 'commercial'],
    ['Responsable achats', 'achats'],
    ['Directeur financier', 'finance-administration'],
    ['Responsable RH', 'ressources-humaines'],
    ['DSI', 'technique-it']
  ])('maps %s to %s', (title, slug) => {
    expect(inferRoleSlug(title)).toBe(slug);
  });

  it('leaves ambiguous titles unclassified', () => {
    expect(inferRoleSlug('Consultant')).toBeNull();
    expect(inferRoleSlug('Assistant de direction')).toBeNull();
  });

  it('creates the default role set and migrates old labels', () => {
    const db = new Database(':memory:');
    db.exec(schema);
    db.prepare('INSERT INTO roles(id,label,slug) VALUES(?,?,?)').run('old-direction', 'Direction', 'direction');
    ensureDefaultRoles(db);
    const direction = db.prepare("SELECT label FROM roles WHERE slug='direction'").get() as any;
    expect(direction.label).toBe('Direction / Gérance');
    expect(roleLabelForSlug('developpement-commercial')).toBe('Développement commercial');
    expect((db.prepare('SELECT count(*) n FROM roles').get() as any).n).toBeGreaterThanOrEqual(9);
    db.close();
  });

  it('backfills only prospects without a manually assigned role', () => {
    const db = new Database(':memory:');
    db.exec(schema);
    const ids = ensureDefaultRoles(db);
    db.prepare('INSERT INTO companies(id,display_name) VALUES(?,?)').run('c1', 'Acme');
    db.prepare('INSERT INTO prospects(id,company_id,first_name,last_name,exact_job_title) VALUES(?,?,?,?,?)')
      .run('p1', 'c1', 'Luc', 'Martin', 'Directeur logistique');
    db.prepare('INSERT INTO prospects(id,company_id,first_name,last_name,role_id,exact_job_title) VALUES(?,?,?,?,?,?)')
      .run('p2', 'c1', 'Léa', 'Durand', ids.get('commercial'), 'Gérante');

    expect(backfillUnassignedProspectRoles(db)).toBe(1);
    expect((db.prepare('SELECT role_id FROM prospects WHERE id=?').get('p1') as any).role_id).toBe(ids.get('logistique'));
    expect((db.prepare('SELECT role_id FROM prospects WHERE id=?').get('p2') as any).role_id).toBe(ids.get('commercial'));
    db.close();
  });
});
