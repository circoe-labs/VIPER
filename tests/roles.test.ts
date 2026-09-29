import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { schema } from '../src/server/schema.js';
import { backfillUnassignedProspectRoles, ensureDefaultRoles, inferRoleSlug, roleLabelForSlug } from '../src/server/roleTaxonomy.js';

describe('role groups', () => {
  it.each([
    ['Gérant', 'gouvernance'],
    ['DG', 'gouvernance'],
    ['PDG', 'gouvernance'],
    ['Président', 'gouvernance'],
    ['Directeur général', 'gouvernance'],
    ['Directeur logistique', 'direction'],
    ['Directrice export et communication', 'direction'],
    ['Directeur régional opérationnel', 'direction'],
    ['adjoint au directeur ILS', 'direction-adjointe'],
    ['senior vice president', 'direction-adjointe'],
    ['Responsable logistique', 'management'],
    ['Sales Manager', 'management'],
    ['Chef de Projet', 'pilotage'],
    ['Chef des ventes', 'pilotage'],
    ['Chargée de mission innovation', 'charge-mission-affaires'],
    ['chargée d’affaires', 'charge-mission-affaires'],
    ['commercial', 'commercial-developpement'],
    ['service commercial', 'commercial-developpement'],
    ['Ingénieur Valorisation Biomasse', 'technique-ingenierie-it'],
    ['Digital Transformation Officer', 'technique-ingenierie-it'],
    ['RH', 'support-admin-rh-juridique'],
    ['assistante de direction', 'support-admin-rh-juridique'],
    ['Directrice juriste', 'direction'],
    ['Préfet', 'institutionnel-conseil-autre'],
    ['Journaliste', 'institutionnel-conseil-autre'],
    ['non confirmé', 'institutionnel-conseil-autre']
  ])('maps %s to %s', (title, slug) => {
    expect(inferRoleSlug(title)).toBe(slug);
  });

  it('creates exactly ten active default groups and retires old automatic groups', () => {
    const db = new Database(':memory:');
    db.exec(schema);
    db.prepare('INSERT INTO roles(id,label,slug) VALUES(?,?,?)').run('old-logistique', 'Logistique', 'logistique');
    db.prepare('INSERT INTO roles(id,label,slug) VALUES(?,?,?)').run('old-direction', 'Direction / Gérance', 'direction');

    ensureDefaultRoles(db);

    expect((db.prepare('SELECT count(*) n FROM roles WHERE active=1').get() as any).n).toBe(10);
    expect((db.prepare("SELECT label FROM roles WHERE slug='direction'").get() as any).label).toBe('Direction');
    expect((db.prepare("SELECT active FROM roles WHERE slug='logistique'").get() as any).active).toBe(0);
    expect(roleLabelForSlug('gouvernance')).toBe('Direction générale / Gouvernance');
    db.close();
  });

  it('reclassifies old automatic roles but preserves a custom manual role', () => {
    const db = new Database(':memory:');
    db.exec(schema);
    db.prepare('INSERT INTO companies(id,display_name) VALUES(?,?)').run('c1', 'Acme');

    db.prepare('INSERT INTO roles(id,label,slug) VALUES(?,?,?)').run('legacy-log', 'Logistique', 'logistique');
    db.prepare('INSERT INTO roles(id,label,slug) VALUES(?,?,?)').run('custom', 'Décideur clé', 'decideur-cle');

    db.prepare('INSERT INTO prospects(id,company_id,first_name,last_name,role_id,exact_job_title) VALUES(?,?,?,?,?,?)')
      .run('p1', 'c1', 'Luc', 'Martin', 'legacy-log', 'Directeur logistique');
    db.prepare('INSERT INTO prospects(id,company_id,first_name,last_name,role_id,exact_job_title) VALUES(?,?,?,?,?,?)')
      .run('p2', 'c1', 'Léa', 'Durand', 'custom', 'Gérante');
    db.prepare('INSERT INTO prospects(id,company_id,first_name,last_name,exact_job_title) VALUES(?,?,?,?,?)')
      .run('p3', 'c1', 'Marc', 'Petit', 'Responsable exploitation');

    const ids = ensureDefaultRoles(db);
    expect(backfillUnassignedProspectRoles(db)).toBe(2);
    expect((db.prepare('SELECT role_id FROM prospects WHERE id=?').get('p1') as any).role_id).toBe(ids.get('direction'));
    expect((db.prepare('SELECT role_id FROM prospects WHERE id=?').get('p2') as any).role_id).toBe('custom');
    expect((db.prepare('SELECT role_id FROM prospects WHERE id=?').get('p3') as any).role_id).toBe(ids.get('management'));
    db.close();
  });
});
