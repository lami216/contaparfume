export type StockMovementDocumentHint = {
  id?: unknown;
  number?: unknown;
  kind?: unknown;
  title?: unknown;
  openingCorrection?: unknown;
  openingStockBefore?: unknown;
  openingStockAfter?: unknown;
};

const asText = (value: unknown) => typeof value === "string" ? value.trim() : "";
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Preserve a real numeric zero while treating absent audit metadata as absent. */
export function optionalFiniteNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/**
 * Opening-stock edits existed before the current explicit opening-correction
 * movement type. Document provenance is therefore the durable authority for
 * classifying both current and historical rows.
 */
export function isOpeningStockCorrectionDocument(document: StockMovementDocumentHint | null | undefined) {
  if (!document || asText(document.kind) !== "adjustment") return false;
  const number = asText(document.number), title = asText(document.title);
  return document.openingCorrection === true
    || number.startsWith("OPEN-COR")
    || title === "تصحيح رصيد البداية"
    || title === "إضافة رصيد افتتاحي"
    || (hasOwn(document, "openingStockBefore") && hasOwn(document, "openingStockAfter"));
}

export function isOpeningStockInitialDocument(document: StockMovementDocumentHint | null | undefined) {
  if (!document || asText(document.kind) !== "adjustment" || isOpeningStockCorrectionDocument(document)) return false;
  const number = asText(document.number), title = asText(document.title);
  return title === "رصيد بداية"
    || (/^OPEN(?:-|$)/.test(number) && !number.startsWith("OPEN-COR"))
    || (hasOwn(document, "openingStockAfter") && !hasOwn(document, "openingStockBefore"));
}

export function isOpeningStockDocument(document: StockMovementDocumentHint | null | undefined) {
  return isOpeningStockCorrectionDocument(document) || isOpeningStockInitialDocument(document);
}

export function classifyStockMovementType(type: unknown, document?: StockMovementDocumentHint | null) {
  if (isOpeningStockCorrectionDocument(document)) return "opening-correction";
  if (isOpeningStockInitialDocument(document)) return "opening";
  return asText(type) || "unknown";
}

/** Sale/purchase edit and void movements belong to their parent commercial filter. */
export function stockMovementMatchesFilter(type: unknown, filter: string | null | undefined) {
  if (!filter) return true;
  const current = asText(type);
  if (filter === "sale") return current === "sale" || current.startsWith("sale-");
  if (filter === "purchase") return current === "purchase" || current.startsWith("purchase-");
  return current === filter;
}


export function periodStockMovementQuantity(
  movements: Array<{productId:string;warehouseId:string;type:string;quantityDelta:number;occurredAt:string}>,
  productId:string,
  warehouseIds:string|string[],
  kind:"purchase"|"sale",
  from:string,
  to:string,
) {
  const ids=new Set(Array.isArray(warehouseIds)?warehouseIds:[warehouseIds]);
  return movements
    .filter(movement=>movement.productId===productId&&ids.has(movement.warehouseId)&&stockMovementMatchesFilter(movement.type,kind)&&(!from||movement.occurredAt.slice(0,10)>=from)&&(!to||movement.occurredAt.slice(0,10)<=to))
    .reduce((sum,movement)=>sum+(kind==="sale"?-Number(movement.quantityDelta):Number(movement.quantityDelta)),0);
}
