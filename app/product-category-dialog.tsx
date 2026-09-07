"use client";
import { useState, type FormEvent } from "react";
import { Plus, X } from "lucide-react";
import type { ProductCategory } from "./domain";
import { tr } from "./i18n/messages";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;

export default function ProductCategoryDialog({ categories, run, close }: { categories: ProductCategory[]; run: RunCommand; close: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await run({ type: "product-category.create", name: name.trim() }, tr("تمت إضافة الفئة")); setName(""); } finally { setBusy(false); }
  };
  return <div className="modal-card product-category-modal">
    <div className="product-form-head"><div><small>{tr("الفئات")}</small><h2>{tr("إضافة فئة")}</h2></div><button type="button" className="icon" aria-label={tr("إغلاق")} onClick={close}><X /></button></div>
    <form className="product-category-create" onSubmit={submit}><label>{tr("اسم الفئة")}<input autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label><button className="primary" disabled={busy || !name.trim()}><Plus />{busy ? tr("جاري الحفظ…") : tr("إضافة فئة")}</button></form>
    <div className="product-category-list"><strong>{tr("الفئات الحالية")}</strong>{categories.length ? <div>{categories.map(category => <span key={category.id}>{category.name}</span>)}</div> : <p>{tr("لا توجد فئات حتى الآن")}</p>}</div>
    <div className="product-form-actions"><button type="button" className="soft" onClick={close}>{tr("إغلاق")}</button></div>
  </div>;
}
