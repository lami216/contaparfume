import { isProductExpired, type Product } from "./domain";
import type { Locale } from "./i18n/locale";

export type SaleDraftLine = {
  productId: string;
  quantity: string;
  piecePrice: string;
};

export type PriceMode = "retail" | "wholesale";
export type BelowCostWarning = { productId: string; productName: string; salePrice: number; purchaseCost: number };
export type SaleValidationError = { code: "missingProduct"; productId: string } | { code: "expiredProduct" | "invalidQuantity" | "invalidSalePrice"; productId: string; productName: string } | { code: "insufficientQuantity"; productId: string; productName: string; requested: number; available: number };

export const initialSaleUiState = { priceMode: "retail" as PriceMode, scannerEnabled: false };

/** Clear only a successfully posted sale draft, never invoice history. */
export function clearPersistedSaleDraft(storage: Pick<Storage, "setItem">) {
  storage.setItem("conta:sale-lines", "[]");
  storage.setItem("conta:sale-payment", JSON.stringify(""));
  storage.setItem("conta:sale-party", JSON.stringify(""));
}

export function belowCostConfirmation(locale: Locale, warnings: BelowCostWarning[]) {
  const lines=warnings.map(w => locale === "fr" ? `• ${w.productName} — vente ${w.salePrice} MRU / achat ${w.purchaseCost} MRU` : `• ${w.productName} — البيع ${w.salePrice} MRU / الشراء ${w.purchaseCost} MRU`);
  return locale === "fr" ? `Attention : certains produits sont vendus sous leur coût d’achat :\n\n${lines.join("\n")}\n\nContinuer la vente ?` : `تنبيه: توجد منتجات تباع بأقل من سعر الشراء:\n\n${lines.join("\n")}\n\nهل تريد متابعة البيع؟`;
}

export function formatSaleValidationError(locale: Locale, error: SaleValidationError) {
  if (locale === "fr") {
    if (error.code === "missingProduct") return "Un produit n’est plus disponible.";
    if (error.code === "expiredProduct") return `${error.productName} : ce produit est périmé et ne peut pas être vendu.`;
    if (error.code === "invalidQuantity") return `${error.productName} : la quantité doit être supérieure à zéro.`;
    if (error.code === "invalidSalePrice") return `${error.productName} : le prix de vente doit être supérieur à zéro.`;
    if (error.code === "insufficientQuantity") return `La quantité demandée pour « ${error.productName} » est ${error.requested} ; seulement ${error.available} est disponible.`;
  }
  if (error.code === "missingProduct") return "أحد المنتجات لم يعد متاحًا.";
  if (error.code === "expiredProduct") return `${error.productName}: انتهت صلاحية هذا المنتج ولا يمكن بيعه.`;
  if (error.code === "invalidQuantity") return `${error.productName}: الكمية غير صالحة ويجب أن تكون أكبر من صفر.`;
  if (error.code === "invalidSalePrice") return `${error.productName}: سعر البيع غير صالح ويجب أن يكون أكبر من صفر.`;
  if (error.code === "insufficientQuantity") return `الكمية المطلوبة لمنتج «${error.productName}» هي ${error.requested} والمتوفر ${error.available} فقط.`;
  return "";
}

/** Selling tiers choose an editable default and never alter accounting cost. */
export function sellingPrice(product: Product, mode: PriceMode = "retail") {
  const retail = Number(product.piecePrice ?? 0);
  const wholesale = Number(product.wholesalePrice ?? 0);
  return mode === "wholesale" && wholesale > 0 ? wholesale : retail;
}

export function applyPriceMode<T extends SaleDraftLine>(lines: T[], products: Product[], mode: PriceMode): T[] {
  const byId = new Map(products.map(product => [product.id, product]));
  return lines.map(line => {
    const product = byId.get(line.productId);
    return product ? { ...line, piecePrice: String(sellingPrice(product, mode)) } : line;
  });
}

export function updateSaleDraftLine<T extends SaleDraftLine>(lines: T[], productId: string, patch: Partial<T>): T[] {
  return lines.map(line => line.productId === productId ? { ...line, ...patch } : line);
}

export function validateSaleDraft(lines: SaleDraftLine[], products: Product[], warehouseId?: string, businessDate?: string) {
  const errors: SaleValidationError[] = [];
  const warnings: BelowCostWarning[] = [];
  const invalidProductIds = new Set<string>();
  for (const line of lines) {
    const product = products.find(item => item.id === line.productId);
    if (!product) {
      errors.push({ code: "missingProduct", productId: line.productId });
      invalidProductIds.add(line.productId);
      continue;
    }
    if (isProductExpired(product, businessDate)) {
      errors.push({ code: "expiredProduct", productId: product.id, productName: product.name });
      invalidProductIds.add(product.id);
    }
    const quantity = Number(line.quantity), price = Number(line.piecePrice);
    const available = Number(product.stocks?.[warehouseId ?? ""] ?? 0);
    if (line.quantity.trim() === "" || !Number.isFinite(quantity) || quantity <= 0) {
      errors.push({ code: "invalidQuantity", productId: product.id, productName: product.name });
      invalidProductIds.add(product.id);
    } else if (quantity > available) {
      errors.push({ code: "insufficientQuantity", productId: product.id, productName: product.name, requested: quantity, available });
      invalidProductIds.add(product.id);
    }
    if (line.piecePrice.trim() === "" || !Number.isFinite(price) || price <= 0) {
      errors.push({ code: "invalidSalePrice", productId: product.id, productName: product.name });
      invalidProductIds.add(product.id);
    } else if (product.lastPurchaseCost != null && price < product.lastPurchaseCost) {
      warnings.push({ productId: product.id, productName: product.name, salePrice: price, purchaseCost: product.lastPurchaseCost });
    }
  }
  return { errors, warnings, invalidProductIds };
}
