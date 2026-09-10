import { v4 as uuid } from 'uuid'; import { db, migrate } from './db.js';
migrate();
const slug=(s:string)=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
const insert=(table:string,label:string)=>db.prepare(`INSERT OR IGNORE INTO ${table}(id,label,slug) VALUES(?,?,?)`).run(uuid(),label,slug(label));
['Dirigeant','Responsable logistique','Responsable exploitation','DSI / IT','Commercial'].forEach(x=>insert('roles',x));
['Transport','Logistique','Industrie','Services'].forEach(x=>insert('activity_categories',x));
['Prospect','Client','Partenaire'].forEach(x=>insert('commercial_segments',x));
console.log('VIPER seed complete');
