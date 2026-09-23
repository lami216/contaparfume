import type { PerfumeAllocation, PerfumeForm, PerfumeLot } from "./perfume-logic";

export type PaymentMethod = string;
export type DocumentKind =
  | "purchase"
  | "sale"
  | "decant-purchase"
  | "decant-sale"
  /** Legacy read-only document kind; new creation is disabled. */
  | "return"
  | "transfer"
  | "adjustment"
  | "expense"
  | "payment"
  | "offset"
  | "settlement"
  | "account-transfer"
  | "account-adjustment";
export type PartyType = "customer" | "supplier";
export interface Party {
  id: string;
  name: string;
  phone: string;
  partyType: PartyType;
  receivable: number;
  payable: number;
  net: number;
  isArchived?: boolean;
  archivedAt?: string | null;
}
/** Single compatibility authority: pre-role parties were suppliers in Conta. */
export function resolvePartyType(party: unknown): PartyType {
  return (party as { partyType?: unknown } | null)?.partyType === "customer" ? "customer" : "supplier";
}
export interface Warehouse {
  id: string;
  name: string;
  isSalesDefault: boolean;
  isArchived?: boolean;
  archivedAt?: string | null;
}
export function activeWarehouses<T extends Pick<Warehouse, "isArchived">>(warehouses: T[]) { return warehouses.filter(warehouse => !warehouse.isArchived); }
export interface ProductCategory {
  id: string;
  name: string;
  createdAt?: string;
}
export interface Product {
  id: string;
  name: string;
  sku: string;
  barcode: string;
  /** Editable product-card purchase price; never an accounting cost authority by itself. */
  pieceCost: number | null;
  /** Effective accounting cost: newest posted purchase, otherwise an opening-cost fallback. */
  lastPurchaseCost?: number | null;
  lastPurchaseAt?: string | null;
  lastPurchaseCostSource?: "purchase" | "opening" | "legacy-opening" | "adjustment" | null;
  /** Native opening balance metadata. Historical movement replay remains authoritative for consumed quantity. */
  openingStock?: number | null;
  openingCost?: number | null;
  openingWarehouseId?: string | null;
  /** Imported DataAcc cost fallback. The imported stock row is a snapshot, not an editable native opening balance. */
  legacyOpeningCost?: number | null;
  piecePrice: number | null;
  /** Optional wholesale selling price per individual unit. */
  wholesalePrice: number | null;
  /** Optional business expiry date. The product is sellable through this day. */
  expiryDate?: string | null;
  note?: string | null;
  categoryId?: string | null;
  perfumeForm?: PerfumeForm | null;
  parentProductId?: string | null;
  decantSizeMl?: number | null;
  decantBottleCost?: number | null;
  partialRemainingParts?: number | null;
  partialOriginalParts?: number | null;
  perfumeLots?: PerfumeLot[];
  stocks: Record<string, number>;
  isArchived?: boolean;
  archivedAt?: string | null;
}

/** Products available when creating a new operation. Archived rows remain in
 * bootstrap data for inventory valuation and historical identity. */
export function activeProducts<T extends Pick<Product, "isArchived">>(products: T[]) {
  return products.filter(product => !product.isArchived);
}

