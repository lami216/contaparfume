import { requireValidLicense } from "../../../../lib/license.ts";
import { CAPABILITIES, createSession, hashPassword, normalizeUsername, requireCapability, SESSION_COOKIE, sessionCookieOptions, validSameOrigin } from "../../../../lib/auth.ts";
import { expandPermissionDependencies } from "../../../../lib/permission-dependencies.ts";
import { getDatabase } from "../../../../lib/sqlite.ts";

const permissions=(value:unknown)=>{const valid=Array.isArray(value)?[...new Set(value.filter(item=>typeof item==="string"&&CAPABILITIES.includes(item as typeof CAPABILITIES[number])))]:[];return expandPermissionDependencies(valid).filter(item=>CAPABILITIES.includes(item as typeof CAPABILITIES[number]))};
const safe=(user:Record<string,unknown>)=>({id:String(user.id),username:String(user.username),name:String(user.name??user.username),isActive:user.isActive===true,permissions:user.owner===true?[...CAPABILITIES]:permissions(user.permissions),owner:user.owner===true,createdAt:user.createdAt,updatedAt:user.updatedAt});

export async function GET(request:Request){const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;const denied=await requireCapability(request,"settings.users.manage");if(denied)return denied;const users=await (await getDatabase()).collection("users").find().sort({owner:-1,createdAt:1}).toArray();return Response.json({users:users.map(safe)},{headers:{"cache-control":"no-store"}})}
export async function POST(request:Request){
 const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;
 const denied=await requireCapability(request,"settings.users.manage");if(denied)return denied;
 if(!validSameOrigin(request))return Response.json({error:"طلب غير صالح"},{status:403});
 try{
  const body=await request.json(),username=String(body.username??"").trim(),usernameNormalized=normalizeUsername(username),password=String(body.password??"");
  if(!usernameNormalized)return Response.json({error:"اسم المستخدم مطلوب"},{status:400});
  const db=await getDatabase();
  if(await db.collection("users").findOne({usernameNormalized}))return Response.json({error:"اسم المستخدم مستخدم بالفعل"},{status:409});
  const firstUser=await db.collection("users").countDocuments()===0;
  let userPermissions=permissions(body.permissions);
  if(firstUser&&!userPermissions.includes("settings.users.manage"))userPermissions=permissions([...userPermissions,"settings.users.manage"]);
  if(!userPermissions.length)return Response.json({error:"يجب اختيار صلاحية واحدة على الأقل"},{status:400});
  const now=new Date(),user={id:crypto.randomUUID(),username,usernameNormalized,name:String(body.name??username).trim()||username,passwordHash:hashPassword(password),isActive:true,permissions:userPermissions,owner:false,createdAt:now,updatedAt:now};
  await db.collection("users").insertOne(user);
  const headers=firstUser?{"Set-Cookie":`${SESSION_COOKIE}=${createSession({principalType:"user",userId:user.id})}; ${sessionCookieOptions}`}:undefined;
  return Response.json({user:safe(user)},{status:201,headers});
 }catch(error){return Response.json({error:error instanceof Error?error.message:"بيانات المستخدم غير صالحة"},{status:400})}
}
