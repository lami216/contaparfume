import type { BootstrapData, DocumentRecord } from "./domain";

export function canUseCapability(principal: BootstrapData["principal"], capability: string) {
  return principal.principalType !== "user" || principal.permissions.includes(capability);
}

export function documentProductQuantityEffect(
  document: DocumentRecord,
  productId: string,
  selectedWarehouseId: string,
  allWarehousesSelected = false,
) {
  const line = document.lines.find(item => item.productId === productId);
  if (!line) return 0;
  const quantity = Number(line.quantity);
  if (!Number.isFinite(quantity)) return 0;

  if (document.kind === "sale") return -quantity;
  if (document.kind === "purchase") return quantity;
  if (document.kind === "transfer") {
    if (allWarehousesSelected) return 0;
    if (document.warehouseId === selectedWarehouseId) return -quantity;
    if (document.destinationWarehouseId === selectedWarehouseId) return quantity;
    return 0;
  }
  return quantity;
}

export function adjustmentActualQuantity(document: DocumentRecord, productId: string) {
  const line = document.lines.find(item => item.productId === productId);
  if (!line) return "";
  const storedAfter = Number(line.balanceAfter);
  if (Number.isFinite(storedAfter)) return String(storedAfter);
  const storedBefore = Number(line.balanceBefore);
  const delta = Number(line.quantity);
  return Number.isFinite(storedBefore) && Number.isFinite(delta) ? String(storedBefore + delta) : "";
}
