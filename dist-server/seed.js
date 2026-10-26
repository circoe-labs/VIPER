import { randomUUID } from 'node:crypto';
import { db, migrate } from './db.js';
import { ensureDefaultRoles } from './roleTaxonomy.js';
migrate();
ensureDefaultRoles(db);
for (const label of ['Transport', 'Logistique', 'Industrie'])
    db.prepare('INSERT OR IGNORE INTO activity_categories(id,label) VALUES(?,?)').run(randomUUID(), label);
for (const label of ['Prospect', 'Client', 'Partenaire'])
    db.prepare('INSERT OR IGNORE INTO commercial_segments(id,label) VALUES(?,?)').run(randomUUID(), label);
console.log('Synthetic reference taxonomies seeded; no private workbook data used.');