export function isProductExpired(product: unknown, businessDate = new Date().toISOString().slice(0, 10)) {
  const expiryDate = (product as { expiryDate?: unknown } | null)?.expiryDate;
  return typeof expiryDate === "string" && expiryDate !== "" && expiryDate < businessDate;
}
export interface DocumentLine {
  id: string;
  productId: string | null;
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  costAtSale?: number | null;
  grossProfit?: number | null;
  balanceBefore?: number;
  balanceAfter?: number;
  perfumeAllocations?: PerfumeAllocation[];
  bottleProductId?: string | null;
  bottleProductName?: string | null;
  bottleUnitCost?: number | null;
  bottleQuantity?: number | null;
}
export interface DocumentRecord {
  id: string;
  number: string;
  sequence?: number;
  legacyBillCode?: string;
  kind: DocumentKind;
  partyId: string | null;
  partyName: string | null;
  partyNameOriginal?: string | null;
  partyNameSnapshot?: string | null;
  warehouseId: string | null;
  warehouseName: string | null;
  destinationWarehouseId: string | null;
  destinationWarehouseName: string | null;
  parentDocumentId: string | null;
  paymentMethod: string | null;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  status: string;
  title: string | null;
  /** Opening-stock audit metadata for initial balances and later corrections. */
  openingCorrection?: boolean;
  openingStockBefore?: number | null;
  openingStockAfter?: number | null;
  openingCostBefore?: number | null;
  openingCostAfter?: number | null;
  total: number;
  dueTotal: number;
  paidTotal: number;
  /** Actual cash moved; legacy documents fall back to paidTotal. */
  cashAmount?: number;
  partyCashDirection?: "receive" | "pay";
  accountAdjustmentDirection?: "deposit" | "withdrawal";
  partyBalanceBefore?: number;
  partyBalanceDelta?: number;
  partyBalanceAfter?: number;
  occurredAt: string;
  businessDate?: string;
  dailySequence?: number;
  recurringId?: string;
  legacyKey?: string;
  pricingMode?: "retail" | "wholesale";
  revision?: number;
  updatedAt?: string;
  voidedAt?: string;
  lines: DocumentLine[];
}
export interface Movement {
  id: string;
  documentId: string;
  documentNumber: string;
  warehouseId: string;
  warehouseName: string;
  productId: string;
  productName: string;
  type: string;
  quantityDelta: number;
  balanceBefore: number;
  balanceAfter: number;
  occurredAt: string;
  documentRevision?: number;
}
export interface BootstrapData {
  principal: { principalType: "local" | "owner" | "user"; name: string; permissions: string[] };
  branding: InvoiceBrandingSettings;
  /** Informational only; product.create allocates the authoritative value atomically. */
  nextProductCode: number;
  /** Informational previews; posting remains authoritative and allocates atomically. */
  nextDocumentSequences: { sale: number; purchase: number; expense: number; decantSale: number; decantPurchase: number };
  parties: Party[];
  warehouses: Warehouse[];
  products: Product[];
  categories: ProductCategory[];
  documents: DocumentRecord[];
  movements: Movement[];
  financialMovements: FinancialMovement[];
  partyFinancialSummaries: PartyFinancialSummary[];
  paymentAccounts: PaymentAccount[];
  accountTransfers: AccountTransferRecord[];
}
export interface AccountTransferRecord {
  id: string;
  documentId?: string;
  number: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  note: string | null;
  occurredAt: string;
  status?: "posted" | "voided";
  revision?: number;
  updatedAt?: string;
  voidedAt?: string;
}
export const invoiceFonts = ["tahoma", "arial", "segoe-ui", "times-new-roman"] as const;
export type InvoiceFont = typeof invoiceFonts[number];
export type InvoiceBrandingSettings = {
  storeName: string;
  storeLogoDataUrl: string;
  storePhone: string;
  storeAddress: string;
  registrationNumber: string;
  taxNumber: string;
  footerNote: string;
  nameFont: InvoiceFont;
  nameFontSize: number;
  nameFontWeight: 400 | 600 | 800;
};
export interface PartyFinancialSummary {
  partyId: string;
  cashIn: number;
  cashOut: number;
  customerTradeTotal: number;
  customerGrossProfit: number;
  supplierTradeTotal: number;
  supplierInvoiceCount: number;
}
export interface PaymentAccount {
  id: string;
  code: string;
  name: string;
  color: string;
  icon: string;
  isActive: boolean;
  allowNegativeBalance: boolean;
  balance: number;
  /** Persisted starting basis; bootstrap normalizes legacy rows to a finite value. */
  openingBalance: number;
  income: number;
  expenses: number;
  purchaseTotal: number;
  isArchived?: boolean;
  archivedAt?: string | null;
}
export function activePaymentAccounts<T extends Pick<PaymentAccount, "isActive" | "isArchived">>(accounts: T[]) { return accounts.filter(account => account.isActive !== false && account.isArchived !== true); }
export interface FinancialMovement {
  id: string;
  paymentMethod: string;
  direction: "in" | "out";
  amount: number;
  documentId: string;
  documentNumber: string;
  partyId: string | null;
  partyName: string | null;
  partyNameOriginal?: string | null;
  type: string;
  occurredAt: string;
  transferId?: string | null;
  note?: string | null;
  status?: "posted" | "reversed";
  revision?: number;
  isReversal?: boolean;
  reversedAt?: string;
  reversalMovementId?: string;
  reversalReason?: string;
  reversalOfMovementId?: string;
  delta?: number;
  balanceBefore?: number;
  balanceAfter?: number;
  openingBalanceBefore?: number;
  openingBalanceAfter?: number;
  reason?: string;
}
export const paymentMethods: Array<{
  id: Exclude<PaymentMethod, "note">;
  label: string;
}> = [
  { id: "cash", label: "نقدي" },
  { id: "bankily", label: "بنكيلي" },
  { id: "masrvi", label: "مصرفي" },
  { id: "sedad", label: "السداد" },
  { id: "bimbank", label: "بيم" },
];
export const kindLabels: Record<DocumentKind, string> = {
  purchase: "فاتورة شراء",
  sale: "فاتورة بيع",
  "decant-purchase": "فاتورة شراء زجاج التقسيمات",
  "decant-sale": "فاتورة التقسيمات",
  return: "حركة تاريخية",
  transfer: "تحويل مخزون",
  adjustment: "تصحيح مخزون",
  expense: "فاتورة مصروفات",
  payment: "سداد",
  offset: "مقاصة",
  settlement: "تسوية يدوية للرصيد",
  "account-transfer": "تحويل بين الحسابات",
  "account-adjustment": "سحب / إيداع",
};
/** Current document kinds offered by user-facing filters. */
export const visibleDocumentKindLabels = Object.fromEntries(
  Object.entries(kindLabels).filter(([kind]) => kind !== "return"),
) as Partial<Record<DocumentKind, string>>;
export function western(value: number | string) {
  return String(value)
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
}
const DISPLAY_LOCALE = "fr-FR-u-nu-latn";
const numberFormatter = new Intl.NumberFormat(DISPLAY_LOCALE, {
  maximumFractionDigits: 3,
  numberingSystem: "latn",
});

