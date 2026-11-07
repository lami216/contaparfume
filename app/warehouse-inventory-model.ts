import { inventoryValueAcrossWarehouses, type Product } from "./domain";

export type WarehouseInventorySummary = {
  count: number;
  pieces: number;
  millilitres: number;
  hasPieces: boolean;
  hasMillilitres: boolean;
  value: number;
};

export function inventoryProductUnit(product: Pick<Product, "perfumeStockUnit">) {
  return product.perfumeStockUnit === "ml" ? "ml" : "piece";
}

export function inventoryProductQuantity(product: Pick<Product, "stocks">, warehouseIds: string[]) {
  return warehouseIds.reduce((sum, id) => sum + Number(product.stocks[id] ?? 0), 0);
}

/** Current positive stock shares one scope across the grid, cards and output.
 * Business dates only constrain the separate period movement columns. */
export function buildWarehouseInventory({
  products, warehouseIds, categoryId = "", query = "",
}: { products: Product[]; warehouseIds: string[]; categoryId?: string; query?: string }) {
  const needle = query.trim().toLocaleLowerCase();
  const summary: WarehouseInventorySummary = {
    count: 0, pieces: 0, millilitres: 0, hasPieces: false, hasMillilitres: false, value: 0,
  };
  const selected = products.filter(product => {
    if (categoryId && product.categoryId !== categoryId) return false;
    if (needle && !`${product.name} ${product.sku} ${product.barcode}`.toLocaleLowerCase().includes(needle)) return false;
    const quantity = inventoryProductQuantity(product, warehouseIds);
    if (!(quantity > 0)) return false;
    summary.count += 1;
    if (inventoryProductUnit(product) === "ml") {
      summary.hasMillilitres = true;
      summary.millilitres += quantity;
    } else {
      summary.hasPieces = true;
      summary.pieces += quantity;
    }
    summary.value += inventoryValueAcrossWarehouses(product, warehouseIds);
    return true;
  });
  return { products: selected, summary };
}

export function inventoryQuantityLabel(
  summary: WarehouseInventorySummary,
  labels: { pieces: string; millilitres: string; format: (value: number) => string },
) {
  const parts = [];
  if (summary.hasPieces || !summary.hasMillilitres) parts.push(`${labels.format(summary.pieces)} ${labels.pieces}`);
  if (summary.hasMillilitres) parts.push(`${labels.format(summary.millilitres)} ${labels.millilitres}`);
  return parts.join(" · ");
}
