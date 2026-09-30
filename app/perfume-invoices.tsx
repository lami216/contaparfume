"use client";

import { Search } from "lucide-react";
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  activePaymentAccounts,
  activeProducts,
  activeWarehouses,
  displayDocumentNumber,
  money,
  quantity,
  stockInWarehouse,
  type BootstrapData,
  type DocumentRecord,
  type Product,
} from "./domain";
import { tr } from "./i18n/messages";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;
type Props = { data: BootstrapData; run: RunCommand; openDoc: (id: string) => void };
type DraftLine = { key: string; productId: string; quantity: string; unitPrice: string; bottleProductId: string };

const lineKey = () => crypto.randomUUID();
const n = (value: string) => value.trim() === "" ? 0 : Number(value);
const normalized = (value: string) => value.trim().toLocaleLowerCase();

export function reservedProductQuantity(lines: DraftLine[], productId: string, excludedLineKey = "") {
  return lines.reduce((sum, line) => {
    if (line.key === excludedLineKey) return sum;
    const parsed = n(line.quantity), lineQuantity = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    return sum + (line.productId === productId ? lineQuantity : 0) + (line.bottleProductId === productId ? lineQuantity : 0);
  }, 0);
}

function InvoiceHistory({ documents, openDoc, onVoid, busy }: { documents: DocumentRecord[]; openDoc: (id: string) => void; onVoid: (document: DocumentRecord) => void; busy: boolean }) {
  return <section className="decant-invoice-history">
    <div className="decant-invoice-heading"><div><h3>{tr("آخر فواتير التقسيمات")}</h3><p>{tr("يمكن فتح الفاتورة أو إلغاؤها لإعادة المخزون والحسابات كما كانت.")}</p></div></div>
    <div className="decant-invoice-history-scroll">
      <table className="erp-table decant-invoice-history-table">
        <thead><tr><th>{tr("رقم")}</th><th>{tr("التاريخ")}</th><th>{tr("الطرف")}</th><th>{tr("القيمة")}</th><th>{tr("الحالة")}</th><th>{tr("إجراءات")}</th></tr></thead>
        <tbody>{documents.length === 0 ? <tr><td colSpan={6}>{tr("لا توجد فواتير تقسيمات حتى الآن")}</td></tr> : documents.map(document => <tr key={document.id}>
          <td className="num-cell">{displayDocumentNumber(document)}</td><td>{new Date(document.occurredAt).toLocaleDateString()}</td><td>{document.partyName ?? "—"}</td><td className="num-cell">{money(document.total)}</td><td>{document.status === "posted" ? tr("معتمدة") : tr("ملغاة")}</td>
          <td className="action-cell"><button className="soft" type="button" onClick={() => openDoc(document.id)}>{tr("عرض")}</button>{document.status === "posted" && <button className="soft danger-text" type="button" disabled={busy} onClick={() => onVoid(document)}>{tr("إلغاء الفاتورة")}</button>}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

export function DecantSaleInvoice({ data, run, openDoc }: Props) {
  const warehouses = activeWarehouses(data.warehouses), accounts = activePaymentAccounts(data.paymentAccounts), customers = data.parties.filter(party => party.partyType === "customer");
  const decants = useMemo(() => activeProducts(data.products).filter(product => product.perfumeForm === "decant"), [data.products]);
  const bottles = useMemo(() => activeProducts(data.products).filter(product => product.perfumeForm === "bottle"), [data.products]);
  const saleProducts = useMemo(() => [...decants, ...bottles], [decants, bottles]);
  const recent = useMemo(() => data.documents.filter(document => document.kind === "decant-sale").slice(0, 20), [data.documents]);
  const [warehouseId, setWarehouseId] = useState(warehouses.find(warehouse => warehouse.isSalesDefault)?.id ?? warehouses[0]?.id ?? "");
  const [paymentMethod, setPaymentMethod] = useState(accounts[0]?.id ?? "");
  const [partyId, setPartyId] = useState("");
  const [searchQuery, setSearchQuery] = useState(""), [highlightedProductId, setHighlightedProductId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]), [busy, setBusy] = useState(false), [localError, setLocalError] = useState("");
  const warehouse = warehouses.find(item => item.id === warehouseId);
  const total = lines.reduce((sum, line) => sum + n(line.quantity) * n(line.unitPrice), 0);
  const searchTerm = normalized(searchQuery);
  const searchResults = useMemo(() => searchTerm ? saleProducts.map((product, index) => {
    const name = normalized(product.name), sku = normalized(product.sku ?? ""), barcode = normalized(product.barcode ?? "");
    const score = barcode === searchTerm || sku === searchTerm ? 0 : barcode.startsWith(searchTerm) || sku.startsWith(searchTerm) ? 1 : name.startsWith(searchTerm) ? 2 : name.includes(searchTerm) ? 3 : 4;
    return { product, index, score, matches: `${name} ${sku} ${barcode}`.includes(searchTerm) };
  }).filter(item => item.matches).sort((a, b) => a.score - b.score || a.index - b.index).slice(0, 20).map(item => item.product) : [], [saleProducts, searchTerm]);

  const addProduct = (product: Product) => {
    const stock = stockInWarehouse(product, warehouseId), existing = lines.find(line => line.productId === product.id), reservedQuantity = reservedProductQuantity(lines, product.id);
    if (stock <= reservedQuantity) { setLocalError(tr("لا توجد كمية إضافية متاحة من هذا المنتج")); return; }
    setLines(current => {
      const line = current.find(item => item.productId === product.id);
      return line
        ? current.map(item => item.key === line.key ? { ...item, quantity: String(n(item.quantity) + 1) } : item)
        : [...current, { key: lineKey(), productId: product.id, quantity: "1", unitPrice: String(product.piecePrice ?? 0), bottleProductId: "" }];
    });
    setSearchQuery(""); setHighlightedProductId(""); setLocalError("");
  };
  const onSearchKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setHighlightedProductId(current => searchResults.length ? searchResults[Math.min(current ? searchResults.findIndex(product => product.id === current) + 1 : 0, searchResults.length - 1)].id : ""); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setHighlightedProductId(current => searchResults.length ? searchResults[Math.max(current ? searchResults.findIndex(product => product.id === current) - 1 : searchResults.length - 1, 0)].id : ""); }
    else if (event.key === "Enter") { const product = searchResults.find(item => item.id === highlightedProductId) ?? searchResults.find(item => stockInWarehouse(item, warehouseId) > reservedProductQuantity(lines, item.id)); if (product) { event.preventDefault(); addProduct(product); } }
    else if (event.key === "Escape") setHighlightedProductId("");
  };
  const patch = (key: string, value: Partial<DraftLine>) => setLines(current => current.map(line => line.key === key ? { ...line, ...value } : line));
  const remove = (key: string) => setLines(current => current.filter(line => line.key !== key));

  const submit = async () => {
    setLocalError("");
    if (!warehouseId || !lines.length) { setLocalError(tr("أضف منتجًا واختر المخزن")); return; }
    if (paymentMethod === "note" && !partyId) { setLocalError(tr("اختر عميلاً عند البيع الآجل")); return; }
    const requestedStock = new Map<string, number>();
    const reserve = (productId: string, requested: number) => requestedStock.set(productId, (requestedStock.get(productId) ?? 0) + requested);
    for (const line of lines) {
      const product = saleProducts.find(item => item.id === line.productId);
      if (!product || !Number.isInteger(n(line.quantity)) || n(line.quantity) <= 0 || n(line.unitPrice) <= 0) { setLocalError(tr("راجع الكمية والسعر في الفاتورة")); return; }
      if (product.perfumeForm === "decant" && !line.bottleProductId) { setLocalError(tr("اختر زجاجة لكل عطر تقسيمات")); return; }
      reserve(product.id, n(line.quantity));
      if (product.perfumeForm === "decant") {
        const bottle = bottles.find(item => item.id === line.bottleProductId);
        if (!bottle) { setLocalError(tr("مخزون زجاج التقسيمات غير كافٍ")); return; }
        reserve(bottle.id, n(line.quantity));
      }
    }
    for (const [productId, requested] of requestedStock) {
      const product = saleProducts.find(item => item.id === productId);
      if (!product || stockInWarehouse(product, warehouseId) < requested) { setLocalError(product?.perfumeForm === "bottle" ? tr("مخزون زجاج التقسيمات غير كافٍ") : tr("الكمية المطلوبة أكبر من المتوفر")); return; }
    }
    setBusy(true);
    try {
      await run({ type: "decant-sale.post", warehouseId, paymentMethod, partyId: partyId || null, cashAmount: paymentMethod === "note" ? 0 : total, lines: lines.map(line => ({ productId: line.productId, quantity: n(line.quantity), unitPrice: n(line.unitPrice), bottleProductId: line.bottleProductId || null })) }, tr("تم اعتماد فاتورة التقسيمات"));
      setLines([]); setPartyId(""); setLocalError("");
    } finally { setBusy(false); }
  };
  const voidInvoice = async (document: DocumentRecord) => {
    if (!window.confirm(`${tr("إلغاء الفاتورة")} ${displayDocumentNumber(document)}؟`)) return;
    setBusy(true); try { await run({ type: "decant-sale.void", documentId: document.id }, tr("تم إلغاء فاتورة التقسيمات")); } finally { setBusy(false); }
  };

  return <div className="decant-invoice-page">
    <section className="decant-invoice-editor">
      <div className="decant-invoice-heading"><div><h2>{tr("فاتورة التقسيمات")}</h2><p>{tr("بيع عطر التقسيمات مع اختيار الزجاجة، أو بيع زجاج التقسيمات فارغًا.")}</p></div><strong>{money(total)}</strong></div>
      <div className="decant-invoice-meta">
        <label>{tr("المخزن")}<select value={warehouseId} onChange={event => setWarehouseId(event.target.value)}>{warehouses.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label>{tr("طريقة الدفع")}<select value={paymentMethod} onChange={event => setPaymentMethod(event.target.value)}><option value="note">{tr("آجل")}</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
        <label>{tr("العميل")}<select value={partyId} onChange={event => setPartyId(event.target.value)}><option value="">{tr("بيع تقسيمات مباشر")}</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
      </div>
      <div className="decant-product-picker">
        <label className="search compact-search decant-product-search"><Search aria-hidden="true"/><input type="search" role="combobox" aria-label={tr("المنتج أو الزجاجة")} aria-autocomplete="list" aria-expanded={searchResults.length > 0} aria-controls="decant-product-results" value={searchQuery} onChange={event => { setSearchQuery(event.target.value); setHighlightedProductId(""); }} onKeyDown={onSearchKeyDown} placeholder={tr("ابحث بالاسم أو الكود أو الباركود")}/></label>
        {searchTerm && <div id="decant-product-results" className="decant-product-results" role="listbox">
          {searchResults.length === 0 ? <div className="picker-no-results">{tr("لا توجد نتائج")}</div> : <table className="erp-table"><thead><tr><th>{tr("المنتج")}</th><th>{tr("النوع")}</th><th>{tr("السعر")}</th><th>{tr("المتوفر")}</th><th>{tr("إضافة")}</th></tr></thead><tbody>{searchResults.map(product => {
            const stock = stockInWarehouse(product, warehouseId), reservedQuantity = reservedProductQuantity(lines, product.id), availableQuantity = Math.max(0, stock - reservedQuantity), unavailable = availableQuantity <= 0;
            return <tr key={product.id} role="option" aria-selected={highlightedProductId === product.id} className={`${highlightedProductId === product.id ? "selected " : ""}${unavailable ? "unavailable" : ""}`.trim()} onClick={() => setHighlightedProductId(product.id)} onDoubleClick={() => addProduct(product)}>
              <td className="name-cell">{product.name}{product.sku && <small>{product.sku}</small>}</td><td>{product.perfumeForm === "decant" ? tr("عطر تقسيمات") : `${tr("زجاجة تقسيمات")}${product.decantSizeMl ? ` · ${product.decantSizeMl} ml` : ""}`}</td><td className="num-cell">{money(Number(product.piecePrice ?? 0))}</td><td className="num-cell">{quantity(availableQuantity)}</td><td className="action-cell"><button type="button" className="soft" disabled={unavailable} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); if (event.detail > 1) return; addProduct(product); }}>{tr("إضافة")}</button></td>
            </tr>;
          })}</tbody></table>}
        </div>}
      </div>
      <div className="decant-lines-scroll"><table className="erp-table decant-lines-table"><thead><tr><th>{tr("المنتج")}</th><th>{tr("الكمية")}</th><th>{tr("سعر البيع")}</th><th>{tr("زجاجة التقسيمة")}</th><th>{tr("المتوفر")}</th><th>{tr("الإجمالي")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>{lines.length === 0 ? <tr><td colSpan={7}>{tr("أضف عطر تقسيمات أو زجاجة فارغة")}</td></tr> : lines.map(line => { const product = saleProducts.find(item => item.id === line.productId)!; const isDecant = product.perfumeForm === "decant"; return <tr key={line.key}><td>{product.name}</td><td><input type="number" min="1" step="1" value={line.quantity} onChange={event => patch(line.key, { quantity: event.target.value })}/></td><td><input type="number" min="0" value={line.unitPrice} onChange={event => patch(line.key, { unitPrice: event.target.value })}/></td><td>{isDecant ? <select value={line.bottleProductId} onChange={event => patch(line.key, { bottleProductId: event.target.value })}><option value="">{tr("اختر الزجاجة")}</option>{bottles.map(bottle => { const reservedElsewhere = reservedProductQuantity(lines, bottle.id, line.key), availableForLine = stockInWarehouse(bottle, warehouseId) - reservedElsewhere; return <option key={bottle.id} value={bottle.id} disabled={availableForLine < n(line.quantity)}>{bottle.name} · {bottle.decantSizeMl ? `${bottle.decantSizeMl} ml` : ""} · {quantity(Math.max(0, availableForLine))}</option>; })}</select> : <span className="muted">{tr("بيع فارغ")}</span>}</td><td className="num-cell">{quantity(stockInWarehouse(product, warehouseId))}</td><td className="num-cell">{money(n(line.quantity) * n(line.unitPrice))}</td><td><button className="soft" type="button" onClick={() => remove(line.key)}>{tr("حذف")}</button></td></tr>; })}</tbody></table></div>
      {localError && <div className="error">{localError}</div>}
      <div className="decant-invoice-actions"><button className="primary" type="button" disabled={busy || !lines.length || !warehouse} onClick={() => void submit()}>{busy ? tr("جاري الحفظ…") : tr("اعتماد فاتورة التقسيمات")}</button></div>
    </section>
    <InvoiceHistory documents={recent} openDoc={openDoc} onVoid={voidInvoice} busy={busy}/>
  </div>;
}

