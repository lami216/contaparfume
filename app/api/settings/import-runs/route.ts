import { requireValidLicense } from "../../../../lib/license.ts";
import { requireCapability } from "../../../../lib/auth.ts";
import { getDatabase } from "../../../../lib/sqlite.ts";
import { listImportRuns } from "../../../../legacy/import-run.ts";
export async function GET(request:Request){const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;const denied=await requireCapability(request,"settings.legacy.import");if(denied)return denied;return Response.json({runs:await listImportRuns(await getDatabase())},{headers:{"cache-control":"no-store"}})}
