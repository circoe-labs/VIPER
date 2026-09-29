import { scheduleStateBackup } from './stateCache';

/** Erreur HTTP : `message` lisible (comme avant) + statut, code métier et champs éventuels (`{ error, code, fields }`). */
export class ApiError extends Error {
  readonly status: number; readonly code?: string; readonly fields?: string[];
  constructor(message:string,status:number,code?:string,fields?:string[]){super(message);this.name='ApiError';this.status=status;if(code)this.code=code;if(fields)this.fields=fields;}
}

export async function api<T>(url:string,init:RequestInit={}):Promise<T>{
  const res=await fetch(url,{...init,headers:{'Content-Type':'application/json',...(init.headers||{})}});
  if(!res.ok){
    const body=await res.json().catch(()=>({}));
    throw new ApiError(body.error||`HTTP ${res.status}`,res.status,typeof body.code==='string'?body.code:undefined,Array.isArray(body.fields)?body.fields.map(String):undefined);
  }
  const method=String(init.method||'GET').toUpperCase();
  if(['POST','PUT','PATCH','DELETE'].includes(method) && !url.startsWith('/api/auth/') && url!=='/api/state/restore'){
    scheduleStateBackup();
  }
  return res.status===204?undefined as T:res.json();
}
