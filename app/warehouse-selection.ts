type WarehouseChoice = { id?: unknown; _id?: unknown; isSalesDefault?: unknown; isArchived?: unknown };
export function soleWarehouseId(warehouses: WarehouseChoice[]) {
  const active = warehouses.filter(w => !w.isArchived);
  return active.length === 1 ? String(active[0].id ?? active[0]._id ?? "") : "";
}
export function defaultWarehouse<T extends WarehouseChoice>(warehouses: T[]): T | undefined {
  const active = warehouses.filter(w => !w.isArchived);
  return active.find(w => w.isSalesDefault) ?? (active.length === 1 ? active[0] : undefined);
}
/** Preserve document snapshots when editing; only a new draft gets the sole active warehouse. */
export function warehouseSelectionId(warehouses: WarehouseChoice[], selected = "", preserve = false) {
  if (preserve || warehouses.some(w => !w.isArchived && String(w.id ?? w._id) === selected)) return selected;
  return soleWarehouseId(warehouses) || selected;
}
