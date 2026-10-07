"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Banknote, PencilLine, X } from "lucide-react";
import {
  activePaymentAccounts,
  activeProducts,
  displayDocumentNumber,
  money,
  quantity,
  stockInWarehouse,
  type BootstrapData,
  type DocumentRecord,
} from "./domain";
import { tr } from "./i18n/messages";
import PerfumeProductPicker, { type PerfumePickerItem } from "./perfume-product-picker";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;
type Props = { data: BootstrapData; run: RunCommand; openDoc: (id: string) => void };
type DraftLine = { key: string; productId: string; quantity: string; unitPrice: string; bottleProductId: string };

const lineKey = () => crypto.randomUUID();
const n = (value: string) => value.trim() === "" ? 0 : Number(value);

function InvoicePanel({ title, className = "", children }: { title: string; className?: string; children: ReactNode }) {
  return <fieldset className={"erp-fieldset " + className}><legend>{title}</legend>{children}</fieldset>;
}

function InvoiceToolbar({ number: invoiceNumber, onNew }: { number: string; onNew: () => void }) {
  return <div className="invoice-editor-toolbar">
    <div className="invoice-toolbar-main">
      <button type="button" className="invoice-new-button" onClick={onNew}>{tr("فاتورة جديدة")}</button>
      <span className="invoice-number-status">{tr("رقم")} <b>{invoiceNumber}</b></span>
    </div>
  </div>;
}

function PaymentModeButtons({ note, onDirect, onNote }: { note: boolean; onDirect: () => void; onNote: () => void }) {
  return <div className="invoice-meta-row" aria-label={tr("نوع الفاتورة")}>
    <button type="button" className="meta-option selection-option" aria-pressed={!note} onClick={onDirect}>
      <Banknote/><span><small>{tr("طريقة التحصيل")}</small><b>{tr("دفع مباشر")}</b></span>
    </button>
    <button type="button" className="meta-option selection-option secondary" aria-pressed={note} onClick={onNote}>
      <PencilLine/><span><small>{tr("نوع البيع")}</small><b>{tr("ملاحظة")}</b></span>
    </button>
  </div>;
}

