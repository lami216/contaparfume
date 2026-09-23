import type { Locale } from "./i18n/locale";

export type LowStockWarningItem = { productId: string; productName: string; remaining: number };
export const LOW_STOCK_THRESHOLD = 3;
const PENDING_LOW_STOCK_KEY = "conta:pending-low-stock-warning";
type SessionStorageLike = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): SessionStorageLike | undefined {
  try { return typeof globalThis.sessionStorage === "undefined" ? undefined : globalThis.sessionStorage; }
  catch { return undefined; }
}

export function shouldWarnLowStock(remaining: number) {
  return Number.isFinite(remaining) && remaining >= 0 && remaining <= LOW_STOCK_THRESHOLD;
}

export function stagePendingLowStockWarning(items: LowStockWarningItem[], storage: SessionStorageLike | undefined = browserStorage()) {
  if (!storage) return;
  try { storage.setItem(PENDING_LOW_STOCK_KEY, JSON.stringify(items)); } catch { /* storage can be unavailable in hardened browser contexts */ }
}

export function clearPendingLowStockWarning(storage: Pick<Storage, "setItem"> | undefined = browserStorage()) {
  if (!storage) return;
  try { storage.setItem(PENDING_LOW_STOCK_KEY, "[]"); } catch { /* storage can be unavailable in hardened browser contexts */ }
}

export function readPendingLowStockWarning(storage: Pick<Storage, "getItem"> | undefined = browserStorage()): LowStockWarningItem[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PENDING_LOW_STOCK_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => {
      if (!item || typeof item !== "object") return [];
      const value = item as Partial<LowStockWarningItem>;
      const remaining = Number(value.remaining);
      return typeof value.productId === "string" && typeof value.productName === "string" && shouldWarnLowStock(remaining)
        ? [{ productId: value.productId, productName: value.productName, remaining }]
        : [];
    });
  } catch { return []; }
}

function displayQuantity(value: number) {
  return value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}

export function formatLowStockWarning(locale: Locale, items: LowStockWarningItem[]) {
  if (!items.length) return "";
  if (locale === "fr") {
    if (items.length === 1) {
      const item = items[0];
      return `Attention : le produit « ${item.productName} » est presque épuisé. Quantité restante : ${displayQuantity(item.remaining)}.`;
    }
    return `Attention : ces produits sont presque épuisés :\n${items.map(item => `• ${item.productName} — reste ${displayQuantity(item.remaining)}`).join("\n")}`;
  }
  if (items.length === 1) {
    const item = items[0];
    return `تنبيه: المنتج «${item.productName}» على وشك النفاد. الكمية المتبقية: ${displayQuantity(item.remaining)}.`;
  }
  return `تنبيه: هذه المنتجات على وشك النفاد:\n${items.map(item => `• ${item.productName} — المتبقي ${displayQuantity(item.remaining)}`).join("\n")}`;
}
