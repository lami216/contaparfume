export type StockMovementDocumentHint = {
  id?: unknown;
  number?: unknown;
  kind?: unknown;
  title?: unknown;
  openingCorrection?: unknown;
  openingStockBefore?: unknown;
  openingStockAfter?: unknown;
  productArchiveStockClearance?: unknown;
  perfumeStockOperationType?: unknown;
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

export function isProductArchiveStockClearanceDocument(document: StockMovementDocumentHint | null | undefined) {
  return Boolean(document && asText(document.kind) === "adjustment" && document.productArchiveStockClearance === true);
}

export function classifyStockMovementType(type: unknown, document?: StockMovementDocumentHint | null) {
  const current = asText(type);
  if (isOpeningStockCorrectionDocument(document)) return current.startsWith("opening-correction-") ? current : "opening-correction";
  if (isOpeningStockInitialDocument(document)) return "opening";
  const perfumeOperation = asText(document?.perfumeStockOperationType);
  if (perfumeOperation) {
    const base = perfumeOperation === "opening" ? "decant-opening"
      : perfumeOperation === "consumption" ? "decant-consumption"
      : perfumeOperation === "yield-correction" ? "decant-yield-correction"
      : "";
    if (base) return current.startsWith("perfume-stock-operation-void") ? `${base}-void` : base;
  }
  if (current.startsWith("decant-sale")) return "sale";
  if (current.startsWith("decant-purchase")) return "purchase";
  return current || "unknown";
}

/** Preserve the audit event while describing whether an invoice edit returned
 * stock or consumed more stock. The raw movement type remains the accounting
 * authority; this key is presentation-only. */
export function stockMovementPresentationType(type: unknown, quantityDelta: unknown = 0) {
  const current = asText(type), delta = Number(quantityDelta);
  if (current === "perfume-opening-in") return "decant-opening";
  if (current.startsWith("perfume-consumption-")) return "decant-consumption";
  if (current === "perfume-yield-correction") return "decant-yield-correction";
  if (current.startsWith("perfume-stock-operation-void")) return "decant-reconciliation-void";
  if (current === "sale-edit") {
    if (Number.isFinite(delta) && delta > 0) return "sale-edit-return";
    if (Number.isFinite(delta) && delta < 0) return "sale-edit-extra";
  }
  if (current === "purchase-edit") {
    if (Number.isFinite(delta) && delta > 0) return "purchase-edit-extra";
    if (Number.isFinite(delta) && delta < 0) return "purchase-edit-return";
  }
  return current || "unknown";
}


export type PresentableStockMovement = {
  id?: unknown;
  documentId?: unknown;
  documentRevision?: unknown;
  productId?: unknown;
  warehouseId?: unknown;
  type?: unknown;
  quantityDelta?: unknown;
  balanceBefore?: unknown;
  balanceAfter?: unknown;
  occurredAt?: unknown;
  [key: string]: unknown;
};

/**
 * Builds a readable audit view for edits produced by older builds that recorded
 * a full "reverse old state + replay new state" pair. Raw database rows are
 * untouched; only presentation is collapsed to the net stock effect.
 */
export function collapseLegacyStockEditMovements<T extends PresentableStockMovement>(rows: T[]): T[] {
  const editKinds = new Set(["transfer", "adjustment"]);
  const keyOf = (row: T) => {
    const type=asText(row.type),kind=type.startsWith("transfer-edit")?"transfer":type.startsWith("adjustment-edit")?"adjustment":"";
    if(!editKinds.has(kind))return "";
    return [kind,String(row.documentId??""),String(row.documentRevision??""),String(row.productId??""),String(row.warehouseId??"")].join("\u0000");
  };
  const groups=new Map<string,T[]>();
  for(const row of rows){const key=keyOf(row);if(key)(groups.get(key)??(groups.set(key,[]),groups.get(key)!)).push(row)}
  const emitted=new Set<string>(),result:T[]=[];
  for(const row of rows){
    const key=keyOf(row);
    if(!key){result.push(row);continue}
    if(emitted.has(key))continue;
    emitted.add(key);
    const group=groups.get(key)??[row],kind=asText(row.type).startsWith("transfer")?"transfer":"adjustment";
    const reversals=group.filter(item=>asText(item.type)===`${kind}-edit-reversal`),edits=group.filter(item=>asText(item.type)===`${kind}-edit`);
    if(!reversals.length||!edits.length){result.push(...group);continue}
    const net=group.reduce((sum,item)=>sum+Number(item.quantityDelta??0),0);
    if(Math.abs(net)<1e-9)continue;
    const edit=edits[0],reversal=reversals[0];
    result.push({...edit,type:`${kind}-edit`,quantityDelta:net,balanceBefore:Number(reversal.balanceBefore??0),balanceAfter:Number(edit.balanceAfter??(Number(reversal.balanceBefore??0)+net))} as T);
  }
  return result;
}

/** Sale/purchase edit and void movements belong to their parent commercial filter. */
export function stockMovementMatchesFilter(type: unknown, filter: string | null | undefined) {
  if (!filter) return true;
  const current = asText(type);
  if (filter === "sale") return current === "sale" || current.startsWith("sale-") || current.startsWith("decant-sale");
  if (filter === "purchase") return current === "purchase" || current.startsWith("purchase-") || current.startsWith("decant-purchase");
  if (filter === "transfer") return current === "transfer" || current.startsWith("transfer-");
  if (filter === "adjustment") return current === "adjustment" || current.startsWith("adjustment-") || current === "opening" || current === "opening-void" || current.startsWith("opening-correction") || current.startsWith("decant-opening") || current.startsWith("decant-consumption") || current.startsWith("decant-yield-correction");
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
