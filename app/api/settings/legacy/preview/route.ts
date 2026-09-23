import { requireValidLicense } from "../../../../../lib/license.ts";
import { requireCapability, validSameOrigin } from "../../../../../lib/auth.ts";
import { inspectLegacyDatabase } from "../../../../../legacy/dataacc-sqlite.ts";
export const runtime="nodejs";
export async function POST(request:Request){const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;const denied=await requireCapability(request,"settings.legacy.import");if(denied)return denied;if(!validSameOrigin(request))return Response.json({error:"طلب غير صالح"},{status:403});try{const bytes=new Uint8Array(await request.arrayBuffer());return Response.json(await inspectLegacyDatabase(bytes));}catch(e){console.error("Legacy SQLite preview failed",e);return Response.json({error:"تعذرت قراءة ملف SQLite. تأكد من صحة الملف ثم حاول مرة أخرى."},{status:400});}}
