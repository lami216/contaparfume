"use client";

import { useMemo, useState } from "react";
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
  const [productId, setProductId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]), [busy, setBusy] = useState(false), [localError, setLocalError] = useState("");
  const warehouse = warehouses.find(item => item.id === warehouseId);
  const total = lines.reduce((sum, line) => sum + n(line.quantity) * n(line.unitPrice), 0);

  const add = () => {
    const product = saleProducts.find(item => item.id === productId); if (!product) return;
    if (lines.some(line => line.productId === product.id)) return;
    setLines(current => [...current, { key: lineKey(), productId: product.id, quantity: "1", unitPrice: String(product.piecePrice ?? 0), bottleProductId: "" }]);
    setProductId(""); setLocalError("");
  };
  const patch = (key: string, value: Partial<DraftLine>) => setLines(current => current.map(line => line.key === key ? { ...line, ...value } : line));
  const remove = (key: string) => setLines(current => current.filter(line => line.key !== key));

  const submit = async () => {
    setLocalError("");
    if (!warehouseId || !lines.length) { setLocalError(tr("أضف منتجًا واختر المخزن")); return; }
    if (paymentMethod === "note" && !partyId) { setLocalError(tr("اختر عميلاً عند البيع الآجل")); return; }
    for (const line of lines) {
      const product = saleProducts.find(item => item.id === line.productId);
      if (!product || !Number.isInteger(n(line.quantity)) || n(line.quantity) <= 0 || n(line.unitPrice) <= 0) { setLocalError(tr("راجع الكمية والسعر في الفاتورة")); return; }
      if (product.perfumeForm === "decant" && !line.bottleProductId) { setLocalError(tr("اختر زجاجة لكل عطر تقسيمات")); return; }
      if (stockInWarehouse(product, warehouseId) < n(line.quantity)) { setLocalError(tr("الكمية المطلوبة أكبر من المتوفر")); return; }
      if (product.perfumeForm === "decant") {
        const bottle = bottles.find(item => item.id === line.bottleProductId);
        if (!bottle || stockInWarehouse(bottle, warehouseId) < n(line.quantity)) { setLocalError(tr("مخزون زجاج التقسيمات غير كافٍ")); return; }
      }
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
      <div className="decant-add-row"><label>{tr("المنتج أو الزجاجة")}<select value={productId} onChange={event => setProductId(event.target.value)}><option value="">{tr("اختر منتج التقسيمات")}</option><optgroup label={tr("عطور التقسيمات")}>{decants.map(product => <option key={product.id} value={product.id} disabled={stockInWarehouse(product, warehouseId) <= 0}>{product.name} — {quantity(stockInWarehouse(product, warehouseId))}</option>)}</optgroup><optgroup label={tr("زجاج التقسيمات")}>{bottles.map(product => <option key={product.id} value={product.id} disabled={stockInWarehouse(product, warehouseId) <= 0}>{product.name} — {quantity(stockInWarehouse(product, warehouseId))}</option>)}</optgroup></select></label><button className="soft" type="button" disabled={!productId} onClick={add}>{tr("إضافة")}</button></div>
      <div className="decant-lines-scroll"><table className="erp-table decant-lines-table"><thead><tr><th>{tr("المنتج")}</th><th>{tr("الكمية")}</th><th>{tr("سعر البيع")}</th><th>{tr("زجاجة التقسيمة")}</th><th>{tr("المتوفر")}</th><th>{tr("الإجمالي")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>{lines.length === 0 ? <tr><td colSpan={7}>{tr("أضف عطر تقسيمات أو زجاجة فارغة")}</td></tr> : lines.map(line => { const product = saleProducts.find(item => item.id === line.productId)!; const isDecant = product.perfumeForm === "decant"; return <tr key={line.key}><td>{product.name}</td><td><input type="number" min="1" step="1" value={line.quantity} onChange={event => patch(line.key, { quantity: event.target.value })}/></td><td><input type="number" min="0" value={line.unitPrice} onChange={event => patch(line.key, { unitPrice: event.target.value })}/></td><td>{isDecant ? <select value={line.bottleProductId} onChange={event => patch(line.key, { bottleProductId: event.target.value })}><option value="">{tr("اختر الزجاجة")}</option>{bottles.map(bottle => <option key={bottle.id} value={bottle.id} disabled={stockInWarehouse(bottle, warehouseId) < n(line.quantity)}>{bottle.name} · {bottle.decantSizeMl ? `${bottle.decantSizeMl} ml` : ""} · {quantity(stockInWarehouse(bottle, warehouseId))}</option>)}</select> : <span className="muted">{tr("بيع فارغ")}</span>}</td><td className="num-cell">{quantity(stockInWarehouse(product, warehouseId))}</td><td className="num-cell">{money(n(line.quantity) * n(line.unitPrice))}</td><td><button className="soft" type="button" onClick={() => remove(line.key)}>{tr("حذف")}</button></td></tr>; })}</tbody></table></div>
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
  const [lines, setLines] = useState<DraftLine[]>([]), [busy, setBusy] = useState(false), [localError, setLocalError] = useState("");
  const total = lines.reduce((sum, line) => sum + n(line.quantity) * n(line.unitPrice), 0);
  const add = () => { const product = bottles.find(item => item.id === productId); if (!product || lines.some(line => line.productId === product.id)) return; setLines(current => [...current, { key: lineKey(), productId: product.id, quantity: "1", unitPrice: String(product.lastPurchaseCost ?? product.pieceCost ?? 0), bottleProductId: "" }]); setProductId(""); };
  const patch = (key: string, value: Partial<DraftLine>) => setLines(current => current.map(line => line.key === key ? { ...line, ...value } : line));
  const remove = (key: string) => setLines(current => current.filter(line => line.key !== key));
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
      <div className="decant-add-row"><label>{tr("زجاجة التقسيمة")}<select value={productId} onChange={event => setProductId(event.target.value)}><option value="">{tr("اختر الزجاجة")}</option>{bottles.map(product => <option key={product.id} value={product.id}>{product.name}{product.decantSizeMl ? ` · ${product.decantSizeMl} ml` : ""}</option>)}</select></label><button className="soft" type="button" disabled={!productId} onClick={add}>{tr("إضافة")}</button></div>
      <div className="decant-lines-scroll"><table className="erp-table decant-lines-table"><thead><tr><th>{tr("الزجاجة")}</th><th>{tr("الحجم")}</th><th>{tr("الكمية")}</th><th>{tr("سعر الشراء")}</th><th>{tr("الإجمالي")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>{lines.length === 0 ? <tr><td colSpan={6}>{tr("أضف زجاجة إلى فاتورة الشراء")}</td></tr> : lines.map(line => { const product = bottles.find(item => item.id === line.productId)!; return <tr key={line.key}><td>{product.name}</td><td className="num-cell">{product.decantSizeMl ? `${product.decantSizeMl} ml` : "—"}</td><td><input type="number" min="1" step="1" value={line.quantity} onChange={event => patch(line.key, { quantity: event.target.value })}/></td><td><input type="number" min="0" value={line.unitPrice} onChange={event => patch(line.key, { unitPrice: event.target.value })}/></td><td className="num-cell">{money(n(line.quantity) * n(line.unitPrice))}</td><td><button className="soft" type="button" onClick={() => remove(line.key)}>{tr("حذف")}</button></td></tr>; })}</tbody></table></div>
      {localError && <div className="error">{localError}</div>}
      <div className="decant-invoice-actions"><button className="primary" type="button" disabled={busy || !lines.length} onClick={() => void submit()}>{busy ? tr("جاري الحفظ…") : tr("اعتماد فاتورة شراء الزجاج")}</button></div>
    </section>
    <InvoiceHistory documents={recent} openDoc={openDoc} onVoid={voidInvoice} busy={busy}/>
  </div>;
}
