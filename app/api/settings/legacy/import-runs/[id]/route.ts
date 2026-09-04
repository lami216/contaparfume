import { requireValidLicense } from "../../../../../../lib/license.ts";
import { requireCapability } from "../../../../../../lib/auth.ts";
import { getDatabase } from "../../../../../../lib/sqlite.ts";
import { getLegacyImportRun } from "../../../../../../legacy/import-run.ts";

export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;const denied=await requireCapability(request,"settings.legacy.import");if(denied)return denied;try{return Response.json(await getLegacyImportRun(await getDatabase(),(await params).id));}catch(error){const e=error as Error&{status?:number};return Response.json({error:e.message},{status:e.status??500});}}
