"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Banknote, PencilLine, Plus, X } from "lucide-react";
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
import { filterDocumentsByDate, localBusinessDay } from "./history-filters";
import { SortableTableHeader, useSortableRows } from "./table-sorting";
import { canUseCapability } from "./transaction-ui";
import PerfumeProductPicker, { type PerfumePickerItem } from "./perfume-product-picker";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;
type Props = { data: BootstrapData; run: RunCommand; openDoc: (id: string) => void; requestPrint: (id: string) => void };
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

function PaymentModeButtons({ note, onDirect, onNote, purchase = false }: { note: boolean; onDirect: () => void; onNote: () => void; purchase?: boolean }) {
  return <div className="invoice-meta-row" aria-label={tr("نوع الفاتورة")}>
    <button type="button" className="meta-option selection-option" aria-pressed={!note} onClick={onDirect}>
      <Banknote/><span><small>{tr("طريقة التحصيل")}</small><b>{tr("دفع مباشر")}</b></span>
    </button>
    <button type="button" className="meta-option selection-option secondary" aria-pressed={note} onClick={onNote}>
      <PencilLine/><span><small>{purchase ? tr("نوع التسوية") : tr("نوع البيع")}</small><b>{tr("ملاحظة")}</b></span>
    </button>
  </div>;
}

type PartyOption = { id: string; name: string; phone?: string };

function QuickInvoiceParty({ kind, run, anchor, onDone, close }: {
  kind: "customer" | "supplier"; run: RunCommand;
  anchor: RefObject<HTMLButtonElement | null>; onDone: (id: string) => void; close: () => void;
}) {
  const [name, setName] = useState(""), [phone, setPhone] = useState(""), [saving, setSaving] = useState(false);
  const rect = anchor.current?.getBoundingClientRect();
  const style: CSSProperties = rect
    ? { position: "fixed", zIndex: 1100, width: 250, top: rect.bottom + 5, left: Math.max(8, rect.right - 250) }
    : {};
  const isCustomer = kind === "customer";
  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving || !name.trim()) return;
    setSaving(true);
    try {
      const id = await run({ type: "party.create", partyType: kind, name: name.trim(), phone: phone.trim() },
        isCustomer ? tr("تمت إضافة العميل") : tr("تمت إضافة المورد"));
      if (typeof id === "string" && id) onDone(id);
    } finally { setSaving(false); }
  };
  return createPortal(<form className="pos-quick-customer-popover" style={style} onSubmit={event => void submit(event)}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); close(); anchor.current?.focus(); } }}>
    <label>{isCustomer ? tr("اسم العميل") : tr("اسم المورد *")}<input autoFocus required value={name} onChange={event => setName(event.target.value)}/></label>
    <label>{tr("رقم الهاتف")} <small>{tr("اختياري")}</small><input dir="ltr" value={phone} onChange={event => setPhone(event.target.value)}/></label>
    <div><button className="primary" disabled={saving || !name.trim()}>{tr("حفظ")}</button>
      <button className="soft" type="button" onClick={close}>{tr("إلغاء")}</button></div>
  </form>, document.body);
}

