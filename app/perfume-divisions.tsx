"use client";

import { useMemo, useState } from "react";
import { activeProducts, activeWarehouses, formatDateTime, inventoryUnitCost, money, quantity, stockInWarehouse, totalProductStock, type BootstrapData, type Product } from "./domain";
import { lotRemainingTotal, roundedDivisionLiquidCost, type PerfumeLot } from "./perfume-logic";
import { tr } from "./i18n/messages";
import PerfumeProductPicker, { type PerfumePickerItem } from "./perfume-product-picker";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;
type AdjustmentPrefill = { productId: string; warehouseId: string };

type BatchRow = {
  decantProduct: Product;
  lot: PerfumeLot;
  sourceName: string;
};

export default function PerfumeDivisions({ data, run, onAdjustBottle }: { data: BootstrapData; run: RunCommand; onAdjustBottle?: (prefill: AdjustmentPrefill) => void }) {
  const warehouses = activeWarehouses(data.warehouses);
  const eligibleSourceProducts = useMemo(() => activeProducts(data.products).filter(product => !["decant", "partial", "bottle"].includes(String(product.perfumeForm ?? ""))), [data.products]);
  const sourceProducts = useMemo(() => eligibleSourceProducts.filter(product => totalProductStock(product) > 0), [eligibleSourceProducts]);
  const openingSourceProducts = eligibleSourceProducts;
  const bottles = useMemo(() => activeProducts(data.products).filter(product => product.perfumeForm === "bottle"), [data.products]);
  const batches = useMemo<BatchRow[]>(() => data.products.flatMap(product => (product.perfumeForm === "decant" ? (product.perfumeLots ?? []).map(lot => ({ decantProduct: product, lot, sourceName: lot.sourceProductName })) : [])), [data.products]);
  const stockOperations = useMemo(() => data.documents
    .filter(document => document.kind === "adjustment" && ["opening", "consumption", "yield-correction"].includes(String(document.perfumeStockOperationType ?? "")))
    .sort((left, right) => String(right.occurredAt).localeCompare(String(left.occurredAt)))
    .slice(0, 12), [data.documents]);
  const [sourceProductId, setSourceProductId] = useState("");
  const [warehouseId, setWarehouseId] = useState(warehouses.find(warehouse => warehouse.isSalesDefault)?.id ?? warehouses[0]?.id ?? "");
  const [divisionsCount, setDivisionsCount] = useState("10"), [salePrice, setSalePrice] = useState("");
  const [bottleName, setBottleName] = useState(""), [bottleSize, setBottleSize] = useState("10"), [bottleCost, setBottleCost] = useState("");
  const [recombinePrices, setRecombinePrices] = useState<Record<string, string>>({});
  const [openingSourceProductId, setOpeningSourceProductId] = useState(""), [openingWarehouseId, setOpeningWarehouseId] = useState(warehouseId);
  const [openingQuantity, setOpeningQuantity] = useState(""), [openingValue, setOpeningValue] = useState(""), [openingSalePrice, setOpeningSalePrice] = useState("");
  const [reconcileBatchKey, setReconcileBatchKey] = useState(""), [reconcileWarehouseId, setReconcileWarehouseId] = useState(warehouseId);
  const [reconcileMode, setReconcileMode] = useState<"consume" | "correct">("consume"), [reconcileQuantity, setReconcileQuantity] = useState("");
  const [reconcileReason, setReconcileReason] = useState(""), [reconcileReasonCode, setReconcileReasonCode] = useState("samples");
  const [consumeBottle, setConsumeBottle] = useState(false), [consumeBottleId, setConsumeBottleId] = useState("");
  const [adjustBottleId, setAdjustBottleId] = useState(""), [adjustActual, setAdjustActual] = useState(""), [adjustReason, setAdjustReason] = useState("");
  const [busy, setBusy] = useState(false), [localError, setLocalError] = useState("");

  const source = sourceProducts.find(product => product.id === sourceProductId) ?? null;
  const sourceCost = source ? inventoryUnitCost(source) : 0;
  const count = Number(divisionsCount), sell = Number(salePrice);
  const liquidCost = sourceCost > 0 && Number.isInteger(count) && count > 0 ? roundedDivisionLiquidCost(sourceCost, count) : 0;
  const expectedRevenue = Number.isFinite(sell) && sell > 0 && count > 0 ? sell * count : 0;
  const expectedProfitBeforeBottle = expectedRevenue > 0 ? expectedRevenue - liquidCost * count : 0;
  const available = source && warehouseId ? stockInWarehouse(source, warehouseId) : 0;
  const sourcePickerItems = useMemo<PerfumePickerItem[]>(() => sourceProducts.map(product => ({ id: product.id, name: product.name, meta: `${tr("المتوفر")}: ${quantity(totalProductStock(product))}` })), [sourceProducts]);
  const openingSourcePickerItems = useMemo<PerfumePickerItem[]>(() => openingSourceProducts.map(product => ({ id: product.id, name: product.name, meta: `${tr("المخزون الحالي")}: ${quantity(totalProductStock(product))}` })), [openingSourceProducts]);
  const selectedBatch = batches.find(row => `${row.decantProduct.id}::${row.lot.id}` === reconcileBatchKey) ?? null;
  const reconcileLotStock = selectedBatch && reconcileWarehouseId ? Number(selectedBatch.lot.stocks?.[reconcileWarehouseId] ?? 0) : 0;

  const split = async () => {
    if (!source || !warehouseId || !Number.isInteger(count) || count < 2 || !Number.isFinite(sell) || sell <= 0) return;
    setBusy(true); setLocalError("");
    try {
      await run({ type: "perfume-split.post", sourceProductId: source.id, warehouseId, divisionsCount: count, salePrice: sell }, tr("تم إنشاء التقسيمات"));
      setSalePrice("");
    } finally { setBusy(false); }
  };

  const postOpeningBalance = async () => {
    const sourceProduct = openingSourceProducts.find(product => product.id === openingSourceProductId);
    const qty = Number(openingQuantity), value = Number(openingValue), price = Number(openingSalePrice);
    if (!sourceProduct || !openingWarehouseId || !Number.isInteger(qty) || qty <= 0 || !Number.isFinite(value) || value <= 0 || !Number.isFinite(price) || price <= 0) {
      setLocalError("أدخل العطر والمخزن والكمية وقيمة السائل المتبقية وسعر البيع.");
      return;
    }
    setBusy(true); setLocalError("");
    try {
      await run({ type: "perfume-opening.post", sourceProductId: sourceProduct.id, warehouseId: openingWarehouseId, quantity: qty, remainingValue: value, salePrice: price }, "تم تسجيل الرصيد الافتتاحي للتقسيمات");
      setOpeningQuantity(""); setOpeningValue(""); setOpeningSalePrice("");
    } finally { setBusy(false); }
  };

  const saveLotReconciliation = async () => {
    if (!selectedBatch || !reconcileWarehouseId || !reconcileReason.trim()) { setLocalError("اختر الدفعة والمخزن واكتب سبب الحركة."); return; }
    const amount = Number(reconcileQuantity);
    if (!Number.isInteger(amount) || amount < 0 || (reconcileMode === "consume" && amount <= 0)) { setLocalError("راجع الكمية المدخلة."); return; }
    setBusy(true); setLocalError("");
    try {
      if (reconcileMode === "consume") {
        await run({
          type: "perfume-lot-consume.post",
          decantProductId: selectedBatch.decantProduct.id,
          lotId: selectedBatch.lot.id,
          warehouseId: reconcileWarehouseId,
          quantity: amount,
          reason: reconcileReason.trim(),
          reasonCode: reconcileReasonCode,
          consumeBottle,
          bottleProductId: consumeBottle ? consumeBottleId : null,
        }, "تم تسجيل استهلاك/هالك التقسيمات");
      } else {
        await run({
          type: "perfume-lot-correct.post",
          decantProductId: selectedBatch.decantProduct.id,
          lotId: selectedBatch.lot.id,
          warehouseId: reconcileWarehouseId,
          actualQuantity: amount,
          reason: reconcileReason.trim(),
        }, "تم تصحيح ناتج التقسيم مع الحفاظ على قيمة الرصيد");
      }
      setReconcileQuantity(""); setReconcileReason(""); setConsumeBottle(false); setConsumeBottleId("");
    } finally { setBusy(false); }
  };

  const voidStockOperation = async (documentId: string) => {
    setBusy(true); setLocalError("");
    try { await run({ type: "perfume-stock-operation.void", documentId }, "تم إلغاء حركة مخزون التقسيمات"); }
    finally { setBusy(false); }
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

  const beginBottleAdjustment = (bottle: Product) => {
    if (onAdjustBottle) { onAdjustBottle({ productId: bottle.id, warehouseId }); return; }
    setAdjustBottleId(bottle.id);
    setAdjustActual(String(stockInWarehouse(bottle, warehouseId)));
    setAdjustReason("");
    setLocalError("");
  };

  const saveBottleAdjustment = async (bottle: Product) => {
    const actual = Number(adjustActual), before = stockInWarehouse(bottle, warehouseId), purchaseCost = Number(bottle.lastPurchaseCost ?? bottle.pieceCost ?? 0);
    if (!warehouseId || !Number.isInteger(actual) || actual < 0 || !adjustReason.trim() || (actual > before && purchaseCost <= 0)) { setLocalError(tr("راجع الكمية وسعر الشراء")); return; }
    setBusy(true); setLocalError("");
    try {
      await run({ type: "adjustment.post", warehouseId, reason: adjustReason.trim(), lines: [{ productId: bottle.id, actualQuantity: actual, purchaseCost: actual > before ? purchaseCost : null }] }, tr("تم تسجيل تصحيح المخزون"));
      setAdjustBottleId(""); setAdjustActual(""); setAdjustReason("");
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
        <label>{tr("العطر")}<PerfumeProductPicker items={sourcePickerItems} value={sourceProductId} onChange={setSourceProductId} placeholder={tr("اختر العطر")} ariaLabel={tr("العطر")}/></label>
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

    <section className="perfume-divisions-card perfume-reconciliation-card">
      <div className="perfume-divisions-heading">
        <div><h2>تسوية مخزون التقسيمات</h2><p>للرصيد القديم، الهالك والعينات، وتصحيح ناتج التقسيم بدون إنشاء بيع أو شراء وهمي.</p></div>
      </div>

      <div className="perfume-reconciliation-grid">
        <div className="perfume-reconciliation-block">
          <strong>رصيد افتتاحي لعطر مفتوح قديم</strong>
          <div className="perfume-reconciliation-form">
            <label>{tr("العطر")}<PerfumeProductPicker items={openingSourcePickerItems} value={openingSourceProductId} onChange={setOpeningSourceProductId} placeholder={tr("اختر العطر")} ariaLabel={tr("العطر")}/></label>
            <label>{tr("المخزن")}<select value={openingWarehouseId} onChange={event => setOpeningWarehouseId(event.target.value)}><option value="">{tr("اختر المخزن")}</option>{warehouses.map(warehouse => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select></label>
            <label>الكمية الموجودة الآن<input type="number" min="1" step="1" value={openingQuantity} onChange={event => setOpeningQuantity(event.target.value)}/></label>
            <label>قيمة السائل المتبقية<input type="number" min="0" step="0.01" value={openingValue} onChange={event => setOpeningValue(event.target.value)}/></label>
            <label>سعر بيع التقسيمة<input type="number" min="0" step="0.01" value={openingSalePrice} onChange={event => setOpeningSalePrice(event.target.value)}/></label>
            <button className="primary" type="button" disabled={busy} onClick={() => void postOpeningBalance()}>تسجيل الرصيد الافتتاحي</button>
          </div>
          <small className="muted">يسجل السائل المتبقي فقط ولا ينقص عطرًا كاملًا ولا ينشئ حركة بنك أو مورد.</small>
        </div>

        <div className="perfume-reconciliation-block">
          <strong>استهلاك أو تصحيح دفعة موجودة</strong>
          <div className="perfume-reconciliation-form">
            <label>الدفعة<select value={reconcileBatchKey} onChange={event => { setReconcileBatchKey(event.target.value); setReconcileQuantity(""); }}>
              <option value="">اختر الدفعة</option>
              {batches.map(row => <option key={row.lot.id} value={`${row.decantProduct.id}::${row.lot.id}`}>{row.sourceName} — متبقي {quantity(lotRemainingTotal(row.lot))}</option>)}
            </select></label>
            <label>{tr("المخزن")}<select value={reconcileWarehouseId} onChange={event => { setReconcileWarehouseId(event.target.value); setReconcileQuantity(""); }}><option value="">{tr("اختر المخزن")}</option>{warehouses.map(warehouse => <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>)}</select></label>
            <label>نوع الحركة<select value={reconcileMode} onChange={event => { setReconcileMode(event.target.value as "consume" | "correct"); setReconcileQuantity(""); }}>
              <option value="consume">استهلاك / هالك / عينات</option>
              <option value="correct">تصحيح ناتج التقسيم</option>
            </select></label>
            <label>{reconcileMode === "consume" ? "الكمية الخارجة" : "الكمية الفعلية الآن"}<input type="number" min="0" step="1" value={reconcileQuantity} onChange={event => setReconcileQuantity(event.target.value)} placeholder={reconcileMode === "correct" ? String(reconcileLotStock) : "1"}/></label>
            {reconcileMode === "consume" && <label>التصنيف<select value={reconcileReasonCode} onChange={event => setReconcileReasonCode(event.target.value)}>
              <option value="samples">عينات وتجارب</option><option value="waste">هالك</option><option value="leak">تسريب</option><option value="internal">استخدام داخلي</option><option value="stock-difference">فرق جرد</option><option value="other">أخرى</option>
            </select></label>}
            <label className="perfume-reconciliation-reason">السبب<input value={reconcileReason} onChange={event => setReconcileReason(event.target.value)} placeholder={reconcileMode === "consume" ? "مثال: عينات للعملاء" : "مثال: الناتج الفعلي 9 بدل 8"}/></label>
          </div>
          {reconcileMode === "consume" && <div className="perfume-consume-bottle">
            <label><input type="checkbox" checked={consumeBottle} onChange={event => setConsumeBottle(event.target.checked)}/> خرجت زجاجة مع الكمية</label>
            {consumeBottle && <select value={consumeBottleId} onChange={event => setConsumeBottleId(event.target.value)}><option value="">اختر الزجاجة</option>{bottles.map(bottle => <option key={bottle.id} value={bottle.id}>{bottle.name} — مخزون {quantity(stockInWarehouse(bottle, reconcileWarehouseId))}</option>)}</select>}
          </div>}
          <div className="perfume-reconciliation-summary"><span>رصيد الدفعة في المخزن: <bdi>{quantity(reconcileLotStock)}</bdi></span>{selectedBatch && <span>تكلفة السائل الحالية: <bdi>{money(selectedBatch.lot.liquidUnitCost)}</bdi></span>}</div>
          <button className="primary" type="button" disabled={busy || !selectedBatch || !reconcileReason.trim() || !reconcileWarehouseId || (consumeBottle && !consumeBottleId)} onClick={() => void saveLotReconciliation()}>{reconcileMode === "consume" ? "تسجيل الاستهلاك / الهالك" : "اعتماد تصحيح الناتج"}</button>
        </div>
      </div>

      <div className="perfume-stock-operation-history">
        <strong>آخر حركات التسوية</strong>
        <div className="perfume-stock-operation-list">
          {stockOperations.length === 0 ? <span className="muted">لا توجد حركات بعد</span> : stockOperations.map(document => <div key={document.id} className="perfume-stock-operation-row">
            <span><b>{document.perfumeStockOperationType === "opening" ? "رصيد افتتاحي" : document.perfumeStockOperationType === "consumption" ? "استهلاك/هالك" : "تصحيح ناتج"}</b><small>{document.title || "—"} · {formatDateTime(document.occurredAt)}</small></span>
            <bdi>{document.perfumeStockOperationType === "consumption" ? money(Number(document.inventoryLoss ?? 0)) : document.stockDelta != null ? quantity(Number(document.stockDelta)) : "—"}</bdi>
            {document.status === "posted" ? <button className="soft danger" type="button" disabled={busy} onClick={() => void voidStockOperation(document.id)}>إلغاء</button> : <span className="muted">ملغاة</span>}
          </div>)}
        </div>
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
      <div className="perfume-bottles-table-wrap"><table className="erp-table perfume-bottles-table"><thead><tr><th>{tr("الزجاجة")}</th><th>{tr("الحجم")}</th><th>{tr("التكلفة المرجعية")}</th><th>{tr("آخر شراء")}</th><th>{tr("المخزون")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>{bottles.length === 0 ? <tr><td colSpan={6}>{tr("لا توجد أنواع زجاج حتى الآن")}</td></tr> : bottles.map(bottle => <tr key={bottle.id}><td>{bottle.name}</td><td className="num-cell">{bottle.decantSizeMl ? `${bottle.decantSizeMl} ml` : "—"}</td><td className="num-cell">{money(Number(bottle.pieceCost ?? 0))}</td><td className="num-cell">{money(Number(bottle.lastPurchaseCost ?? 0))}</td><td className="num-cell">{quantity(totalProductStock(bottle))}</td><td>{adjustBottleId === bottle.id && !onAdjustBottle ? <div className="perfume-bottle-adjust"><input type="number" min="0" step="1" value={adjustActual} onChange={event => setAdjustActual(event.target.value)} placeholder={tr("الكمية الحالية")}/><input value={adjustReason} onChange={event => setAdjustReason(event.target.value)} placeholder={tr("سبب التصحيح")}/><button className="primary" type="button" disabled={busy || !adjustReason.trim()} onClick={() => void saveBottleAdjustment(bottle)}>{tr("اعتماد التصحيح")}</button><button className="soft" type="button" onClick={() => setAdjustBottleId("")}>{tr("إلغاء")}</button></div> : <button className="soft" type="button" disabled={!warehouseId} onClick={() => beginBottleAdjustment(bottle)}>{tr("تصحيح الكمية")}</button>}</td></tr>)}</tbody></table></div>
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
