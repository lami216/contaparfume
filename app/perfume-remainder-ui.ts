import type { DocumentRecord, Product } from "./domain";
import type { PerfumeLot } from "./perfume-logic";
import { roundMl } from "./perfume-volume";

export function isRemainderSale(document: DocumentRecord | undefined | null) {
  return document?.kind === "decant-sale" && document.perfumeSaleMode === "remainder";
}

export function remainderSaleInput(document: DocumentRecord) {
  return { decantProductId: document.decantProductId ?? document.lines[0]?.productId ?? "",
    lotId: document.perfumeLotId ?? "", warehouseId: document.warehouseId ?? "",
    actualQuantity: document.remainderQuantityMl ?? document.lines[0]?.liquidQuantityMl ?? "",
    salePrice: document.total, paymentMethod: document.paymentMethod ?? "",
    partyId: document.partyId ?? "", note: document.note ?? "" };
}

/** Editing restores only this invoice's quantity, preserving later live sales. */
export function remainderSaleAvailable(productId: string, lot: PerfumeLot, warehouseId: string, editing?: DocumentRecord) {
  const restore = isRemainderSale(editing) && editing!.status === "posted"
    && editing!.decantProductId === productId && editing!.perfumeLotId === lot.id
    && editing!.warehouseId === warehouseId ? Number(editing!.remainderQuantityMl ?? 0) : 0;
  return roundMl(Number(lot.stocks[warehouseId] ?? 0) + restore);
}

export function remainderSaleBatches<T extends { product: Product; lot: PerfumeLot }>(batches: T[], warehouseId: string, editing?: DocumentRecord) {
  return batches.filter(({ product, lot }) => (!product.isArchived || editing?.decantProductId === product.id)
    && product.perfumeStockUnit === "ml" && lot.quantityUnit === "ml"
    && !lot.recombinedAt && !lot.partialProductId && !lot.settledAt
    && remainderSaleAvailable(product.id, lot, warehouseId, editing) > 0);
}
