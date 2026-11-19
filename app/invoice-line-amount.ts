export const MAX_INVOICE_LINE_AMOUNT = Number.MAX_SAFE_INTEGER;
export type InvoiceLineTotalMode = "exact";
type PriceKey = "piecePrice" | "unitPrice";
export type InvoiceAmountDraft = {
  quantity: string; piecePrice: string; unitPrice: string;
  lineTotal?: string; lineTotalMode?: InvoiceLineTotalMode; lineTotalAwaitingQuantity?: boolean;
};

/** Three displayed decimal places are formatting, never a storage policy. */
export function invoiceAmountNumber(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= MAX_INVOICE_LINE_AMOUNT ? parsed : null;
}

/** Num accepts decimal text; do not put scientific notation into its editable value. */
export function invoiceAmountText(value: number): string {
  if (!Number.isFinite(value)) return "";
  const text = String(value);
  if (!/e/i.test(text)) return text;
  const [mantissa, exponent] = text.toLowerCase().split("e"), [whole, fraction = ""] = mantissa.split(".");
  const digits = whole + fraction, position = whole.length + Number(exponent);
  return position <= 0 ? "0." + "0".repeat(-position) + digits
    : position >= digits.length ? digits + "0".repeat(position - digits.length)
      : digits.slice(0, position) + "." + digits.slice(position);
}

function productValue(quantity: string, price: string): number | null {
  const q = invoiceAmountNumber(quantity), p = invoiceAmountNumber(price);
  if (q === null || p === null) return null;
  // Decimal multiplication avoids showing 0.020000000000000004 for 0.1 × 0.2.
  if ([quantity, price].every(value => value.length <= 350 && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))) {
    const decimals = (quantity.split(".")[1]?.length ?? 0) + (price.split(".")[1]?.length ?? 0);
    const digits = (BigInt(quantity.replace(".", "")) * BigInt(price.replace(".", ""))).toString().padStart(decimals + 1, "0");
    const value = Number(decimals ? digits.slice(0, -decimals) + "." + digits.slice(-decimals) : digits);
    return Number.isFinite(value) && value <= MAX_INVOICE_LINE_AMOUNT ? value : null;
  }
  const value = q * p;
  return Number.isFinite(value) && value <= MAX_INVOICE_LINE_AMOUNT ? value : null;
}

export class InvoiceLineAmountError extends Error {
  status = 400;
}

/** The optional total is an explicit price agreement, never an unchecked discount. */
export function resolveInvoiceLineTotal(quantity: number, unitPrice: number, explicitTotal?: unknown, hasExplicitTotal = false): number {
  if (!hasExplicitTotal) return Math.round(quantity * unitPrice);
  const total = invoiceAmountNumber(explicitTotal), q = invoiceAmountNumber(quantity), p = invoiceAmountNumber(unitPrice);
  if (total === null || total <= 0 || q === null || q <= 0 || p === null || p <= 0) throw new InvoiceLineAmountError("مجموع السطر غير صالح");
  const product = q * p;
  if (!Number.isFinite(product) || product <= 0 || product > MAX_INVOICE_LINE_AMOUNT) throw new InvoiceLineAmountError("مجموع السطر غير صالح");
  const tolerance = Math.min(1e-7, Number.EPSILON * 8 * Math.max(product, total));
  if (Math.abs(product - total) > tolerance) throw new InvoiceLineAmountError("مجموع السطر لا يطابق الكمية وسعر الوحدة");
  return total;
}

export function sumInvoiceLineTotals(values: number[], exact: boolean, allowEmpty = false): number {
  let total = values.reduce((sum, value) => sum + value, 0);
  if (exact) {
    if (values.some(value=>invoiceAmountNumber(value)===null)) throw new InvoiceLineAmountError("إجمالي الفاتورة غير صالح");
    const texts=values.map(invoiceAmountText),decimals=Math.max(0,...texts.map(text=>text.split(".")[1]?.length??0));
    const scaled=texts.reduce((sum,text)=>{const [whole,fraction=""]=text.split(".");return sum+BigInt(whole+fraction.padEnd(decimals,"0"));},BigInt(0));
    if(scaled>BigInt(MAX_INVOICE_LINE_AMOUNT)*BigInt(10)**BigInt(decimals))throw new InvoiceLineAmountError("إجمالي الفاتورة غير صالح");
    const digits=scaled.toString().padStart(decimals+1,"0");
    total=Number(decimals?digits.slice(0,-decimals)+"."+digits.slice(-decimals):digits);
  }
  if (exact && (!Number.isFinite(total) || (allowEmpty?total<0:total<=0) || total > MAX_INVOICE_LINE_AMOUNT)) throw new InvoiceLineAmountError("إجمالي الفاتورة غير صالح");
  return total;
}