function InvoiceHistory({
  title,
  emptyLabel,
  documents,
  openDoc,
  onVoid,
  busy,
}: {
  title: string;
  emptyLabel: string;
  documents: DocumentRecord[];
  openDoc: (id: string) => void;
  onVoid: (document: DocumentRecord) => void;
  busy: boolean;
}) {
  return <InvoicePanel title={title} className="quick-invoices decant-quick-invoices">
    <div className="erp-table-wrap quick-invoice-list">
      <table className="erp-table">
        <colgroup><col style={{width:"20%"}}/><col style={{width:"24%"}}/><col style={{width:"24%"}}/><col style={{width:"18%"}}/><col style={{width:"14%"}}/></colgroup>
        <thead><tr><th>{tr("رقم الفاتورة")}</th><th>{tr("التاريخ")}</th><th>{tr("الحالة / العميل")}</th><th>{tr("المبلغ")}</th><th>{tr("إجراء")}</th></tr></thead>
        <tbody>{documents.length === 0 ? <tr><td colSpan={5}>{emptyLabel}</td></tr> : documents.map(document => <tr key={document.id} onClick={() => openDoc(document.id)}>
          <td dir="ltr">{displayDocumentNumber(document)}</td>
          <td>{new Date(document.occurredAt).toLocaleDateString()}</td>
          <td>{document.partyName || (document.kind === "decant-sale" ? tr("بيع تقسيمات مباشر") : tr("شراء زجاج مباشر"))} · {document.status === "posted" ? tr("معتمدة") : tr("ملغاة")}</td>
          <td className="num-cell">{money(document.total)}</td>
          <td className="action-cell">{document.status === "posted" && <button className="soft danger-text" type="button" disabled={busy} onClick={event => { event.stopPropagation(); onVoid(document); }}>{tr("إلغاء الفاتورة")}</button>}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </InvoicePanel>;
}

export function DecantSaleInvoice({ data, run, openDoc }: Props) {
  const defaultWarehouse = data.warehouses.find(warehouse => warehouse.isSalesDefault && warehouse.isArchived !== true) ?? null;
  const warehouseId = defaultWarehouse?.id ?? "";
  const accounts = activePaymentAccounts(data.paymentAccounts);
  const customers = data.parties.filter(party => party.partyType === "customer" && party.isArchived !== true);
  const decants = useMemo(() => activeProducts(data.products).filter(product => product.perfumeForm === "decant"), [data.products]);
  const bottles = useMemo(() => activeProducts(data.products).filter(product => product.perfumeForm === "bottle"), [data.products]);
  const saleProducts = useMemo(() => [...decants, ...bottles], [decants, bottles]);
  const recent = useMemo(() => data.documents.filter(document => document.kind === "decant-sale").slice(0, 20), [data.documents]);
  const [paymentMethod, setPaymentMethod] = useState("");
  const [partyId, setPartyId] = useState("");
  const [productId, setProductId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const total = lines.reduce((sum, line) => sum + n(line.quantity) * n(line.unitPrice), 0);
  const pickerItems = useMemo<PerfumePickerItem[]>(() => saleProducts.map(product => ({
    id: product.id,
    name: product.name,
    group: product.perfumeForm === "decant" ? tr("عطور التقسيمات") : tr("زجاج التقسيمات"),
    meta: tr("المتوفر") + ": " + quantity(stockInWarehouse(product, warehouseId)),
    disabled: stockInWarehouse(product, warehouseId) <= 0,
  })), [saleProducts, warehouseId]);

  const reset = () => { setLines([]); setPartyId(""); setPaymentMethod(""); setProductId(""); setLocalError(""); };
  const add = () => {
    const product = saleProducts.find(item => item.id === productId);
    if (!product || lines.some(line => line.productId === product.id)) return;
    setLines(current => [...current, { key: lineKey(), productId: product.id, quantity: "1", unitPrice: String(product.piecePrice ?? 0), bottleProductId: "" }]);
    setProductId("");
    setLocalError("");
  };
  const patch = (key: string, value: Partial<DraftLine>) => setLines(current => current.map(line => line.key === key ? { ...line, ...value } : line));
  const remove = (key: string) => setLines(current => current.filter(line => line.key !== key));

  const submit = async () => {
    setLocalError("");
    if (!defaultWarehouse) { setLocalError("عيّن مخزن البيع الافتراضي من إدارة المخازن أولًا."); return; }
    if (!lines.length) { setLocalError(tr("أضف منتجًا")); return; }
    if (paymentMethod === "note" && !partyId) { setLocalError(tr("اختر عميلاً عند البيع الآجل")); return; }
    if (paymentMethod !== "note" && !paymentMethod) { setLocalError(tr("اختر وسيلة الدفع")); return; }
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
      await run({
        type: "decant-sale.post",
        paymentMethod,
        partyId: partyId || null,
        cashAmount: paymentMethod === "note" ? 0 : total,
        lines: lines.map(line => ({ productId: line.productId, quantity: n(line.quantity), unitPrice: n(line.unitPrice), bottleProductId: line.bottleProductId || null })),
      }, tr("تم اعتماد فاتورة التقسيمات"));
      reset();
    } finally { setBusy(false); }
  };
  const voidInvoice = async (document: DocumentRecord) => {
    if (!window.confirm(tr("إلغاء الفاتورة") + " " + displayDocumentNumber(document) + "؟")) return;
    setBusy(true);
    try { await run({ type: "decant-sale.void", documentId: document.id }, tr("تم إلغاء فاتورة التقسيمات")); }
    finally { setBusy(false); }
  };

  return <section className="transaction-page decant-transaction-page">
    {localError && <div className="toast stock-toast decant-invoice-error">{localError}</div>}
    <div className="transaction-workspace decant-sale-workspace">
      <div className="workspace-discovery">
        <InvoicePanel title={tr("بحث المنتجات")} className="search-panel decant-search-panel">
          <div className="decant-search-controls">
            <PerfumeProductPicker items={pickerItems} value={productId} onChange={setProductId} placeholder={tr("اختر منتج التقسيمات")} ariaLabel={tr("المنتج أو الزجاجة")}/>
            <button className="soft" type="button" disabled={!productId} onClick={add}>{tr("إضافة")}</button>
          </div>
        </InvoicePanel>
        <InvoiceHistory title={tr("سجل الفواتير")} emptyLabel={tr("لا توجد فواتير تقسيمات حتى الآن")} documents={recent} openDoc={openDoc} onVoid={voidInvoice} busy={busy}/>
      </div>

      <InvoicePanel title={tr("فاتورة بيع")} className="invoice-card workspace-invoice">
        <InvoiceToolbar number={String(data.nextDocumentSequences.decantSale)} onNew={reset}/>
        <div className={lines.length ? "invoice-preview has-items" : "invoice-preview"}>
          <div className="erp-table-wrap invoice-preview-list">
            <table className="erp-table invoice-table" aria-label={tr("فاتورة التقسيمات")}>
              <thead><tr><th>{tr("الاسم")}</th><th>{tr("الكمية")}</th><th>{tr("السعر")}</th><th>{tr("زجاجة التقسيمة")}</th><th>{tr("المجموع")}</th><th>{tr("حذف")}</th></tr></thead>
              <tbody>{lines.length === 0 ? <tr className="invoice-empty-row"><td colSpan={6}>{tr("الفاتورة فارغة")}</td></tr> : lines.map(line => {
                const product = saleProducts.find(item => item.id === line.productId)!;
                const isDecant = product.perfumeForm === "decant";
                return <tr key={line.key}>
                  <td className="name-cell">{product.name}</td>
                  <td className="num-cell"><input className="num" dir="ltr" type="number" min="1" step="1" value={line.quantity} onChange={event => patch(line.key, { quantity: event.target.value })}/></td>
                  <td className="num-cell"><input className="num" dir="ltr" type="number" min="0" value={line.unitPrice} onChange={event => patch(line.key, { unitPrice: event.target.value })}/></td>
                  <td>{isDecant ? <select value={line.bottleProductId} onChange={event => patch(line.key, { bottleProductId: event.target.value })}><option value="">{tr("اختر الزجاجة")}</option>{bottles.map(bottle => <option key={bottle.id} value={bottle.id} disabled={stockInWarehouse(bottle, warehouseId) < n(line.quantity)}>{bottle.name + " · " + (bottle.decantSizeMl ? bottle.decantSizeMl + " ml · " : "") + quantity(stockInWarehouse(bottle, warehouseId))}</option>)}</select> : <span className="muted">{tr("بيع فارغ")}</span>}</td>
                  <td className="num-cell">{money(n(line.quantity) * n(line.unitPrice))}</td>
                  <td className="action-cell"><button type="button" className="row-delete" aria-label={tr("حذف")} onClick={() => remove(line.key)}><X/></button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </div>
      </InvoicePanel>

      <InvoicePanel title={tr("الدفع")} className="workspace-checkout decant-checkout">
        <div className="checkout-layout">
          <div className="checkout-body">
            <PaymentModeButtons
              note={paymentMethod === "note"}
              onDirect={() => setPaymentMethod(paymentMethod === "note" ? (accounts[0]?.id ?? "") : paymentMethod)}
              onNote={() => setPaymentMethod("note")}
            />
            {paymentMethod !== "note" && <label>{tr("طريقة الدفع")}<select value={paymentMethod} onChange={event => setPaymentMethod(event.target.value)}><option value="">{tr("اختر وسيلة الدفع")}</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}
            <label>{tr("العميل")}<select value={partyId} onChange={event => setPartyId(event.target.value)}><option value="">{paymentMethod === "note" ? tr("اختر العميل") : tr("بيع تقسيمات مباشر")}</option>{customers.map(customer => <option key={customer.id} value={customer.id}>{customer.name}</option>)}</select></label>
            <div className="checkout-invoice-actions"><button type="button" className="invoice-void" disabled={!lines.length} onClick={reset}>{tr("حذف المسودة")}</button></div>
          </div>
          <div className="checkout-footer">
            <div className="total invoice-total"><span>{tr("الإجمالي")}</span><strong>{money(total)}</strong></div>
            <button className="primary wide" type="button" disabled={busy || !lines.length || !defaultWarehouse || (paymentMethod === "note" ? !partyId : !paymentMethod)} onClick={() => void submit()}>{busy ? tr("جاري الحفظ…") : tr("إتمام البيع")}</button>
          </div>
        </div>
      </InvoicePanel>
    </div>
  </section>;
}

export function DecantBottlePurchaseInvoice({ data, run, openDoc }: Props) {
  const defaultWarehouse = data.warehouses.find(warehouse => warehouse.isSalesDefault && warehouse.isArchived !== true) ?? null;
  const accounts = activePaymentAccounts(data.paymentAccounts);
  const suppliers = data.parties.filter(party => party.partyType === "supplier" && party.isArchived !== true);
  const bottles = useMemo(() => activeProducts(data.products).filter(product => product.perfumeForm === "bottle"), [data.products]);
  const recent = useMemo(() => data.documents.filter(document => document.kind === "decant-purchase").slice(0, 20), [data.documents]);
  const [paymentMethod, setPaymentMethod] = useState("");
  const [partyId, setPartyId] = useState("");
  const [productId, setProductId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const total = lines.reduce((sum, line) => sum + n(line.quantity) * n(line.unitPrice), 0);
  const pickerItems = useMemo<PerfumePickerItem[]>(() => bottles.map(product => ({
    id: product.id,
    name: product.name,
    group: tr("زجاج التقسيمات"),
    meta: product.decantSizeMl ? String(product.decantSizeMl) + " ml" : "",
  })), [bottles]);

  const reset = () => { setLines([]); setPartyId(""); setPaymentMethod(""); setProductId(""); setLocalError(""); };
  const add = () => {
    const product = bottles.find(item => item.id === productId);
    if (!product || lines.some(line => line.productId === product.id)) return;
    setLines(current => [...current, { key: lineKey(), productId: product.id, quantity: "1", unitPrice: String(product.lastPurchaseCost ?? product.pieceCost ?? 0), bottleProductId: "" }]);
    setProductId("");
    setLocalError("");
  };
  const patch = (key: string, value: Partial<DraftLine>) => setLines(current => current.map(line => line.key === key ? { ...line, ...value } : line));
  const remove = (key: string) => setLines(current => current.filter(line => line.key !== key));

  const submit = async () => {
    setLocalError("");
    if (!defaultWarehouse) { setLocalError("عيّن مخزن البيع الافتراضي من إدارة المخازن أولًا."); return; }
    if (!lines.length) { setLocalError(tr("أضف زجاجة")); return; }
    if (paymentMethod === "note" && !partyId) { setLocalError(tr("اختر موردًا عند الشراء الآجل")); return; }
    if (paymentMethod !== "note" && !paymentMethod) { setLocalError(tr("اختر وسيلة الدفع")); return; }
    if (lines.some(line => !Number.isInteger(n(line.quantity)) || n(line.quantity) <= 0 || n(line.unitPrice) <= 0)) { setLocalError(tr("راجع الكمية وسعر الشراء")); return; }
    setBusy(true);
    try {
      await run({
        type: "decant-purchase.post",
        paymentMethod,
        partyId: partyId || null,
        cashAmount: paymentMethod === "note" ? 0 : total,
        lines: lines.map(line => ({ productId: line.productId, quantity: n(line.quantity), unitPrice: n(line.unitPrice) })),
      }, tr("تم اعتماد فاتورة شراء زجاج التقسيمات"));
      reset();
    } finally { setBusy(false); }
  };
  const voidInvoice = async (document: DocumentRecord) => {
    if (!window.confirm(tr("إلغاء الفاتورة") + " " + displayDocumentNumber(document) + "؟")) return;
    setBusy(true);
    try { await run({ type: "decant-purchase.void", documentId: document.id }, tr("تم إلغاء فاتورة شراء زجاج التقسيمات")); }
    finally { setBusy(false); }
  };

  return <section className="transaction-page decant-transaction-page">
    {localError && <div className="toast stock-toast decant-invoice-error">{localError}</div>}
    <div className="transaction-workspace decant-purchase-workspace">
      <div className="workspace-discovery">
        <InvoicePanel title={tr("بحث المنتجات")} className="search-panel decant-search-panel">
          <div className="decant-search-controls">
            <PerfumeProductPicker items={pickerItems} value={productId} onChange={setProductId} placeholder={tr("اختر الزجاجة")} ariaLabel={tr("زجاجة التقسيمة")}/>
            <button className="soft" type="button" disabled={!productId} onClick={add}>{tr("إضافة")}</button>
          </div>
        </InvoicePanel>
        <InvoiceHistory title={tr("سجل فواتير الشراء")} emptyLabel={tr("لا توجد فواتير تقسيمات حتى الآن")} documents={recent} openDoc={openDoc} onVoid={voidInvoice} busy={busy}/>
      </div>

      <InvoicePanel title={tr("فاتورة شراء")} className="invoice-card workspace-invoice">
        <InvoiceToolbar number={String(data.nextDocumentSequences.decantPurchase)} onNew={reset}/>
        <div className={lines.length ? "invoice-preview has-items" : "invoice-preview"}>
          <div className="erp-table-wrap invoice-preview-list">
            <table className="erp-table invoice-table" aria-label={tr("فاتورة شراء زجاج التقسيمات")}>
              <thead><tr><th>{tr("الاسم")}</th><th>{tr("الحجم")}</th><th>{tr("الكمية")}</th><th>{tr("سعر الشراء")}</th><th>{tr("المجموع")}</th><th>{tr("حذف")}</th></tr></thead>
              <tbody>{lines.length === 0 ? <tr className="invoice-empty-row"><td colSpan={6}>{tr("الفاتورة فارغة")}</td></tr> : lines.map(line => {
                const product = bottles.find(item => item.id === line.productId)!;
                return <tr key={line.key}>
                  <td className="name-cell">{product.name}</td>
                  <td className="num-cell">{product.decantSizeMl ? String(product.decantSizeMl) + " ml" : "—"}</td>
                  <td className="num-cell"><input className="num" dir="ltr" type="number" min="1" step="1" value={line.quantity} onChange={event => patch(line.key, { quantity: event.target.value })}/></td>
                  <td className="num-cell"><input className="num" dir="ltr" type="number" min="0" value={line.unitPrice} onChange={event => patch(line.key, { unitPrice: event.target.value })}/></td>
                  <td className="num-cell">{money(n(line.quantity) * n(line.unitPrice))}</td>
                  <td className="action-cell"><button type="button" className="row-delete" aria-label={tr("حذف")} onClick={() => remove(line.key)}><X/></button></td>
                </tr>;
              })}</tbody>
            </table>
          </div>
        </div>
      </InvoicePanel>

      <InvoicePanel title={tr("الدفع")} className="workspace-checkout decant-checkout">
        <div className="checkout-layout">
          <div className="checkout-body purchase-details">
            <PaymentModeButtons
              note={paymentMethod === "note"}
              onDirect={() => setPaymentMethod(paymentMethod === "note" ? (accounts[0]?.id ?? "") : paymentMethod)}
              onNote={() => setPaymentMethod("note")}
            />
            {paymentMethod !== "note" && <label>{tr("طريقة الدفع")}<select value={paymentMethod} onChange={event => setPaymentMethod(event.target.value)}><option value="">{tr("اختر وسيلة الدفع")}</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}
            <label>{tr("المورد")}<select value={partyId} onChange={event => setPartyId(event.target.value)}><option value="">{paymentMethod === "note" ? tr("اختر المورد") : tr("شراء زجاج مباشر")}</option>{suppliers.map(supplier => <option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
            <div className="checkout-invoice-actions"><button type="button" className="invoice-void" disabled={!lines.length} onClick={reset}>{tr("حذف المسودة")}</button></div>
          </div>
          <div className="checkout-footer">
            <div className="total invoice-total"><span>{tr("الإجمالي")}</span><strong>{money(total)}</strong></div>
            <button className="primary wide" type="button" disabled={busy || !defaultWarehouse || !lines.length || (paymentMethod === "note" ? !partyId : !paymentMethod)} onClick={() => void submit()}>{busy ? tr("جاري الحفظ…") : tr("إتمام الشراء")}</button>
          </div>
        </div>
      </InvoicePanel>
    </div>
  </section>;
}
