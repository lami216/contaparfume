"use client";

import { useMemo, useState } from "react";
import { activeProducts, activeWarehouses, inventoryUnitCost, money, quantity, stockInWarehouse, totalProductStock, type BootstrapData, type Product } from "./domain";
import { lotRemainingTotal, roundedDivisionLiquidCost, type PerfumeLot } from "./perfume-logic";
import { tr } from "./i18n/messages";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;
type AdjustmentPrefill = { productId: string; warehouseId: string };

type BatchRow = {
  decantProduct: Product;
  lot: PerfumeLot;
  sourceName: string;
};

export default function PerfumeDivisions({ data, run, onAdjustBottle }: { data: BootstrapData; run: RunCommand; onAdjustBottle?: (prefill: AdjustmentPrefill) => void }) {
  const warehouses = activeWarehouses(data.warehouses);
  const sourceProducts = useMemo(() => activeProducts(data.products).filter(product => !["decant", "partial", "bottle"].includes(String(product.perfumeForm ?? "")) && totalProductStock(product) > 0), [data.products]);
  const bottles = useMemo(() => activeProducts(data.products).filter(product => product.perfumeForm === "bottle"), [data.products]);
  const batches = useMemo<BatchRow[]>(() => data.products.flatMap(product => (product.perfumeForm === "decant" ? (product.perfumeLots ?? []).map(lot => ({ decantProduct: product, lot, sourceName: lot.sourceProductName })) : [])), [data.products]);
  const [sourceProductId, setSourceProductId] = useState("");
  const [warehouseId, setWarehouseId] = useState(warehouses.find(warehouse => warehouse.isSalesDefault)?.id ?? warehouses[0]?.id ?? "");
  const [divisionsCount, setDivisionsCount] = useState("10"), [salePrice, setSalePrice] = useState("");
  const [bottleName, setBottleName] = useState(""), [bottleSize, setBottleSize] = useState("10"), [bottleCost, setBottleCost] = useState("");
  const [recombinePrices, setRecombinePrices] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [localError, setLocalError] = useState("");

  const source = sourceProducts.find(product => product.id === sourceProductId) ?? null;
  const sourceCost = source ? inventoryUnitCost(source) : 0;
  const count = Number(divisionsCount), sell = Number(salePrice);
  const liquidCost = sourceCost > 0 && Number.isInteger(count) && count > 0 ? roundedDivisionLiquidCost(sourceCost, count) : 0;
  const expectedRevenue = Number.isFinite(sell) && sell > 0 && count > 0 ? sell * count : 0;
  const expectedProfitBeforeBottle = expectedRevenue > 0 ? expectedRevenue - liquidCost * count : 0;
  const available = source && warehouseId ? stockInWarehouse(source, warehouseId) : 0;

  const split = async () => {
    if (!source || !warehouseId || !Number.isInteger(count) || count < 2 || !Number.isFinite(sell) || sell <= 0) return;
    setBusy(true); setLocalError("");
    try {
      await run({ type: "perfume-split.post", sourceProductId: source.id, warehouseId, divisionsCount: count, salePrice: sell }, tr("تم إنشاء التقسيمات"));
      setSalePrice("");
    } finally { setBusy(false); }
  };

  const createBottle = async () => {
    const size = Number(bottleSize), cost = Number(bottleCost);
    if (!bottleName.trim() || !Number.isFinite(size) || size <= 0 || !Number.isFinite(cost) || cost <= 0) { setLocalError(tr("أدخل اسم الزجاجة وحجمها وتكلفتها")); return; }
    setBusy(true); setLocalError("");
    try {
      await run({ type: "perfume-bottle.create", name: bottleName.trim(), sizeMl: size, cost }, tr("تمت إضافة زجاجة التقسيمة"));
      setBottleName(""); setBottleCost("");
    } finally { setBusy(false); }
  };

  const recombine = async (row: BatchRow) => {
    const locations = Object.entries(row.lot.stocks ?? {}).filter(([, value]) => Number(value) > 0);
    const remaining = lotRemainingTotal(row.lot);
    const singleWarehouse = locations.length === 1 && Number(locations[0][1]) === remaining ? locations[0][0] : "";
    const price = Number(recombinePrices[row.lot.id]);
    if (!singleWarehouse || remaining <= 0 || !Number.isFinite(price) || price <= 0) return;
    setBusy(true); setLocalError("");
    try {
      await run({ type: "perfume-recombine.post", decantProductId: row.decantProduct.id, lotId: row.lot.id, warehouseId: singleWarehouse, salePrice: price }, tr("تم إرجاع الباقي إلى عطر ناقص"));
      setRecombinePrices(values => ({ ...values, [row.lot.id]: "" }));
    } finally { setBusy(false); }
  };

  return <div className="perfume-divisions-page">
    <section className="perfume-divisions-card perfume-split-card">
      <div className="perfume-divisions-heading">
        <div><h2>{tr("تحويل عطر إلى تقسيمات")}</h2><p>{tr("التحويل ينشئ مخزون السائل فقط. الزجاجة تختار لاحقًا داخل فاتورة التقسيمات.")}</p></div>
        <button type="button" className="primary perfume-split-action" disabled={busy || !source || available < 1 || count < 2 || liquidCost <= 0 || sell <= 0} onClick={() => void split()}>{busy ? tr("جاري الحفظ…") : tr("تحويل عطر إلى تقسيمات")}</button>
      </div>
      <div className="perfume-divisions-form perfume-divisions-form-v2">
        <label>{tr("العطر")}<select value={sourceProductId} onChange={event => setSourceProductId(event.target.value)}><option value="">{tr("اختر العطر")}</option>{sourceProducts.map(product => <option key={product.id} value={product.id}>{product.name} — {quantity(totalProductStock(product))}</option>)}</select></label>
        <label>{tr("المخزن")}<select value={warehouseId} onChange={event => setWarehouseId(event.target.value)}><option value="">{tr("اختر المخزن")}</option>{warehouses.map(warehouse => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select></label>
        <label>{tr("عدد التقسيمات")}<input inputMode="numeric" min="2" step="1" type="number" value={divisionsCount} onChange={event => setDivisionsCount(event.target.value)} /></label>
        <label>{tr("سعر البيع للتقسيمة")}<input inputMode="decimal" min="0" type="number" value={salePrice} onChange={event => setSalePrice(event.target.value)} /></label>
      </div>
      <div className="perfume-cost-preview perfume-cost-preview-v2">
        <div><span>{tr("سعر شراء العطر")}</span><strong>{money(sourceCost)}</strong></div>
        <div><span>{tr("تكلفة السائل للتقسيمة")}</span><strong>{money(liquidCost)}</strong><small>{tr("لا تشمل الزجاجة")}</small></div>
        <div><span>{tr("إجمالي البيع المتوقع")}</span><strong>{money(expectedRevenue)}</strong></div>
        <div><span>{tr("الربح قبل تكلفة الزجاج")}</span><strong>{money(expectedProfitBeforeBottle)}</strong></div>
        <div><span>{tr("المتوفر في المخزن")}</span><strong>{quantity(available)}</strong></div>
      </div>
    </section>

    <section className="perfume-divisions-card perfume-bottles-card">
      <div className="perfume-divisions-heading"><div><h2>{tr("زجاج التقسيمات")}</h2><p>{tr("عرّف نوع الزجاجة هنا، ثم اشترِ كمياتها من فاتورة شراء زجاج التقسيمات.")}</p></div></div>
      <div className="perfume-bottle-create">
        <label>{tr("اسم الزجاجة")}<input value={bottleName} onChange={event => setBottleName(event.target.value)} placeholder={tr("مثال: زجاجة شفافة")}/></label>
        <label>{tr("الحجم (ml)")}<input type="number" min="1" value={bottleSize} onChange={event => setBottleSize(event.target.value)}/></label>
        <label>{tr("التكلفة المرجعية")}<input type="number" min="0" value={bottleCost} onChange={event => setBottleCost(event.target.value)}/></label>
        <button className="soft" type="button" disabled={busy || !bottleName.trim() || Number(bottleSize) <= 0 || Number(bottleCost) <= 0} onClick={() => void createBottle()}>{tr("إضافة زجاجة")}</button>
      </div>
      <div className="perfume-bottles-table-wrap"><table className="erp-table perfume-bottles-table"><thead><tr><th>{tr("الزجاجة")}</th><th>{tr("الحجم")}</th><th>{tr("التكلفة المرجعية")}</th><th>{tr("آخر شراء")}</th><th>{tr("المخزون")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>{bottles.length === 0 ? <tr><td colSpan={6}>{tr("لا توجد أنواع زجاج حتى الآن")}</td></tr> : bottles.map(bottle => <tr key={bottle.id}><td>{bottle.name}</td><td className="num-cell">{bottle.decantSizeMl ? `${bottle.decantSizeMl} ml` : "—"}</td><td className="num-cell">{money(Number(bottle.pieceCost ?? 0))}</td><td className="num-cell">{money(Number(bottle.lastPurchaseCost ?? 0))}</td><td className="num-cell">{quantity(totalProductStock(bottle))}</td><td><button className="soft" type="button" disabled={!onAdjustBottle || !warehouseId} onClick={() => onAdjustBottle?.({ productId: bottle.id, warehouseId })}>{tr("تصحيح الكمية")}</button></td></tr>)}</tbody></table></div>
    </section>

    <section className="perfume-divisions-card perfume-batches-card">
      <div className="perfume-divisions-heading"><div><h2>{tr("دفعات التقسيمات")}</h2><p>{tr("اختر الدفعة ثم أدخل سعر العطر الناقص لإرجاع كل المتبقي منها إلى عطر واحد ناقص.")}</p></div></div>
      <div className="perfume-batches-table-wrap">
        <table className="erp-table perfume-batches-table">
          <thead><tr><th>{tr("العطر")}</th><th>{tr("الأصل")}</th><th>{tr("المتبقي")}</th><th>{tr("تكلفة السائل")}</th><th>{tr("المخزن")}</th><th>{tr("إرجاع إلى عطر ناقص")}</th></tr></thead>
          <tbody>{batches.length === 0 ? <tr><td colSpan={6}>{tr("لا توجد تقسيمات حتى الآن")}</td></tr> : batches.map(row => {
            const remaining = lotRemainingTotal(row.lot), locations = Object.entries(row.lot.stocks ?? {}).filter(([, value]) => Number(value) > 0);
            const singleWarehouse = locations.length === 1 && Number(locations[0][1]) === remaining ? locations[0][0] : "";
            const warehouse = warehouses.find(item => item.id === singleWarehouse), partialCost = remaining * row.lot.liquidUnitCost;
            return <tr key={row.lot.id}><td>{row.sourceName}</td><td>{quantity(row.lot.originalQuantity)}</td><td>{quantity(remaining)}</td><td>{money(row.lot.liquidUnitCost)}</td><td>{warehouse?.name ?? tr("أكثر من مخزن")}</td><td>{remaining <= 0 ? <span>{tr("مغلقة")}</span> : !singleWarehouse ? <span className="muted">{tr("اجمع الباقي في مخزن واحد أولًا")}</span> : <div className="perfume-recombine-control"><small>{tr("تكلفة العطر الناقص")}: {money(partialCost)}</small><input type="number" min="0" placeholder={tr("سعر بيع العطر الناقص")} value={recombinePrices[row.lot.id] ?? ""} onChange={event => setRecombinePrices(values => ({ ...values, [row.lot.id]: event.target.value }))}/><button className="primary" disabled={busy || Number(recombinePrices[row.lot.id]) <= 0} onClick={() => void recombine(row)}>{tr("إرجاع الباقي إلى عطر ناقص")}</button></div>}</td></tr>;
          })}</tbody>
        </table>
      </div>
    </section>
    {localError && <div className="error perfume-local-error">{localError}</div>}
  </div>;
}
