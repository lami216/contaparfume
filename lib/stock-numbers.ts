type Row = Record<string, unknown>;
export class StockQuantityError extends Error {
  status = 409;
}
/** Legacy numeric strings are readable, but blanks/null/booleans are not zero. */
export function stockNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Discard only floating-point residue from opposing ordinary stock changes. */
export function stockBalanceAfter(before: number, delta: number): number {
  const sum = before + delta;
  if (Number.isFinite(sum) && (before > 0 && delta < 0 || before < 0 && delta > 0)) {
    const tolerance = Math.min(1e-12, Number.EPSILON * (Math.abs(before) + Math.abs(delta)));
    if (Math.abs(sum) <= tolerance) return 0;
  }
  return sum;
}

/** Preserve the raw compare-and-set value while doing arithmetic exactly once as
 * numbers. Only the successfully touched warehouse cell is rewritten numerically. */
export function planStockChange(product: Row, warehouseId: string, inputDelta: unknown, document: Row, normalizeAfter?: (value: number) => number) {
  const productId = String(product.id ?? ""), documentId = String(document.id ?? ""), stocks = product.stocks;
  const badStock = () => new StockQuantityError(`رصيد المخزون المسجل للمنتج ${productId} في المخزن ${warehouseId} غير صالح؛ راجع بيانات المخزون`);
  if (stocks !== undefined && (stocks === null || typeof stocks !== "object" || Array.isArray(stocks))) throw badStock();
  const entries = stocks as Row | undefined, exists = entries !== undefined && Object.hasOwn(entries, warehouseId), raw = exists ? entries![warehouseId] : undefined;
  const before = exists ? stockNumber(raw) : 0, delta = stockNumber(inputDelta);
  if (before === null) throw badStock();
  if (delta === null) throw new StockQuantityError(`كمية حركة المخزون في المستند ${documentId} غير صالحة؛ راجع بيانات المستند`);
  const sum = normalizeAfter ? before + delta : stockBalanceAfter(before, delta);
  const after = normalizeAfter ? normalizeAfter(sum) : sum;
  if (!Number.isFinite(sum) || !Number.isFinite(after)) throw new StockQuantityError(`ناتج حركة المخزون في المستند ${documentId} غير صالح؛ راجع بيانات المستند`);
  const stockPath = `stocks.${warehouseId}`;
  return { before, after, delta, stockPath, stockMatch: exists ? { [stockPath]: raw } : { [stockPath]: { $exists: false } } };
}

/** Do not turn a corrupt zero/missing historical line into a successful void.
 * This normalizes local arithmetic inputs only; the saved invoice stays intact. */
export function historicalInvoiceStockLines(document: Row): Array<Row & { productId: string; quantity: number }> {
  const lines = document.lines, documentId = String(document.id ?? ""), number = String(document.number ?? "");
  const invalid = (index: number) => new StockQuantityError(`لا يمكن إلغاء المستند ${documentId} (${number}): كمية السطر ${index + 1} غير صالحة؛ راجع بيانات السند الأصلي`);
  if (!Array.isArray(lines) || lines.length === 0) throw invalid(0);
  return lines.map((line, index) => {
    if (line === null || typeof line !== "object" || Array.isArray(line)) throw invalid(index);
    const row = line as Row, quantity = stockNumber(row.quantity);
    if (quantity === null || quantity <= 0 || typeof row.productId !== "string" || !row.productId.trim()) throw invalid(index);
    return { ...row, productId: row.productId, quantity };
  });
}
