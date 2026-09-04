import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getDatabase } from "./sqlite.ts";
export { hashPassword, verifyPasswordHash } from "./password.ts";

export const SESSION_COOKIE = "conta_session";
const MAX_AGE = 60 * 60 * 12;
export const CAPABILITIES = [
  "pos.view","pos.create","pos.edit","pos.delete","purchases.view","purchases.create","purchases.edit","purchases.delete","records.view",
  "products.view","products.create","products.edit","products.delete","customers.view","customers.create","customers.edit","customers.collect","suppliers.view","suppliers.create","suppliers.edit","suppliers.pay",
  "warehouses.view","warehouses.create","warehouses.edit","warehouses.delete","warehouses.inventory.view","warehouses.transfer","warehouses.adjust","banks.view","banks.create","banks.edit","banks.delete","banks.movements.view","banks.transfer","banks.deposit_withdraw","banks.balance_correct",
  "expenses.view","expenses.create","expenses.edit","expenses.delete","reports.view","settings.view","settings.branding.manage","settings.backup.manage","settings.legacy.import","settings.users.manage",
] as const;
export type Capability = typeof CAPABILITIES[number];
export type Principal = { principalType:"local"; name:string; permissions:Capability[] } | { principalType:"owner"; name:string; permissions:Capability[] } | { principalType:"user"; userId:string; name:string; username:string; permissions:Capability[] };
type SessionPayload = { exp:number; principalType:"owner"|"user"; userId?:string };
let cachedSecret:string|undefined;
function secret(){if(cachedSecret)return cachedSecret;const file=join(process.env.ALKARNA_USER_DATA??join(process.cwd(),".dev-data"),"config","session-secret");try{cachedSecret=readFileSync(file,"utf8").trim()}catch{mkdirSync(dirname(file),{recursive:true});cachedSecret=randomBytes(48).toString("base64url");writeFileSync(file,cachedSecret,{mode:0o600})}return cachedSecret}
function digest(value:string){return createHmac("sha256",secret()).update(value).digest("base64url")}
export function createSession(principal:{principalType:"owner"|"user";userId?:string}={principalType:"owner"},now=Date.now()){const payload=Buffer.from(JSON.stringify({...principal,exp:Math.floor(now/1000)+MAX_AGE})).toString("base64url");return `${payload}.${digest(payload)}`}
function parseSession(token?:string|null,now=Date.now()):SessionPayload|null{if(!token)return null;const [payload,signature,extra]=token.split(".");if(!payload||!signature||extra)return null;const expected=digest(payload);if(signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))return null;try{const value=JSON.parse(Buffer.from(payload,"base64url").toString()) as Partial<SessionPayload>;if(typeof value.exp!=="number"||value.exp<=Math.floor(now/1000))return null;/* Old owner cookies remain valid. */return {exp:value.exp,principalType:value.principalType==="user"?"user":"owner",userId:value.userId}}catch{return null}}
export function verifySession(token?:string|null,now=Date.now()){return parseSession(token,now)!==null}
function tokenFromRequest(request:Request){const cookie=request.headers.get("cookie")??"";return cookie.split(";").map(v=>v.trim()).find(v=>v.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length+1)}
export function sessionFromRequest(request:Request){return parseSession(tokenFromRequest(request))}
export async function getPrincipalFromRequest(request:Request):Promise<Principal|null>{const users=(await getDatabase()).collection("users"),session=sessionFromRequest(request);if(!session){if(await users.countDocuments()===0)return {principalType:"local",name:"دخول مباشر",permissions:[...CAPABILITIES]};return null}if(session.principalType==="owner"){const owner=await users.findOne({id:"owner",isActive:true});return owner?{principalType:"owner",name:String(owner.name??owner.username),permissions:[...CAPABILITIES]}:null}if(!session.userId)return null;const user=await users.findOne({id:session.userId,isActive:true});if(!user)return null;return {principalType:"user",userId:String(user.id),name:String(user.name),username:String(user.username),permissions:(Array.isArray(user.permissions)?user.permissions:[]).filter((p):p is Capability=>CAPABILITIES.includes(p as Capability))}}
export function hasCapability(principal:Principal|null,capability:Capability){return principal?.principalType==="local"||principal?.principalType==="owner"||principal?.permissions.includes(capability)===true}
export async function requireCapability(request:Request,capability:Capability){const principal=await getPrincipalFromRequest(request);if(!principal)return Response.json({error:"غير مصرح أو انتهت صلاحية المستخدم"},{status:401});if(!hasCapability(principal,capability))return Response.json({error:"ليس لديك صلاحية تنفيذ هذه العملية"},{status:403});return null}
export function normalizeUsername(value:string){return value.trim().toLocaleLowerCase("en-US")}
export function validSameOrigin(request:Request){const origin=request.headers.get("origin"),host=request.headers.get("x-forwarded-host")??request.headers.get("host");if(!origin||!host)return false;try{const parsed=new URL(origin);if(process.env.ALKARNA_DESKTOP==="1")return parsed.protocol==="http:"&&parsed.hostname==="127.0.0.1"&&parsed.host===host;const proto=request.headers.get("x-forwarded-proto")??(process.env.NODE_ENV==="production"?"https":"http");return parsed.origin===`${proto}://${host}`}catch{return false}}
// Keep the signed token expiry as a server-side safety bound, but make the
// browser cookie session-only so a closed desktop app cannot stay signed in.
export const sessionCookieOptions="Path=/; HttpOnly; SameSite=Strict";