export function DecantBottlePurchaseInvoice({ data, run, openDoc }: Props) {
  const warehouses = activeWarehouses(data.warehouses), accounts = activePaymentAccounts(data.paymentAccounts), suppliers = data.parties.filter(party => party.partyType === "supplier");
  const bottles = useMemo(() => activeProducts(data.products).filter(product => product.perfumeForm === "bottle"), [data.products]);
  const recent = useMemo(() => data.documents.filter(document => document.kind === "decant-purchase").slice(0, 20), [data.documents]);
  const [warehouseId, setWarehouseId] = useState(warehouses.find(warehouse => warehouse.isSalesDefault)?.id ?? warehouses[0]?.id ?? "");
  const [paymentMethod, setPaymentMethod] = useState(accounts[0]?.id ?? ""), [partyId, setPartyId] = useState(""), [productId, setProductId] = useState("");
  const [bottleName, setBottleName] = useState(""), [bottleSize, setBottleSize] = useState("10"), [bottleCost, setBottleCost] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]), [busy, setBusy] = useState(false), [localError, setLocalError] = useState("");
  const total = lines.reduce((sum, line) => sum + n(line.quantity) * n(line.unitPrice), 0);
  const add = () => { const product = bottles.find(item => item.id === productId); if (!product || lines.some(line => line.productId === product.id)) return; setLines(current => [...current, { key: lineKey(), productId: product.id, quantity: "1", unitPrice: String(product.lastPurchaseCost ?? product.pieceCost ?? 0), bottleProductId: "" }]); setProductId(""); };
  const patch = (key: string, value: Partial<DraftLine>) => setLines(current => current.map(line => line.key === key ? { ...line, ...value } : line));
  const remove = (key: string) => setLines(current => current.filter(line => line.key !== key));
  const createBottle = async () => {
    const size = Number(bottleSize), cost = Number(bottleCost);
    if (!bottleName.trim() || !Number.isFinite(size) || size <= 0 || !Number.isFinite(cost) || cost <= 0) { setLocalError(tr("أدخل اسم الزجاجة وحجمها وتكلفتها")); return; }
    setBusy(true); setLocalError("");
    try {
      const createdId = String(await run({ type: "perfume-bottle.create", name: bottleName.trim(), sizeMl: size, cost }, tr("تمت إضافة زجاجة التقسيمة")));
      setBottleName(""); setBottleCost(""); setProductId(createdId);
    } finally { setBusy(false); }
  };
  const submit = async () => {
    setLocalError("");
    if (!warehouseId || !lines.length) { setLocalError(tr("أضف زجاجة واختر المخزن")); return; }
    if (paymentMethod === "note" && !partyId) { setLocalError(tr("اختر موردًا عند الشراء الآجل")); return; }
    if (lines.some(line => !Number.isInteger(n(line.quantity)) || n(line.quantity) <= 0 || n(line.unitPrice) <= 0)) { setLocalError(tr("راجع الكمية وسعر الشراء")); return; }
    setBusy(true);
    try { await run({ type: "decant-purchase.post", warehouseId, paymentMethod, partyId: partyId || null, cashAmount: paymentMethod === "note" ? 0 : total, lines: lines.map(line => ({ productId: line.productId, quantity: n(line.quantity), unitPrice: n(line.unitPrice) })) }, tr("تم اعتماد فاتورة شراء زجاج التقسيمات")); setLines([]); setPartyId(""); setLocalError(""); }
    finally { setBusy(false); }
  };
  const voidInvoice = async (document: DocumentRecord) => {
    if (!window.confirm(`${tr("إلغاء الفاتورة")} ${displayDocumentNumber(document)}؟`)) return;
    setBusy(true); try { await run({ type: "decant-purchase.void", documentId: document.id }, tr("تم إلغاء فاتورة شراء زجاج التقسيمات")); } finally { setBusy(false); }
  };
  return <div className="decant-invoice-page">
    <section className="decant-invoice-editor">
      <div className="decant-invoice-heading"><div><h2>{tr("فاتورة شراء زجاج التقسيمات")}</h2><p>{tr("هذه الفاتورة مخصصة لإدخال كميات زجاج التقسيمات إلى المخزون.")}</p></div><strong>{money(total)}</strong></div>
      <div className="decant-invoice-meta"><label>{tr("المخزن")}<select value={warehouseId} onChange={event => setWarehouseId(event.target.value)}>{warehouses.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>{tr("طريقة الدفع")}<select value={paymentMethod} onChange={event => setPaymentMethod(event.target.value)}><option value="note">{tr("آجل")}</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label><label>{tr("المورد")}<select value={partyId} onChange={event => setPartyId(event.target.value)}><option value="">{tr("شراء زجاج مباشر")}</option>{suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label></div>
      <div className="decant-purchase-product-tools">
        <div className="perfume-bottle-create decant-bottle-create">
          <label>{tr("اسم الزجاجة")}<input value={bottleName} onChange={event => setBottleName(event.target.value)} placeholder={tr("مثال: زجاجة شفافة")}/></label>
          <label>{tr("الحجم (ml)")}<input type="number" min="1" value={bottleSize} onChange={event => setBottleSize(event.target.value)}/></label>
          <label>{tr("التكلفة المرجعية")}<input type="number" min="0" value={bottleCost} onChange={event => setBottleCost(event.target.value)}/></label>
          <button className="soft" type="button" disabled={busy || !bottleName.trim() || Number(bottleSize) <= 0 || Number(bottleCost) <= 0} onClick={() => void createBottle()}>{tr("إضافة نوع زجاج")}</button>
        </div>
        <div className="decant-add-row"><label>{tr("زجاجة التقسيمة")}<select value={productId} onChange={event => setProductId(event.target.value)}><option value="">{tr("اختر الزجاجة")}</option>{bottles.map(product => <option key={product.id} value={product.id}>{product.name}{product.decantSizeMl ? ` · ${product.decantSizeMl} ml` : ""}</option>)}</select></label><button className="soft" type="button" disabled={!productId} onClick={add}>{tr("إضافة للفاتورة")}</button></div>
      </div>
      <div className="decant-lines-scroll"><table className="erp-table decant-lines-table"><thead><tr><th>{tr("الزجاجة")}</th><th>{tr("الحجم")}</th><th>{tr("الكمية")}</th><th>{tr("سعر الشراء")}</th><th>{tr("الإجمالي")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>{lines.length === 0 ? <tr><td colSpan={6}>{tr("أضف زجاجة إلى فاتورة الشراء")}</td></tr> : lines.map(line => { const product = bottles.find(item => item.id === line.productId)!; return <tr key={line.key}><td>{product.name}</td><td className="num-cell">{product.decantSizeMl ? `${product.decantSizeMl} ml` : "—"}</td><td><input type="number" min="1" step="1" value={line.quantity} onChange={event => patch(line.key, { quantity: event.target.value })}/></td><td><input type="number" min="0" value={line.unitPrice} onChange={event => patch(line.key, { unitPrice: event.target.value })}/></td><td className="num-cell">{money(n(line.quantity) * n(line.unitPrice))}</td><td><button className="soft" type="button" onClick={() => remove(line.key)}>{tr("حذف")}</button></td></tr>; })}</tbody></table></div>
      {localError && <div className="error">{localError}</div>}
      <div className="decant-invoice-actions"><button className="primary" type="button" disabled={busy || !lines.length} onClick={() => void submit()}>{busy ? tr("جاري الحفظ…") : tr("اعتماد فاتورة شراء الزجاج")}</button></div>
    </section>
    <InvoiceHistory documents={recent} openDoc={openDoc} onVoid={voidInvoice} busy={busy}/>
  </div>;
}
