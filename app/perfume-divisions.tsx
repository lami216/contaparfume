"use client";

import { useMemo, useState } from "react";
import { activeProducts, activeWarehouses, inventoryUnitCost, money, quantity, stockInWarehouse, totalProductStock, type BootstrapData, type Product } from "./domain";
import { divisionLandedCost, lotRemainingTotal, roundedDivisionLiquidCost, type PerfumeLot } from "./perfume-logic";
import { tr } from "./i18n/messages";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;

type BatchRow = {
  decantProduct: Product;
  lot: PerfumeLot;
  sourceName: string;
};

export default function PerfumeDivisions({ data, run }: { data: BootstrapData; run: RunCommand }) {
  const warehouses = activeWarehouses(data.warehouses);
  const sourceProducts = useMemo(() => activeProducts(data.products).filter(product => product.perfumeForm !== "decant" && product.perfumeForm !== "partial" && totalProductStock(product) > 0), [data.products]);
  const batches = useMemo<BatchRow[]>(() => data.products.flatMap(product => (product.perfumeForm === "decant" ? (product.perfumeLots ?? []).map(lot => ({ decantProduct: product, lot, sourceName: lot.sourceProductName })) : [])), [data.products]);
  const [sourceProductId, setSourceProductId] = useState("");
  const [warehouseId, setWarehouseId] = useState(warehouses.find(warehouse => warehouse.isSalesDefault)?.id ?? warehouses[0]?.id ?? "");
  const [divisionsCount, setDivisionsCount] = useState("10");
  const [bottleCost, setBottleCost] = useState("0");
  const [salePrice, setSalePrice] = useState("");
  const [decantSizeMl, setDecantSizeMl] = useState("10");
  const [recombinePrices, setRecombinePrices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const source = sourceProducts.find(product => product.id === sourceProductId) ?? null;
  const sourceCost = source ? inventoryUnitCost(source) : 0;
  const count = Number(divisionsCount);
  const bottle = Number(bottleCost);
  const sell = Number(salePrice);
  const liquidCost = sourceCost > 0 && Number.isInteger(count) && count > 0 ? roundedDivisionLiquidCost(sourceCost, count) : 0;
  const landedCost = sourceCost > 0 && Number.isInteger(count) && count > 0 && Number.isFinite(bottle) && bottle >= 0 ? divisionLandedCost(sourceCost, count, bottle) : 0;
  const unitProfit = Number.isFinite(sell) && sell > 0 ? sell - landedCost : 0;
  const expectedProfit = Number.isFinite(sell) && sell > 0 && count > 0 ? unitProfit * count : 0;
  const available = source && warehouseId ? stockInWarehouse(source, warehouseId) : 0;

  const split = async () => {
    if (!source || !warehouseId || !Number.isInteger(count) || count < 2 || !Number.isFinite(bottle) || bottle < 0 || !Number.isFinite(sell) || sell <= 0) return;
    setBusy(true);
    try {
      await run({ type: "perfume-split.post", sourceProductId: source.id, warehouseId, divisionsCount: count, bottleCost: bottle, salePrice: sell, decantSizeMl: decantSizeMl.trim() ? Number(decantSizeMl) : null }, tr("تم إنشاء التقسيمات"));
      setSalePrice("");
    } finally {
      setBusy(false);
    }
  };

  const recombine = async (row: BatchRow) => {
    const locations = Object.entries(row.lot.stocks ?? {}).filter(([, value]) => Number(value) > 0);
    const remaining = lotRemainingTotal(row.lot);
    const singleWarehouse = locations.length === 1 && Number(locations[0][1]) === remaining ? locations[0][0] : "";
    const price = Number(recombinePrices[row.lot.id]);
    if (!singleWarehouse || remaining <= 0 || !Number.isFinite(price) || price <= 0) return;
    setBusy(true);
    try {
      await run({ type: "perfume-recombine.post", decantProductId: row.decantProduct.id, lotId: row.lot.id, warehouseId: singleWarehouse, salePrice: price }, tr("تم تحويل الباقي إلى عطر ناقص"));
      setRecombinePrices(values => ({ ...values, [row.lot.id]: "" }));
    } finally {
      setBusy(false);
    }
  };

  return <div className="perfume-divisions-page">
    <section className="perfume-divisions-card">
      <div className="perfume-divisions-heading">
        <div><h2>{tr("تحويل عطر إلى تقسيمات")}</h2><p>{tr("اختر عطرًا كاملًا، وسيحسب النظام تكلفة التقسيمة وسعر الطياح تلقائيًا.")}</p></div>
      </div>
      <div className="perfume-divisions-form">
        <label>{tr("العطر")}
          <select value={sourceProductId} onChange={event => setSourceProductId(event.target.value)}>
            <option value="">{tr("اختر العطر")}</option>
            {sourceProducts.map(product => <option key={product.id} value={product.id}>{product.name} — {quantity(totalProductStock(product))}</option>)}
          </select>
        </label>
        <label>{tr("المخزن")}
          <select value={warehouseId} onChange={event => setWarehouseId(event.target.value)}>
            <option value="">{tr("اختر المخزن")}</option>
            {warehouses.map(warehouse => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}
          </select>
        </label>
        <label>{tr("عدد التقسيمات")}<input inputMode="numeric" min="2" step="1" type="number" value={divisionsCount} onChange={event => setDivisionsCount(event.target.value)} /></label>
        <label>{tr("حجم التقسيمة (ml)")}<input inputMode="decimal" min="0" type="number" value={decantSizeMl} onChange={event => setDecantSizeMl(event.target.value)} /></label>
        <label>{tr("تكلفة زجاجة التقسيمة")}<input inputMode="decimal" min="0" type="number" value={bottleCost} onChange={event => setBottleCost(event.target.value)} /></label>
        <label>{tr("سعر البيع للتقسيمة")}<input inputMode="decimal" min="0" type="number" value={salePrice} onChange={event => setSalePrice(event.target.value)} /></label>
      </div>
      <div className="perfume-cost-preview">
        <div><span>{tr("سعر شراء العطر")}</span><strong>{money(sourceCost)}</strong></div>
        <div><span>{tr("تكلفة السائل للتقسيمة")}</span><strong>{money(liquidCost)}</strong><small>{tr("يُرفع تلقائيًا للعدد الصحيح الأعلى")}</small></div>
        <div><span>{tr("سعر الطياح")}</span><strong>{money(landedCost)}</strong></div>
        <div><span>{tr("ربح التقسيمة")}</span><strong>{money(unitProfit)}</strong></div>
        <div><span>{tr("الربح المتوقع من كامل العطر")}</span><strong>{money(expectedProfit)}</strong></div>
        <div><span>{tr("المتوفر في المخزن")}</span><strong>{quantity(available)}</strong></div>
      </div>
      <button className="primary perfume-split-action" disabled={busy || !source || available < 1 || count < 2 || landedCost <= 0 || sell <= 0} onClick={() => void split()}>{busy ? tr("جاري الحفظ…") : tr("اعتماد التقسيم")}</button>
    </section>

    <section className="perfume-divisions-card">
      <div className="perfume-divisions-heading"><div><h2>{tr("دفعات التقسيمات")}</h2><p>{tr("كل عملية تقسيم تحتفظ بتكلفتها الأصلية حتى لو تغير سعر شراء العطر لاحقًا.")}</p></div></div>
      <div className="perfume-batches-table-wrap">
        <table className="erp-table perfume-batches-table">
          <thead><tr><th>{tr("العطر")}</th><th>{tr("التقسيمة")}</th><th>{tr("الأصل")}</th><th>{tr("المتبقي")}</th><th>{tr("تكلفة السائل")}</th><th>{tr("تكلفة الزجاجة")}</th><th>{tr("سعر الطياح")}</th><th>{tr("إرجاع الباقي")}</th></tr></thead>
          <tbody>{batches.length === 0 ? <tr><td colSpan={8}>{tr("لا توجد تقسيمات حتى الآن")}</td></tr> : batches.map(row => {
            const remaining = lotRemainingTotal(row.lot);
            const locations = Object.entries(row.lot.stocks ?? {}).filter(([, value]) => Number(value) > 0);
            const singleWarehouse = locations.length === 1 && Number(locations[0][1]) === remaining ? locations[0][0] : "";
            const warehouse = warehouses.find(item => item.id === singleWarehouse);
            const partialCost = remaining * row.lot.liquidUnitCost;
            return <tr key={row.lot.id}>
              <td>{row.sourceName}</td><td>{row.lot.decantSizeMl ? `${row.lot.decantSizeMl} ml` : tr("تقسيمة")}</td><td>{quantity(row.lot.originalQuantity)}</td><td>{quantity(remaining)}</td><td>{money(row.lot.liquidUnitCost)}</td><td>{money(row.lot.bottleCost)}</td><td>{money(row.lot.landedUnitCost)}</td>
              <td>{remaining <= 0 ? <span>{tr("مغلقة")}</span> : !singleWarehouse ? <span className="muted">{tr("اجمع الباقي في مخزن واحد أولًا")}</span> : <div className="perfume-recombine-control"><small>{warehouse?.name} · {tr("تكلفة العطر الناقص")}: {money(partialCost)}</small><input type="number" min="0" placeholder={tr("سعر بيع العطر الناقص")} value={recombinePrices[row.lot.id] ?? ""} onChange={event => setRecombinePrices(values => ({ ...values, [row.lot.id]: event.target.value }))}/><button className="soft" disabled={busy || Number(recombinePrices[row.lot.id]) <= 0} onClick={() => void recombine(row)}>{tr("تحويل إلى عطر ناقص")}</button></div>}</td>
            </tr>;
          })}</tbody>
        </table>
      </div>
    </section>
  </div>;
}