function InvoicePartyPicker({ partyId, onChange, parties, isCustomer, note, run, canCreate }: {
  partyId: string; onChange: (value: string) => void; parties: PartyOption[];
  isCustomer: boolean; note: boolean; run: RunCommand; canCreate: boolean;
}) {
  const [quick, setQuick] = useState(false), [open, setOpen] = useState(false), [search, setSearch] = useState("");
  const buttonRef = useRef<HTMLButtonElement>(null), pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (event: MouseEvent) => { if (!pickerRef.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, []);
  const selected = parties.find(party => party.id === partyId);
  const display = selected?.name ?? (note ? (isCustomer ? tr("اختر العميل") : tr("اختر المورد")) :
    (isCustomer ? tr("بيع تقسيمات مباشر") : tr("شراء زجاج مباشر")));
  const visible = parties.filter(party => (party.name + " " + (party.phone ?? "")).toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <div className="decant-party-row">
    <div ref={pickerRef} className="decant-party-picker">
      <button type="button" className="combobox-trigger" aria-expanded={open} aria-label={isCustomer ? tr("العميل") : tr("المورد")}
        onClick={() => setOpen(value => !value)}>{display}</button>
      {open && <div className="decant-party-options">
        <input autoFocus type="search" aria-label={tr("بحث بالاسم أو الهاتف")} placeholder={tr("بحث بالاسم أو الهاتف")}
          value={search} onChange={event => setSearch(event.target.value)}
          onKeyDown={event => { if (event.key === "Escape") setOpen(false); }}/>
        {!note && <button type="button" onClick={() => { onChange(""); setOpen(false); setSearch(""); }}>
          {isCustomer ? tr("بيع تقسيمات مباشر") : tr("شراء زجاج مباشر")}</button>}
        {visible.map(party => <button type="button" key={party.id} onClick={() => { onChange(party.id); setOpen(false); setSearch(""); }}>
          {party.name}{party.phone ? <small dir="ltr">{party.phone}</small> : null}</button>)}
        {!visible.length && <div className="decant-party-empty">{tr("لا توجد نتائج")}</div>}
      </div>}
    </div>
    {canCreate && <button ref={buttonRef} type="button" className="pos-quick-customer-button"
      aria-label={isCustomer ? tr("إضافة العميل") : tr("إضافة المورد")}
      title={isCustomer ? tr("إضافة العميل") : tr("إضافة المورد")}
      onClick={() => { setOpen(false); setQuick(value => !value); }}><Plus/></button>}
    {quick && canCreate && <QuickInvoiceParty kind={isCustomer ? "customer" : "supplier"} run={run} anchor={buttonRef}
      close={() => setQuick(false)} onDone={id => { onChange(id); setQuick(false); }}/>}
  </div>;
}

function InvoiceHistory({ title, emptyLabel, documents, openDoc, onVoid, busy, kind }: {
  title: string; emptyLabel: string; documents: DocumentRecord[];
  openDoc: (id: string) => void; onVoid: (document: DocumentRecord) => void; busy: boolean;
  kind: "sale" | "purchase";
}) {
  const today = localBusinessDay(), [from, setFrom] = useState(today), [to, setTo] = useState(today),
    [allTime, setAllTime] = useState(false);
  const visible = filterDocumentsByDate(documents.filter(document => document.status === "posted"), from, to, allTime);
  const statusParty = (document: DocumentRecord) => {
    const isNote = document.paymentMethod === "note" || Number(document.dueTotal ?? 0) > 0;
    const party = document.partyName?.trim() || (kind === "sale" ? tr("بيع تقسيمات مباشر") : tr("شراء زجاج مباشر"));
    return party + " · " + (isNote ? tr("ملاحظة") : tr("مدفوعة"));
  };
  const columns = useMemo(() => [
    { key: "number", type: "number" as const, get: (document: DocumentRecord) => document.sequence ?? document.number },
    { key: "party", type: "text" as const, get: (document: DocumentRecord) => statusParty(document) },
    { key: "total", type: "money" as const, get: (document: DocumentRecord) => document.total },
  ], [kind]);
  const { sort, sortedRows, toggle } = useSortableRows(visible, columns);
  return <InvoicePanel title={title} className="quick-invoices decant-quick-invoices">
    <div className="quick-invoice-head decant-history-dates">
      <label>{tr("من")}<input type="date" value={allTime ? "" : from} onChange={event => { setFrom(event.target.value); setAllTime(false); }}/></label>
      <label>{tr("إلى")}<input type="date" value={allTime ? "" : to} onChange={event => { setTo(event.target.value); setAllTime(false); }}/></label>
      <button type="button" className="soft" aria-pressed={allTime} onClick={() => setAllTime(true)}>{tr("كل الوقت")}</button>
    </div>
    <div className="erp-table-wrap quick-invoice-list">
      <table className="erp-table">
        <colgroup><col style={{ width: "28%" }}/><col style={{ width: "46%" }}/><col style={{ width: "26%" }}/></colgroup>
        <thead><tr><SortableTableHeader column="number" label={tr("رقم الفاتورة")} sort={sort} toggle={toggle}/>
          <SortableTableHeader column="party" label={tr("الحالة / العميل")} sort={sort} toggle={toggle}/>
          <SortableTableHeader column="total" label={tr("المبلغ")} sort={sort} toggle={toggle}/></tr></thead>
        <tbody>{sortedRows.map(document => <tr key={document.id} onClick={() => openDoc(document.id)}>
          <td dir="ltr">{displayDocumentNumber(document)}</td>
          <td><div className="decant-history-party"><span>{statusParty(document)}</span>
            <button className="soft danger-text" type="button" disabled={busy}
              aria-label={tr("إلغاء الفاتورة") + " " + displayDocumentNumber(document)}
              onClick={event => { event.stopPropagation(); onVoid(document); }}>{tr("إلغاء الفاتورة")}</button></div></td>
          <td className="num-cell">{money(document.total)}</td>
        </tr>)}{!sortedRows.length && <tr><td colSpan={3}>{allTime ? emptyLabel : tr("لا توجد فواتير في هذه الفترة")}</td></tr>}</tbody>
      </table>
    </div>
  </InvoicePanel>;
}

export function DecantSaleInvoice({ data, run, openDoc, requestPrint }: Props) {
  const defaultWarehouse = data.warehouses.find(warehouse => warehouse.isSalesDefault && warehouse.isArchived !== true) ?? null;
  const warehouseId = defaultWarehouse?.id ?? "";
  const accounts = activePaymentAccounts(data.paymentAccounts);
  const customers = data.parties.filter(party => party.partyType === "customer" && party.isArchived !== true);
  const decants = useMemo(() => activeProducts(data.products).filter(product => product.perfumeForm === "decant"), [data.products]);
  const bottles = useMemo(() => activeProducts(data.products).filter(product => product.perfumeForm === "bottle"), [data.products]);
  const saleProducts = useMemo(() => [...decants, ...bottles], [decants, bottles]);
  const recent = useMemo(() => data.documents.filter(document => document.kind === "decant-sale"), [data.documents]);
  const [paymentMethod, setPaymentMethod] = useState("");
  const [partyId, setPartyId] = useState("");
  const [productId, setProductId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [printAfterSave, setPrintAfterSave] = useState(false);
  const total = lines.reduce((sum, line) => sum + n(line.quantity) * n(line.unitPrice), 0);
  const pickerItems = useMemo<PerfumePickerItem[]>(() => saleProducts.map(product => ({
    id: product.id,
    name: product.name,
    group: product.perfumeForm === "decant" ? tr("عطور التقسيمات") : tr("زجاج التقسيمات"),
    meta: tr("المتوفر") + ": " + quantity(stockInWarehouse(product, warehouseId)),
    disabled: stockInWarehouse(product, warehouseId) <= 0,
  })), [saleProducts, warehouseId]);

  const reset = () => { setLines([]); setPartyId(""); setPaymentMethod(""); setProductId(""); setLocalError(""); };
  const newInvoice = () => { if (!lines.length && !partyId && !paymentMethod || window.confirm(tr("لديك تغييرات غير محفوظة. هل تريد بدء فاتورة جديدة؟"))) reset(); };
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
      const savedId = await run({
        type: "decant-sale.post",
        paymentMethod,
        partyId: partyId || null,
        cashAmount: paymentMethod === "note" ? 0 : total,
        lines: lines.map(line => ({ productId: line.productId, quantity: n(line.quantity), unitPrice: n(line.unitPrice), bottleProductId: line.bottleProductId || null })),
      }, tr("تم اعتماد فاتورة التقسيمات"));
      reset();
      if (printAfterSave && typeof savedId === "string" && savedId) requestPrint(savedId);
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
        <InvoiceHistory kind="sale" title={tr("سجل الفواتير")} emptyLabel={tr("لا توجد فواتير تقسيمات حتى الآن")} documents={recent} openDoc={openDoc} onVoid={voidInvoice} busy={busy}/>
      </div>

      <InvoicePanel title={tr("فاتورة بيع")} className="invoice-card workspace-invoice">
        <InvoiceToolbar number={String(data.nextDocumentSequences.decantSale)} onNew={newInvoice}/>
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
            <label>{tr("العميل")}</label>
            <InvoicePartyPicker partyId={partyId} onChange={setPartyId} parties={customers} isCustomer note={paymentMethod === "note"} run={run} canCreate={canUseCapability(data.principal, "customers.create")}/>
            <div className="checkout-invoice-actions"><button type="button" className="print-toggle" aria-pressed={printAfterSave} onClick={() => setPrintAfterSave(value => !value)}><span>{printAfterSave && <i/>}</span>{tr("طباعة")}</button><button type="button" className="invoice-void" disabled={!lines.length} onClick={() => { if (window.confirm(tr("هل تريد حذف مسودة الفاتورة؟"))) reset(); }}>{tr("حذف المسودة")}</button></div>
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

export function DecantBottlePurchaseInvoice({ data, run, openDoc, requestPrint }: Props) {
  const defaultWarehouse = data.warehouses.find(warehouse => warehouse.isSalesDefault && warehouse.isArchived !== true) ?? null;
  const accounts = activePaymentAccounts(data.paymentAccounts);
  const suppliers = data.parties.filter(party => party.partyType === "supplier" && party.isArchived !== true);
  const bottles = useMemo(() => activeProducts(data.products).filter(product => product.perfumeForm === "bottle"), [data.products]);
  const recent = useMemo(() => data.documents.filter(document => document.kind === "decant-purchase"), [data.documents]);
  const [paymentMethod, setPaymentMethod] = useState("");
  const [partyId, setPartyId] = useState("");
  const [productId, setProductId] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState("");
  const [printAfterSave, setPrintAfterSave] = useState(false);
  const total = lines.reduce((sum, line) => sum + n(line.quantity) * n(line.unitPrice), 0);
  const pickerItems = useMemo<PerfumePickerItem[]>(() => bottles.map(product => ({
    id: product.id,
    name: product.name,
    group: tr("زجاج التقسيمات"),
    meta: product.decantSizeMl ? String(product.decantSizeMl) + " ml" : "",
  })), [bottles]);

  const reset = () => { setLines([]); setPartyId(""); setPaymentMethod(""); setProductId(""); setLocalError(""); };
  const newInvoice = () => { if (!lines.length && !partyId && !paymentMethod || window.confirm(tr("لديك تغييرات غير محفوظة. هل تريد بدء فاتورة جديدة؟"))) reset(); };
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
      const savedId = await run({
        type: "decant-purchase.post",
        paymentMethod,
        partyId: partyId || null,
        cashAmount: paymentMethod === "note" ? 0 : total,
        lines: lines.map(line => ({ productId: line.productId, quantity: n(line.quantity), unitPrice: n(line.unitPrice) })),
      }, tr("تم اعتماد فاتورة شراء زجاج التقسيمات"));
      reset();
      if (printAfterSave && typeof savedId === "string" && savedId) requestPrint(savedId);
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
        <InvoiceHistory kind="purchase" title={tr("سجل فواتير الشراء")} emptyLabel={tr("لا توجد فواتير تقسيمات حتى الآن")} documents={recent} openDoc={openDoc} onVoid={voidInvoice} busy={busy}/>
      </div>

      <InvoicePanel title={tr("فاتورة شراء")} className="invoice-card workspace-invoice">
        <InvoiceToolbar number={String(data.nextDocumentSequences.decantPurchase)} onNew={newInvoice}/>
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
              purchase
              onDirect={() => setPaymentMethod(paymentMethod === "note" ? (accounts[0]?.id ?? "") : paymentMethod)}
              onNote={() => setPaymentMethod("note")}
            />
            {paymentMethod !== "note" && <label>{tr("طريقة الدفع")}<select value={paymentMethod} onChange={event => setPaymentMethod(event.target.value)}><option value="">{tr("اختر وسيلة الدفع")}</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}
            <label>{tr("المورد")}</label>
            <InvoicePartyPicker partyId={partyId} onChange={setPartyId} parties={suppliers} isCustomer={false} note={paymentMethod === "note"} run={run} canCreate={canUseCapability(data.principal, "suppliers.create")}/>
            <div className="checkout-invoice-actions"><button type="button" className="print-toggle" aria-pressed={printAfterSave} onClick={() => setPrintAfterSave(value => !value)}><span>{printAfterSave && <i/>}</span>{tr("طباعة")}</button><button type="button" className="invoice-void" disabled={!lines.length} onClick={() => { if (window.confirm(tr("هل تريد حذف مسودة الفاتورة؟"))) reset(); }}>{tr("حذف المسودة")}</button></div>
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