/** Format display values with Latin digits without changing stored data. */
export function formatNumber(value: number) {
  return western(numberFormatter.format(value));
}
export function formatQuantity(value: number) {
  return formatNumber(value);
}
export function formatMoney(value: number) {
  return `${formatNumber(value)} MRU`;
}
export function displayDocumentNumber(document: Pick<DocumentRecord, "number" | "sequence" | "kind">) {
  return ["sale", "purchase", "expense", "decant-sale", "decant-purchase"].includes(document.kind) && Number.isSafeInteger(Number(document.sequence)) && Number(document.sequence) > 0 ? String(document.sequence) : document.number;
}
/** Accounting-backed inventory valuation. Manual pieceCost never silently becomes historical cost. */
export function inventoryUnitCost(product: Pick<Product, "lastPurchaseCost" | "openingCost" | "legacyOpeningCost" | "perfumeForm" | "perfumeLots">) {
  if (product.perfumeForm === "decant" && product.perfumeLots?.length) {
    const remaining = product.perfumeLots.reduce((sum, lot) => sum + Number(lot.remainingQuantity ?? 0), 0);
    if (remaining > 0) return product.perfumeLots.reduce((sum, lot) => sum + Number(lot.remainingQuantity ?? 0) * Number(lot.liquidUnitCost ?? lot.landedUnitCost ?? 0), 0) / remaining;
  }
  return product.lastPurchaseCost ?? product.openingCost ?? product.legacyOpeningCost ?? 0;
}
export function formatDate(
  value: Date | string | number,
  options: Intl.DateTimeFormatOptions = { day: "2-digit", month: "2-digit", year: "numeric" },
) {
  return western(new Intl.DateTimeFormat(DISPLAY_LOCALE, {
    ...options,
    numberingSystem: "latn",
  }).format(new Date(value)));
}
export function formatDateTime(value: Date | string | number) {
  return formatDate(value, {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

// Existing view-facing names share the same central formatting policy.
export const money = formatMoney;
export const number = formatNumber;
export function quantity(value: number) {
  return formatQuantity(value);
}
/** Total availability, only for views that intentionally span every warehouse. */
export function totalProductStock(product: Pick<Product, "stocks">) {
  return Object.values(product.stocks ?? {}).reduce((sum, value) => sum + Number(value ?? 0), 0);
}
/** Exact availability in one warehouse; a missing stock entry is zero, never the global total. */
export function stockInWarehouse(product: Pick<Product, "stocks">, warehouseId?: string) {
  if (!warehouseId) return 0;
  return Number(product.stocks?.[warehouseId] ?? 0);
}
export function saleLineTotal(qty: number, piecePrice: number) {
  if (!Number.isFinite(qty) || qty <= 0) return 0;
  return Math.round(qty * piecePrice);
}
export function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}
