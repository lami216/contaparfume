export const SALE_DOCUMENT_KINDS = ["sale", "decant-sale"] as const;
export const PURCHASE_DOCUMENT_KINDS = ["purchase", "decant-purchase"] as const;

export type SaleDocumentKind = typeof SALE_DOCUMENT_KINDS[number];
export type PurchaseDocumentKind = typeof PURCHASE_DOCUMENT_KINDS[number];
export type CommercialDocumentFamily = "sale" | "purchase";

export function documentFamily(kind: unknown): CommercialDocumentFamily | null {
  const value = String(kind ?? "");
  if (SALE_DOCUMENT_KINDS.includes(value as SaleDocumentKind)) return "sale";
  if (PURCHASE_DOCUMENT_KINDS.includes(value as PurchaseDocumentKind)) return "purchase";
  return null;
}

export function isSaleDocumentKind(kind: unknown): kind is SaleDocumentKind {
  return documentFamily(kind) === "sale";
}

export function isPurchaseDocumentKind(kind: unknown): kind is PurchaseDocumentKind {
  return documentFamily(kind) === "purchase";
}
