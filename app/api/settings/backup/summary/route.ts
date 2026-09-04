import { requireValidLicense } from "../../../../../lib/license.ts";
import { BACKUP_COLLECTIONS } from "../../../../../lib/backup.ts";
import { requireCapability } from "../../../../../lib/auth.ts";
import { getDatabase } from "../../../../../lib/sqlite.ts";
export async function GET(request: Request) {const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied; const denied = await requireCapability(request, "settings.backup.manage"); if (denied) return denied; const db = await getDatabase(); const values = await Promise.all(BACKUP_COLLECTIONS.map(async name => [name, await db.collection(name).countDocuments()])); return Response.json({ counts: Object.fromEntries(values) }, { headers: { "cache-control": "no-store" } }); }
