import { getDatabase } from "../../../lib/sqlite.ts";
import { requireValidLicense } from "../../../lib/license.ts";
import { getPrincipalFromRequest } from "../../../lib/auth.ts";
import { accountingHealth } from "../../../lib/sale-cost-recovery.ts";
import { serializeBusinessError } from "../../../lib/business-error.ts";

export async function GET(request: Request) {
  const licenseDenied = await requireValidLicense();
  if (licenseDenied) return licenseDenied;
  try {
    const principal = await getPrincipalFromRequest(request);
    if (!principal) return Response.json({ error: "غير مصرح أو انتهت صلاحية المستخدم" }, { status: 401 });
    if (!["owner", "local"].includes(principal.principalType)) return Response.json({ error: "مراجعة تكاليف المبيعات متاحة للمالك فقط" }, { status: 403 });
    const url = new URL(request.url);
    return Response.json(accountingHealth(getDatabase(), { page: Number(url.searchParams.get("page") ?? 1), pageSize: Number(url.searchParams.get("pageSize") ?? 25) }));
  } catch (error) {
    const response = serializeBusinessError(error);
    return Response.json(response.body, { status: response.status });
  }
}
