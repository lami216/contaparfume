type RecordValue = Record<string, unknown>;
export type BusinessErrorResponse = { status: number; body: RecordValue & { error: string } };
export const BUSINESS_ERROR_LIMITS = { items: 100, nestedItems: 20, identifier: 200, label: 240, title: 500, message: 2000 } as const;
const knownCodes = new Set(["OPENING_STOCK_BLOCKED", "OPENING_CORRECTION_BLOCKED", "OPENING_INITIAL_HAS_CORRECTION", "PERFUME_OPERATION_BLOCKED", "PRODUCT_ARCHIVE_STOCK_CONFIRMATION_REQUIRED"]);
const record = (value: unknown): RecordValue | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
/** Error metadata is a data contract. Do not invoke getters or stringify objects. */
function field(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function text(value: unknown, limit: number) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, limit) : "";
}
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function rows(value: unknown, map: (value: unknown) => unknown, limit: number = BUSINESS_ERROR_LIMITS.items) {
  if (!Array.isArray(value)) return [];
  const result: unknown[] = [];
  const lengthValue = field(value, "length");
  const length = typeof lengthValue === "number" ? Math.min(lengthValue, limit) : 0;
  for (let index = 0; index < length; index++) { const mapped = map(field(value, String(index))); if (mapped !== null) result.push(mapped); }
  return result;
}
const identifier = (value: unknown) => text(value, BUSINESS_ERROR_LIMITS.identifier);
function warehouse(value: unknown) {
  const source = record(value), warehouseId = identifier(field(source, "warehouseId")), quantityDelta = field(source, "quantityDelta");
  return warehouseId && finite(quantityDelta) ? { warehouseId, warehouseName: text(field(source, "warehouseName"), BUSINESS_ERROR_LIMITS.label), quantityDelta } : null;
}
function deficit(value: unknown) {
  const source = record(value), warehouseId = identifier(field(source, "warehouseId")), required = field(source, "required"), available = field(source, "available"), missing = field(source, "missing");
  return warehouseId && finite(required) && finite(available) && finite(missing) ? { warehouseId, required, available, missing } : null;
}
function blocker(value: unknown) {
  const source = record(value), documentId = identifier(field(source, "documentId"));
  if (!documentId) return null;
  return {
    documentId, documentNumber: text(field(source, "documentNumber"), BUSINESS_ERROR_LIMITS.label), kind: text(field(source, "kind"), 80),
    title: text(field(source, "title"), BUSINESS_ERROR_LIMITS.title), status: text(field(source, "status"), 40), occurredAt: text(field(source, "occurredAt"), 80),
    movementTypes: rows(field(source, "movementTypes"), value => typeof value === "string" ? text(value, 80) : null, BUSINESS_ERROR_LIMITS.nestedItems),
    warehouses: rows(field(source, "warehouses"), warehouse, BUSINESS_ERROR_LIMITS.nestedItems),
  };
}
function dependency(value: unknown) {
  const source = record(value), documentId = identifier(field(source, "documentId"));
  return documentId ? { documentId, number: text(field(source, "number"), BUSINESS_ERROR_LIMITS.label), label: text(field(source, "label"), BUSINESS_ERROR_LIMITS.label), occurredAt: text(field(source, "occurredAt"), 80) } : null;
}

/** Only explicit public business fields cross the command boundary. Internal
 * failures keep their logs server-side and always return a generic message. */
export function serializeBusinessError(error: unknown, statusHint?: number): BusinessErrorResponse {
  const candidate = statusHint ?? field(error, "status");
  const status = typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599 ? candidate : 500;
  const body: BusinessErrorResponse["body"] = { error: status < 500 ? text(field(error, "message"), BUSINESS_ERROR_LIMITS.message) || "تعذر تنفيذ العملية" : "تعذر تنفيذ العملية" };
  if (status >= 500) return { status, body };
  try {
    const source = [record(error), record(field(error, "details"))].find(value => { const code = field(value, "code"); return typeof code === "string" && knownCodes.has(code); });
    if (!source) return { status, body };
    const code = field(source, "code");
    if (typeof code !== "string" || !knownCodes.has(code)) return { status, body };
    body.code = code;
    if (code === "OPENING_STOCK_BLOCKED" || code === "OPENING_CORRECTION_BLOCKED") {
      body.productId = identifier(field(source, "productId")); body.productName = text(field(source, "productName"), BUSINESS_ERROR_LIMITS.label);
      for (const key of ["consumedOpening", "restoredOpening"]) { const value = field(source, key); if (finite(value)) body[key] = value; }
      body.deficits = rows(field(source, "deficits"), deficit); body.blockers = rows(field(source, "blockers"), blocker);
    } else if (code === "PERFUME_OPERATION_BLOCKED") body.dependencies = rows(field(source, "dependencies"), dependency);
    else if (code === "OPENING_INITIAL_HAS_CORRECTION") {
      body.productId = identifier(field(source, "productId")); body.correctionDocumentId = identifier(field(source, "correctionDocumentId"));
    } else if (code === "PRODUCT_ARCHIVE_STOCK_CONFIRMATION_REQUIRED") body.stock = rows(field(source, "stock"), value => {
      const warehouseId = identifier(field(value, "warehouseId")), quantity = field(value, "quantity");
      return warehouseId && finite(quantity) ? { warehouseId, quantity } : null;
    });
  } catch {
    // Malformed metadata must not turn a public business rejection into another
    // failure, or leave a partially serialized detail object in the response.
    return { status, body: { error: body.error } };
  }
  return { status, body };
}
