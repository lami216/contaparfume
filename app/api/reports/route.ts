import { requireValidLicense } from "../../../lib/license.ts";
import { requireCapability } from "../../../lib/auth";
import { getDatabase } from "../../../lib/sqlite";
import { buildReport, parseReportFilters } from "../../../lib/reports";
import { ensurePerfumeSystemCategories } from "../../../lib/perfume-system-categories.ts";
export async function GET(request: Request) {const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied; const denied=await requireCapability(request,"reports.view");if(denied)return denied;try { const filters=parseReportFilters(new URL(request.url)),db=await getDatabase(); await db.transaction(session=>ensurePerfumeSystemCategories(db,session)); return Response.json(await buildReport(db,filters)); } catch(error) { return Response.json({ error: error instanceof Error?error.message:"تعذر إنشاء التقرير" },{status:400}); } }
