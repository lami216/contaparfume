import { requireValidLicense } from "../../../../lib/license.ts";
import { createNativeBackup, parseAndValidateBackup, restoreNativeBackup, stringifyBackup } from "../../../../lib/backup.ts";
import { requireCapability, SESSION_COOKIE, validSameOrigin } from "../../../../lib/auth.ts";
import { getDatabase } from "../../../../lib/sqlite.ts";
export const runtime = "nodejs";
export async function POST(request: Request) {
 const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;
 const denied=await requireCapability(request,"settings.backup.manage");if(denied)return denied;
 if(!validSameOrigin(request))return Response.json({error:"طلب غير صالح"},{status:403});
 try{
  const backup=parseAndValidateBackup(await request.text()),db=await getDatabase(),recovery=await createNativeBackup(db);
  await db.collection("restoreSnapshots").insertOne({id:crypto.randomUUID(),createdAt:new Date(),expiresAt:new Date(Date.now()+7*86400000),backup:stringifyBackup(recovery)});
  await db.transaction(session=>restoreNativeBackup(db,backup,session));
  const clear=`${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${process.env.NODE_ENV==="production"?"; Secure":""}`;
  return Response.json({restored:true,recoveryCreatedAt:recovery.createdAt,sessionReset:true},{headers:{"Set-Cookie":clear}});
 }catch(e){return Response.json({error:e instanceof Error?e.message:"تعذرت الاستعادة"},{status:400})}
}
