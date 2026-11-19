"use client";

import { useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { PencilLine, Plus, X } from "lucide-react";
import type { ExpenseCategory } from "./domain";
import { useAppConfirm } from "./app-confirm";
import { expenseCategoryKind, expenseCategoryKindLabel, type ExpenseCategoryKind } from "./expense-category-kind";
import { tr } from "./i18n/messages";

type Run = (body: Record<string, unknown>, message: string) => Promise<unknown>;

export default function ExpenseCategoryManager({ categories, run, canCreate, canEdit, canDelete, close }: {
  categories: ExpenseCategory[]; run: Run; canCreate: boolean; canEdit: boolean; canDelete: boolean; close: () => void;
}) {
  const confirm = useAppConfirm();
  const [editor, setEditor] = useState<{ id: string | null; revision: number; name: string; kind: ExpenseCategoryKind } | null>(null);
  const [name, setName] = useState(""), [kind, setKind] = useState<ExpenseCategoryKind>("recurring");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const dirty = Boolean(editor && (name !== editor.name || kind !== editor.kind));
  const current = editor?.id ? categories.find(category => category.id === editor.id) : null;
  const stale = Boolean(editor?.id && (!current || Number(current.revision ?? 0) !== editor.revision));
  const reset = () => { setEditor(null); setName(""); setKind("recurring"); setError(""); };
  const mayReplace = async () => !busy && (!dirty || await confirm({ message: tr("لديك تعديلات غير محفوظة. هل تريد إلغاء التعديل؟") }));
  const requestClose = async () => { if (await mayReplace()) close(); };
  const openEditor = async (category?: ExpenseCategory) => {
    if (!await mayReplace() || (category ? !canEdit : !canCreate)) return;
    const value = { id: category?.id ?? null, revision: Number(category?.revision ?? 0), name: category?.name ?? "", kind: expenseCategoryKind(category) };
    setEditor(value); setName(value.name); setKind(value.kind); setError("");
  };
  const save = async () => {
    if (!editor || busy || stale || !name.trim() || (editor.id ? !canEdit : !canCreate)) return;
    setBusy(true); setError("");
    try {
      await run({ type: editor.id ? "expense-category.update" : "expense-category.create", ...(editor.id ? { id: editor.id, expectedRevision: editor.revision } : {}), name, kind },
        editor.id ? tr("تم تعديل فئة المصروف") : tr("تمت إضافة فئة المصروف"));
      reset();
    } catch (failure) { setError(failure instanceof Error ? failure.message : tr("تعذر تنفيذ العملية")); }
    finally { setBusy(false); }
  };
  const remove = async (category: ExpenseCategory) => {
    if (!canDelete || busy || category.isArchived || !await mayReplace()) return;
    if (!await confirm({ title: tr("حذف") + " · " + category.name, message: tr("حذف الفئة يخفيها من الاختيارات الجديدة ويحفظ المصاريف السابقة المرتبطة بها."), confirmLabel: tr("حذف"), tone: "danger" })) return;
    setBusy(true); setError("");
    try {
      await run({ type: "expense-category.delete", id: category.id, expectedRevision: Number(category.revision ?? 0) }, tr("تم حفظ العملية"));
      reset();
    } catch (failure) { setError(failure instanceof Error ? failure.message : tr("تعذر تنفيذ العملية")); }
    finally { setBusy(false); }
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void requestClose(); return; }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled)")];
    if (!controls.length) return;
    if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus(); }
    else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus(); }
  };
  return createPortal(<div className="modal-overlay section-expenses" role="dialog" aria-modal="true" aria-label={tr("إدارة فئات المصاريف")} onKeyDown={keyboard}>
    <section className="modal-card expense-category-manager">
      <header className="modal-heading"><h3>{tr("إدارة فئات المصاريف")}</h3><button type="button" className="icon" autoFocus disabled={busy} aria-label={tr("إغلاق")} onClick={() => void requestClose()}><X/></button></header>
      {canCreate && <button type="button" className="soft expense-category-new" disabled={busy} onClick={() => void openEditor()}><Plus/>{tr("فئة جديدة")}</button>}
      {editor && <form className="expense-category-manager-editor" onSubmit={event => { event.preventDefault(); event.stopPropagation(); void save(); }}>
        <label>{tr("اسم فئة المصروف")}<input autoFocus required maxLength={80} value={name} disabled={busy} onChange={event => setName(event.target.value)}/></label>
        <label>{tr("نوع الفئة")}<select className="expense-category-kind-select" value={kind} disabled={busy} onChange={event => setKind(event.target.value as ExpenseCategoryKind)}><option value="recurring">{tr("متكررة")}</option><option value="nonrecurring">{tr("غير متكررة")}</option></select></label>
        <div className="party-row-actions"><button type="submit" className="primary" disabled={busy || stale || !name.trim()}>{tr(editor.id?"حفظ التعديل":"حفظ")}</button><button type="button" className="soft" disabled={busy} onClick={() => void (async () => { if (await mayReplace()) reset(); })()}>{tr("إلغاء")}</button></div>
        <small>{tr("تغيير نوع الفئة يعيد تصنيف المصاريف السابقة دون تغيير مبالغها.")}</small>
        {stale && <small className="error" role="alert">{tr("تغيرت الفئة. ألغِ التعديل وافتحها من جديد.")}</small>}
      </form>}
      {error && <p className="error" role="alert">{error}</p>}
      <div className="erp-table-wrap"><table className="erp-table"><thead><tr><th>{tr("فئة المصروف")}</th><th>{tr("نوع الفئة")}</th><th>{tr("الحالة")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>
        {categories.map(category => <tr key={category.id} data-category-id={category.id}><td>{category.name}</td><td>{tr(expenseCategoryKindLabel(category))}</td><td>{tr(category.isArchived ? "مؤرشف" : "نشط")}</td><td className="action-cell"><div className="party-row-actions">
          {canEdit && <button type="button" className="soft" disabled={busy} aria-label={tr("تعديل") + " " + category.name} onClick={() => void openEditor(category)}><PencilLine/></button>}
          {canDelete && !category.isArchived && <button type="button" className="danger" disabled={busy} aria-label={tr("حذف") + " " + category.name} onClick={() => void remove(category)}><X/></button>}
        </div></td></tr>)}
        {!categories.length && <tr><td colSpan={4}>{tr("لا توجد فئات مصاريف")}</td></tr>}
      </tbody></table></div>
    </section>
  </div>, document.body);
}
