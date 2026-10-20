/** Shared identification for authorization, history, source navigation and management. */
export type ManagementKind = "split" | "recombine" | "opening" | "consumption" | "yield-correction" | "bottle" | "bottle-stock";
type Hint = {kind?: unknown; perfumeManagementType?: unknown; perfumeConversionType?: unknown; perfumeStockOperationType?: unknown};
export function managementKind(document: Hint): ManagementKind | null {
  if (document.kind !== "adjustment") return null;
  const value = String(document.perfumeManagementType ?? document.perfumeStockOperationType ?? "");
  if (["split", "recombine", "opening", "consumption", "yield-correction", "bottle", "bottle-stock"].includes(value)) return value as ManagementKind;
  if (document.perfumeConversionType === "perfume-split") return "split";
  if (document.perfumeConversionType === "perfume-recombine") return "recombine";
  return null;
}
export const managementLabel = {
  split: "pm.split", recombine: "pm.recombine", opening: "pm.opening", consumption: "pm.consumption",
  "yield-correction": "pm.correction", bottle: "pm.bottle", "bottle-stock": "pm.bottleStock",
} as const;
export const managementPostType: Record<ManagementKind, string> = {
  split: "perfume-split.post", recombine: "perfume-recombine.post", opening: "perfume-opening.post",
  consumption: "perfume-lot-consume.post", "yield-correction": "perfume-lot-correct.post",
  bottle: "perfume-bottle.create", "bottle-stock": "perfume-bottle-stock.post",
};

/** Existing posted operations remain editable even before input snapshots existed. */
export function managementInputFor(document: import("./domain").DocumentRecord, products: import("./domain").Product[]): Record<string, unknown> {
  if (document.managementInput) return { ...document.managementInput };
  const lines = document.lines as unknown as Record<string, unknown>[];
  const input: Record<string, unknown> = { warehouseId: document.warehouseId, note: document.note ?? "" };
  const kind = managementKind(document);
  const incoming = lines.find(line => Number(line.quantity) > 0), outgoing = lines.find(line => Number(line.quantity) < 0);
  const productId = document.decantProductId ?? (kind === "split" ? incoming?.productId : outgoing?.productId);
  const decant = products.find(product => product.id === productId);
  const lot = decant?.perfumeLots?.find(lot => lot.id === document.perfumeLotId || lot.conversionDocumentId === document.id);
  if (kind === "split") Object.assign(input, { sourceProductId: outgoing?.productId, divisionsCount: incoming?.quantity, salePrice: document.decantProductAfter?.piecePrice ?? decant?.piecePrice ?? "" });
  if (kind === "opening") Object.assign(input, { sourceProductId: document.sourceProductId ?? lot?.sourceProductId, quantity: document.stockDelta, remainingValue: document.bookValueAfter, salePrice: document.decantProductAfter?.piecePrice ?? decant?.piecePrice ?? "" });
  if (kind === "recombine") {
    const partial = products.find(p => p.id === incoming?.productId);
    const batch = decant?.perfumeLots?.find(l => l.partialProductId === partial?.id);
    Object.assign(input, { decantProductId: decant?.id, lotId: batch?.id, salePrice: partial?.piecePrice ?? "" });
  }
  if (kind === "consumption" || kind === "yield-correction") Object.assign(input, { decantProductId: document.decantProductId, lotId: document.perfumeLotId, quantity: Math.abs(Number(document.stockDelta)), actualQuantity: document.perfumeLotAfter?.stocks?.[String(document.warehouseId)] ?? "", reason: document.title, reasonCode: document.perfumeStockReasonCode ?? "other", consumeBottle: Number(document.bottleQuantity ?? 0) > 0, bottleProductId: document.bottleProductId ?? "" });
  return input;
}
