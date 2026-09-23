import { requireValidLicense } from "../../../lib/license.ts";
import { requireCapability } from "../../../lib/auth.ts";
import { getDatabase } from "../../../lib/sqlite.ts";
import { deriveOpeningStockState } from "../../../lib/opening-stock.ts";

export async function GET(request: Request) {
  const licenseDenied = await requireValidLicense();
  if (licenseDenied) return licenseDenied;
  const denied = await requireCapability(request, "products.view");
  if (denied) return denied;
  const productId = new URL(request.url).searchParams.get("productId")?.trim() ?? "";
  if (!productId) return Response.json({ error: "معرف المنتج مطلوب" }, { status: 400 });
  const db = await getDatabase();
  const product = await db.collection("products").findOne({ id: productId });
  if (!product) return Response.json({ error: "المنتج غير موجود" }, { status: 404 });
  const state = await deriveOpeningStockState(db, undefined, product);
  const warehouse = state.warehouseId ? await db.collection("warehouses").findOne({ _id: state.warehouseId }) : null;
  return Response.json({ ...state, warehouseName: warehouse?.name ?? null });
}
