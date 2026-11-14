"use client";
import { useEffect, useId, useState } from "react";
import { Plus, Settings, X } from "lucide-react";
import type { ExpenseCategory } from "./domain";
import ExpenseCategoryManager from "./expense-category-manager";
import { type ExpenseCategoryKind } from "./expense-category-kind";
import { tr } from "./i18n/messages";

export default function ExpenseCategorySelect({ categories, value, onChange, run, canCreate, canEdit, canDelete, retainedCategoryId }: {
  categories: ExpenseCategory[]; value: string; onChange: (id: string) => void;
  canCreate: boolean; canEdit: boolean; canDelete: boolean; retainedCategoryId?: string;
  run: (body: Record<string, unknown>, message: string) => Promise<unknown>;
}) {
  const selectId = useId();
  const [adding, setAdding] = useState(false), [managing, setManaging] = useState(false);
  const [name, setName] = useState(""), [kind, setKind] = useState<ExpenseCategoryKind>("recurring");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const options = categories.filter(category => !category.isArchived || category.id === retainedCategoryId);
  useEffect(() => {
    if (value && !categories.some(category => category.id === value && (!category.isArchived || category.id === retainedCategoryId))) onChange("");
  }, [categories, value, retainedCategoryId, onChange]);
  const close = () => { if (busy) return; setAdding(false); setName(""); setKind("recurring"); setError(""); };
  const create = async () => {
    if (busy || !canCreate || !name.trim()) return;
    setBusy(true); setError("");
    try {
      const result = await run({ type: "expense-category.create", name, kind }, tr("تمت إضافة فئة المصروف"));
      onChange(String(result)); setAdding(false); setName(""); setKind("recurring");
    } catch (failure) { setError(failure instanceof Error ? failure.message : tr("تعذر تنفيذ العملية")); }
    finally { setBusy(false); }
  };
  return <>
    <div className="expense-category-picker">
      <label htmlFor={selectId}>{tr("فئة المصروف")}</label>
      <div className="expense-category-row">
        <select id={selectId} value={value} onChange={event => onChange(event.target.value)}>
          <option value="">{tr("بدون فئة")}</option>
          {options.map(category => <option value={category.id} key={category.id}>{category.name}{category.isArchived ? ` (${tr("مؤرشف")})` : ""}</option>)}
        </select>
        {canCreate && <button type="button" className="soft expense-category-add" title={tr(adding ? "إلغاء" : "إضافة فئة مصروف")} aria-label={tr(adding ? "إلغاء" : "إضافة فئة مصروف")} aria-expanded={adding} onClick={() => adding ? close() : setAdding(true)} disabled={busy}>{adding ? <X/> : <Plus/>}</button>}
        {(canCreate || canEdit || canDelete) && <button type="button" className="soft expense-category-manage" title={tr("إدارة فئات المصاريف")} aria-label={tr("إدارة فئات المصاريف")} disabled={busy} onClick={() => setManaging(true)}><Settings/></button>}
      </div>
    </div>
    {adding && <div className="expense-category-create">
      <label>{tr("اسم فئة المصروف")}<input autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} disabled={busy} onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void create(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
      }}/></label>
      <label>{tr("نوع الفئة")}<select className="expense-category-kind-select" value={kind} disabled={busy} onChange={event => setKind(event.target.value as ExpenseCategoryKind)}><option value="recurring">{tr("متكررة")}</option><option value="nonrecurring">{tr("غير متكررة")}</option></select></label>
      <button type="button" className="primary" onClick={() => void create()} disabled={busy || !name.trim()}>{tr(busy ? "جاري الحفظ…" : "حفظ")}</button>
    </div>}
    {error && <small role="alert" className="error expense-category-error">{error}</small>}
    {managing && <ExpenseCategoryManager categories={categories} run={run} canCreate={canCreate} canEdit={canEdit} canDelete={canDelete} close={() => setManaging(false)}/>}
  </>;
}