export function resetInvoiceLineAmount<T extends InvoiceAmountDraft>(line: T): T {
  const copy = { ...line };
  delete copy.lineTotal; delete copy.lineTotalAwaitingQuantity;
  return copy;
}

export function updateInvoiceLineAmount<T extends InvoiceAmountDraft>(line: T, key: PriceKey, field: "quantity" | "price" | "total", value: string): T {
  const copy = { ...line };
  if (field === "total") {
    copy.lineTotal = value; copy.lineTotalMode = "exact";
    const quantity = invoiceAmountNumber(copy.quantity), total = invoiceAmountNumber(value);
    if (quantity !== null && quantity > 0 && total !== null) {
      if(key==="piecePrice")copy.piecePrice=invoiceAmountText(total/quantity);else copy.unitPrice=invoiceAmountText(total/quantity);
      delete copy.lineTotalAwaitingQuantity;
    } else copy.lineTotalAwaitingQuantity = quantity === null || quantity <= 0;
    return copy;
  }
  if (field === "quantity") {
    copy.quantity = value;
    const quantity = invoiceAmountNumber(value), total = invoiceAmountNumber(copy.lineTotal);
    if (copy.lineTotalAwaitingQuantity && quantity !== null && quantity > 0 && total !== null) {
      if(key==="piecePrice")copy.piecePrice=invoiceAmountText(total/quantity);else copy.unitPrice=invoiceAmountText(total/quantity);
      delete copy.lineTotalAwaitingQuantity;
      return copy;
    }
  } else if(key==="piecePrice")copy.piecePrice=value;else copy.unitPrice=value;
  delete copy.lineTotal; delete copy.lineTotalAwaitingQuantity;
  return copy;
}

export function invoiceDraftTotalText(line: InvoiceAmountDraft, key: PriceKey): string {
  if (line.lineTotal !== undefined) return line.lineTotal;
  if(line.lineTotalMode!=="exact"){
    const quantity=invoiceAmountNumber(line.quantity),price=invoiceAmountNumber(line[key]);
    return quantity===null||price===null?"":invoiceAmountText(Math.round(quantity*price));
  }
  const value = productValue(line.quantity, line[key]);
  return value === null ? "" : invoiceAmountText(value);
}

export function invoiceDraftTotal(line: InvoiceAmountDraft, key: PriceKey): number {
  return invoiceAmountNumber(invoiceDraftTotalText(line, key)) ?? 0;
}

export function invoiceDraftInvoiceTotal(lines: InvoiceAmountDraft[], key: PriceKey): number {
  try { return sumInvoiceLineTotals(lines.map(line=>invoiceDraftTotal(line,key)),lines.some(line=>line.lineTotalMode==="exact"||line.lineTotal!==undefined),true); }
  catch { return 0; }
}

export function invoiceDraftAmountPayload(line: InvoiceAmountDraft, key: PriceKey): { lineTotal?: number } {
  if (line.lineTotalMode !== "exact" && line.lineTotal === undefined) return {};
  const total = invoiceDraftTotalText(line, key);
  return { lineTotal: resolveInvoiceLineTotal(Number(line.quantity), Number(line[key]), total, true) };
}

export function validateInvoiceDraftAmounts(lines: InvoiceAmountDraft[], key: PriceKey): void {
  for(const line of lines)invoiceDraftAmountPayload(line,key);
  if(lines.some(line=>line.lineTotalMode==="exact"||line.lineTotal!==undefined))sumInvoiceLineTotals(lines.map(line=>invoiceDraftTotal(line,key)),true);
}

/** Native old rounded rows remain rounded; only the new saved policy is reloaded. */
export function storedInvoiceAmountDraft(line: { lineTotalMode?: unknown; lineTotal: number }): { lineTotalMode?: InvoiceLineTotalMode; lineTotal?: string } {
  return line.lineTotalMode === "exact" ? { lineTotalMode: "exact", lineTotal: invoiceAmountText(line.lineTotal) } : {};
}
