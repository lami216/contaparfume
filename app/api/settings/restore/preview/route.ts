import { requireValidLicense } from "../../../../../lib/license.ts";
import { parseAndValidateBackup } from "../../../../../lib/backup.ts";
import { requireCapability, validSameOrigin } from "../../../../../lib/auth.ts";
export const runtime = "nodejs";
export async function POST(request: Request) {const licenseDenied=await requireValidLicense();if(licenseDenied)return licenseDenied; const denied = await requireCapability(request, "settings.backup.manage"); if (denied) return denied; if (!validSameOrigin(request)) return Response.json({ error: "طلب غير صالح" }, { status: 403 }); try { const backup = parseAndValidateBackup(await request.text()); return Response.json({ format: backup.format, schemaVersion: backup.schemaVersion, createdAt: backup.createdAt, counts: backup.counts }); } catch (e) { return Response.json({ error: e instanceof Error ? e.message : "نسخة غير صالحة" }, { status: 400 }); } }
