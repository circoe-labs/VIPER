import { scheduleStateBackup } from './stateCache';

export async function api<T>(url:string,init:RequestInit={}):Promise<T>{
  const res=await fetch(url,{...init,headers:{'Content-Type':'application/json',...(init.headers||{})}});
  if(!res.ok) throw new Error((await res.json().catch(()=>({}))).error||`HTTP ${res.status}`);
  const method=String(init.method||'GET').toUpperCase();
  if(['POST','PUT','PATCH','DELETE'].includes(method) && !url.startsWith('/api/auth/') && url!=='/api/state/restore'){
    scheduleStateBackup();
  }
  return res.status===204?undefined as T:res.json();
}
