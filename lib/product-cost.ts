import type { DbDocument, SqliteDatabase, SqliteSession } from "./sqlite.ts";

const positiveCost = (value: unknown) => {
  const cost = Number(value);
  return Number.isFinite(cost) && cost > 0 ? cost : null;
};

/** Source documents, rather than the editable card price or a stale cache, own cost. */
export function resolveProductCost(product: DbDocument, documents: DbDocument[]) {
  const relevant = documents.filter(document => document.status === "posted" &&
    Array.isArray(document.lines) && document.lines.some((line: DbDocument) => line.productId === product.id));
  // Stable sorting retains posting order for equal timestamps; newest is last.
  const purchases = relevant.filter(document => ["purchase","decant-purchase"].includes(String(document.kind))).sort((a, b) =>
    String(a.occurredAt).localeCompare(String(b.occurredAt)) || Number(a.sequence ?? 0) - Number(b.sequence ?? 0));
  const latest = purchases.at(-1);
  const purchaseCost = positiveCost(latest?.lines.find((line: DbDocument) => line.productId === product.id)?.unitPrice);
  if (purchaseCost !== null) return { cost: purchaseCost, source: "purchase", at: latest!.occurredAt };

  const openingDocuments = relevant.filter(document => document.openingCorrection === true || String(document.number ?? "").startsWith("OPEN-"));
  const opening = openingDocuments.at(-1);
  const openingCost = Object.hasOwn(product, "openingCost")
    ? positiveCost(product.openingCost)
    : positiveCost(opening?.openingCostAfter ?? opening?.lines.find((line: DbDocument) => line.productId === product.id)?.unitPrice);
  if (openingCost !== null) return { cost: openingCost, source: "opening", at: null };
  const legacyCost = positiveCost(product.legacyOpeningCost);
  if (legacyCost !== null) return { cost: legacyCost, source: "legacy-opening", at: null };
  return { cost: null, source: null, at: null };
}

export async function currentProductCost(db: SqliteDatabase, session: SqliteSession, product: DbDocument) {
  const documents = await db.collection("documents").find({ status: "posted", "lines.productId": product.id }, { session }).toArray();
  const result = resolveProductCost(product, documents);
  const values = { lastPurchaseCost: result.cost, lastPurchaseCostSource: result.source, lastPurchaseAt: result.at };
  await db.collection("products").updateOne({ id: product.id }, { $set: values }, { session });
  Object.assign(product, values);
  return result.cost;
}

export async function productsWithCurrentCosts(db: SqliteDatabase, products: DbDocument[], documents?: DbDocument[]): Promise<DbDocument[]> {
  const source = documents ?? await db.collection("documents").find({ status: "posted", kind: { $in: ["purchase", "decant-purchase", "adjustment"] } }).toArray();
  const byProduct = new Map<string, DbDocument[]>();
  for (const document of source) for (const productId of new Set<string>((document.lines ?? []).map((line: DbDocument) => String(line.productId)))) {
    const rows = byProduct.get(productId) ?? [];
    rows.push(document);
    byProduct.set(productId, rows);
  }
  return products.map(product => {
    const result = resolveProductCost(product, byProduct.get(String(product.id)) ?? []);
    return { ...product, lastPurchaseCost: result.cost, lastPurchaseCostSource: result.source, lastPurchaseAt: result.at };
  });
}
