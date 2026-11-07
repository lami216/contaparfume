import { timingSafeEqual } from "node:crypto";
import { createNativeBackup, stringifyBackup } from "../../../../lib/backup.ts";
import { getDatabase } from "../../../../lib/sqlite.ts";
import { ensurePerfumeSystemCategories } from "../../../../lib/perfume-system-categories.ts";
export const runtime="nodejs";
export async function GET(request:Request){
  if(process.env.ALKARNA_DESKTOP!=="1")return new Response(null,{status:404});
  const expected=process.env.ALKARNA_DESKTOP_TOKEN??"",provided=request.headers.get("x-alkarna-desktop-token")??"";
  const a=Buffer.from(expected),b=Buffer.from(provided);
  if(!expected||a.length!==b.length||!timingSafeEqual(a,b))return Response.json({error:"غير مصرح"},{status:403});
  const db=await getDatabase();
  await db.transaction(session=>ensurePerfumeSystemCategories(db,session));
  return new Response(stringifyBackup(await createNativeBackup(db)),{headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
}
