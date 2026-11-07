import { requireValidLicense } from "../../../../lib/license.ts";
import { createNativeBackup, stringifyBackup } from "../../../../lib/backup.ts";
import { requireCapability } from "../../../../lib/auth.ts";
import { getDatabase } from "../../../../lib/sqlite.ts";
import { ensurePerfumeSystemCategories } from "../../../../lib/perfume-system-categories.ts";

export const runtime = "nodejs";
export async function GET(request: Request) {const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied;
  const denied = await requireCapability(request, "settings.backup.manage"); if (denied) return denied;
  const db = await getDatabase();
  await db.transaction(session => ensurePerfumeSystemCategories(db, session));
  const backup = await createNativeBackup(db);
  const filename = `conta-backup-${backup.createdAt.slice(0, 10)}.conta.json`;
  return new Response(stringifyBackup(backup), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="${filename}"`, "cache-control": "no-store" } });
}
