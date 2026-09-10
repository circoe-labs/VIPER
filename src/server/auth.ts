import crypto from 'node:crypto'; import type { Request,Response,NextFunction } from 'express';
const secret=process.env.VIPER_SESSION_SECRET || (process.env.NODE_ENV==='production'?'':'dev-only-viper-secret-change-me');
if(!secret) throw new Error('VIPER_SESSION_SECRET is required in production');
const user=process.env.VIPER_USER || 'admin';
const password=process.env.VIPER_PASSWORD || (process.env.NODE_ENV==='production'?'':'viper');
export type Actor={type:'human';id:string;display:string};
function sign(value:string){return crypto.createHmac('sha256',secret).update(value).digest('base64url');}
export function issueSession(res:Response){const payload=Buffer.from(JSON.stringify({u:user,exp:Date.now()+8*60*60*1000})).toString('base64url');res.cookie('viper_session',`${payload}.${sign(payload)}`,{httpOnly:true,sameSite:'strict',secure:process.env.NODE_ENV==='production',maxAge:8*60*60*1000});}
export function loginOk(u:string,p:string){if(!password) return false; const a=Buffer.from(u),b=Buffer.from(user); const c=Buffer.from(p),d=Buffer.from(password);return a.length===b.length&&c.length===d.length&&crypto.timingSafeEqual(a,b)&&crypto.timingSafeEqual(c,d);}
export function actorFrom(req:Request):Actor|null{const raw=req.cookies?.viper_session;if(!raw) return null;const [payload,sig]=raw.split('.');if(!payload||!sig||sign(payload)!==sig)return null;try{const data=JSON.parse(Buffer.from(payload,'base64url').toString());if(data.u!==user||data.exp<Date.now())return null;return {type:'human',id:user,display:user};}catch{return null;}}
export function requireAuth(req:Request,res:Response,next:NextFunction){const actor=actorFrom(req);if(!actor)return res.status(401).json({error:'AUTH_REQUIRED'});(req as Request & {actor:Actor}).actor=actor;next();}
