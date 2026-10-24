/** Shared identification for authorization, history, source navigation and management. */
export type ManagementKind = "split" | "recombine" | "opening" | "consumption" | "yield-correction" | "bottle" | "bottle-stock";
export type PerfumeManagementTab = "convert" | "stock" | "bottles";
export const managementTabForKind = (kind: ManagementKind): PerfumeManagementTab => ["split", "recombine"].includes(kind) ? "convert" : ["bottle", "bottle-stock"].includes(kind) ? "bottles" : "stock";
export function conversionSourceProducts<T extends {id:string;isArchived?:boolean;perfumeForm?:unknown;stocks?:Record<string,number>}>(products:T[], warehouseId:string, retainedId?:string) {
  return products.filter(p=>!p.isArchived&&!["decant","partial","bottle"].includes(String(p.perfumeForm??""))&&(p.id===retainedId||Number(p.stocks?.[warehouseId]??0)>=1));
}
export type BottleStockReason = "correction" | "breakage" | "damage";
export const bottleStockReasonLabels = {
  correction: "pm.bottleReason.correction", breakage: "pm.bottleReason.breakage", damage: "pm.bottleReason.damage",
} as const;
export const isBottleStockReason = (value: unknown): value is BottleStockReason => typeof value === "string" && Object.hasOwn(bottleStockReasonLabels, value);
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
/** Editing replaces the old effect: preview against its original lot, not the already-adjusted balance. */
export function managementPreviewLot(document:import("./domain").DocumentRecord|undefined,productId:string,lotId:string,warehouseId:string,current:import("./perfume-logic").PerfumeLot|undefined){
  return document?.decantProductId===productId&&document.perfumeLotId===lotId&&document.warehouseId===warehouseId&&document.perfumeLotBefore?document.perfumeLotBefore:current;
}

/** A restored quantity alone does not prove that a sale/count/transfer was voided. */
export function documentUsesPerfumeLot(document: { perfumeLotId?: unknown; perfumeStockOperationType?: unknown; lines?: unknown }, productId: string, lotId: string) {
  if (document.perfumeStockOperationType === "unit-conversion") return false;
  const lines = Array.isArray(document.lines) ? document.lines as Record<string, unknown>[] : [];
  return lines.some(line => {
    if (line.productId !== productId || Number(line.quantity) === 0) return false;
    const allocations = [line.perfumeAllocations, line.perfumeTransferAllocations].flatMap(value => Array.isArray(value) ? value as Record<string, unknown>[] : []);
    if (allocations.length) return allocations.some(allocation => allocation.lotId === lotId);
    const reference = line.perfumeLotId ?? document.perfumeLotId;
    return reference ? reference === lotId : true;
  });
}

/** Existing posted operations remain editable even before input snapshots existed. */
export function managementInputFor(document: import("./domain").DocumentRecord, products: import("./domain").Product[]): Record<string, unknown> {
  if (managementKind(document) === "bottle-stock") {
    const input = document.managementInput ?? {}, line = document.lines.find(line => line.productId === document.managementProductId) ?? document.lines[0];
    return { warehouseId: document.warehouseId, bottleProductId: document.managementProductId ?? line?.productId, actualQuantity: line?.balanceAfter ?? "", reason: document.title ?? "", ...input,
      // Old quantity corrections retain their original non-profit treatment.
      bottleStockReason: document.bottleStockReason ?? input.bottleStockReason ?? "correction" };
  }
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
