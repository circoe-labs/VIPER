import { v4 as uuid } from 'uuid'; import { db } from './db.js'; import type { Actor } from './auth.js';
export function audit(actor:Actor|{type:string;id:string;display:string}, entityType:string,entityId:string,action:string,before:unknown,after:unknown,source='manual'){
 const changed=before&&after?Object.keys(after as Record<string,unknown>).filter(k=>JSON.stringify((before as any)[k])!==JSON.stringify((after as any)[k])):[];
 db.prepare('INSERT INTO audit_log(id,actor_type,actor_id,actor_display,entity_type,entity_id,action,changed_fields,before_payload,after_payload,source_context) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(uuid(),actor.type,actor.id,actor.display,entityType,entityId,action,JSON.stringify(changed),before?JSON.stringify(before):null,after?JSON.stringify(after):null,source);
}
