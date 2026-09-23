import { requireValidLicense } from "../../../../../lib/license.ts";
import { CAPABILITIES, hashPassword, normalizeUsername, requireCapability, sessionFromRequest, validSameOrigin } from "../../../../../lib/auth.ts";
import { expandPermissionDependencies } from "../../../../../lib/permission-dependencies.ts";
import { getDatabase } from "../../../../../lib/sqlite.ts";

const permissions=(value:unknown)=>{const valid=Array.isArray(value)?[...new Set(value.filter(item=>typeof item==="string"&&CAPABILITIES.includes(item as typeof CAPABILITIES[number])))]:[];return expandPermissionDependencies(valid).filter(item=>CAPABILITIES.includes(item as typeof CAPABILITIES[number]))};
const safe=(user:Record<string,unknown>)=>({id:String(user.id),username:String(user.username),name:String(user.name??user.username),isActive:user.isActive===true,permissions:user.owner===true?[...CAPABILITIES]:permissions(user.permissions),owner:user.owner===true,createdAt:user.createdAt,updatedAt:user.updatedAt});
const activeManager=(user:Record<string,unknown>)=>user.isActive===true&&(user.owner===true||permissions(user.permissions).includes("settings.users.manage"));
const currentUser=(request:Request,id:string)=>{const session=sessionFromRequest(request);return (session?.principalType==="owner"&&id==="owner")||(session?.principalType==="user"&&session.userId===id)};
async function targetId(context:{params:Promise<{id:string}>}){return decodeURIComponent((await context.params).id)}

export async function PUT(request:Request,context:{params:Promise<{id:string}>}){
 const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;
 const denied=await requireCapability(request,"settings.users.manage");if(denied)return denied;
 if(!validSameOrigin(request))return Response.json({error:"طلب غير صالح"},{status:403});
 try{
  const db=await getDatabase(),id=await targetId(context),user=await db.collection("users").findOne({id});
  if(!user)return Response.json({error:"المستخدم غير موجود"},{status:404});
  const body=await request.json(),isOwner=user.owner===true,isActive=body.isActive!==false,userPermissions=isOwner?(Array.isArray(user.permissions)?user.permissions:[]):permissions(body.permissions);
  if(!isOwner&&!userPermissions.length)return Response.json({error:"يجب اختيار صلاحية واحدة على الأقل"},{status:400});
  const username=isOwner?String(user.username):String(body.username??user.username).trim(),usernameNormalized=normalizeUsername(username);
  if(!usernameNormalized)return Response.json({error:"اسم المستخدم مطلوب"},{status:400});
  const duplicate=await db.collection("users").findOne({usernameNormalized});
  if(duplicate&&duplicate.id!==id)return Response.json({error:"اسم المستخدم مستخدم بالفعل"},{status:409});
  const update:Record<string,unknown>={username,usernameNormalized,name:isOwner?user.name:String(body.name??username).trim()||username,isActive,updatedAt:new Date(),permissions:userPermissions};
  if(String(body.password??""))update.passwordHash=hashPassword(String(body.password));
  const users=await db.collection("users").find().toArray(),projected=users.map(candidate=>String(candidate.id)===id?{...candidate,...update}:candidate);
  if(projected.length&&!projected.some(activeManager))return Response.json({error:"يجب أن يبقى مستخدم مفعل واحد على الأقل لديه صلاحية إدارة المستخدمين."},{status:409});
  await db.collection("users").updateOne({id},{$set:update});
  const self=currentUser(request,id),logoutRequired=self&&(!isActive||(!isOwner&&!userPermissions.includes("settings.users.manage")));
  return Response.json({user:safe({...user,...update}),logoutRequired});
 }catch(error){return Response.json({error:error instanceof Error?error.message:"بيانات المستخدم غير صالحة"},{status:400})}
}
export const PATCH=PUT;

export async function DELETE(request:Request,context:{params:Promise<{id:string}>}){
 const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;
 const denied=await requireCapability(request,"settings.users.manage");if(denied)return denied;
 if(!validSameOrigin(request))return Response.json({error:"طلب غير صالح"},{status:403});
 const db=await getDatabase(),id=await targetId(context),user=await db.collection("users").findOne({id});
 if(!user)return Response.json({error:"المستخدم غير موجود"},{status:404});
 const users=await db.collection("users").find().toArray(),remaining=users.filter(candidate=>String(candidate.id)!==id);
 if(remaining.length&&!remaining.some(activeManager))return Response.json({error:"لا يمكن حذف آخر مستخدم مفعل يملك صلاحية إدارة المستخدمين."},{status:409});
 const logoutRequired=currentUser(request,id);
 await db.collection("users").deleteOne({id});
 return Response.json({deleted:true,id,logoutRequired});
}
