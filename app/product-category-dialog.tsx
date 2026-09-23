"use client";
import { useState, type FormEvent } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import type { ProductCategory } from "./domain";
import { useAppConfirm } from "./app-confirm";
import { tr } from "./i18n/messages";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;

const categoryDialogStyles = `
.product-category-modal{width:min(640px,94vw);display:grid;gap:10px}
.product-category-create{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:7px}
.product-category-create label{display:grid;gap:4px;font-size:10px;font-weight:800}
.product-category-create input,.product-category-create button{height:34px;min-height:34px}
.product-category-create button{display:flex;align-items:center;gap:5px}.product-category-create button svg{width:15px;height:15px}
.product-category-list{display:grid;gap:7px;min-height:90px;padding:8px;border:1px solid var(--line);border-radius:6px;background:#fff}
.product-category-grid{display:grid!important;grid-template-columns:repeat(3,minmax(0,1fr))!important;align-items:start;gap:7px;max-height:190px;overflow:auto;padding:2px}
.product-category-grid.wide-names{grid-template-columns:repeat(3,minmax(0,1fr))!important}
.product-category-card{position:relative;display:grid;place-items:center;width:100%;min-width:0;max-width:none;min-height:42px;padding:6px 8px;border:1px solid var(--line);border-radius:10px;background:#fff;box-shadow:0 1px 2px rgba(20,49,47,.04);transition:border-color .15s ease,background .15s ease,box-shadow .15s ease}
.product-category-card:hover,.product-category-card:focus-within{border-color:#a9c9c5;background:#fbfdfd;box-shadow:0 3px 10px rgba(20,49,47,.08);outline:none}
.product-category-name{display:-webkit-box;width:100%;overflow:hidden;color:var(--ink);font-size:10px;font-weight:800;line-height:1.35;text-align:center;text-overflow:ellipsis;white-space:normal;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}
.product-category-actions{position:absolute;inset:0;display:flex;align-items:center;justify-content:space-between;padding:4px;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease}
.product-category-card:hover .product-category-actions,.product-category-card:focus-within .product-category-actions{opacity:1;visibility:visible}
.product-category-action,.product-category-edit-action{display:inline-grid;place-items:center;width:24px;height:24px;min-height:24px;padding:0;border:1px solid var(--line);border-radius:7px;background:rgba(255,255,255,.96);color:var(--brand);pointer-events:auto}
.product-category-action:hover,.product-category-edit-action:hover{background:var(--soft)}
.product-category-action svg,.product-category-edit-action svg{width:13px;height:13px}
.product-category-delete-action{color:var(--red)}.product-category-delete-action:hover{background:#fff4f5;border-color:#efcbd0}
.product-category-edit-card{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:4px;width:100%;min-width:0;min-height:42px;padding:3px;border:1px solid #a9c9c5;border-radius:10px;background:#fbfdfd;box-shadow:0 3px 10px rgba(20,49,47,.08)}
.product-category-edit-card input{height:30px;min-height:30px;padding:4px 8px;border-radius:7px;font-size:10px;font-weight:800;text-align:center}
.product-category-list p{margin:0;color:var(--muted);font-size:10px}
@media(max-width:1050px){.product-category-create{grid-template-columns:1fr}}
@media(max-width:420px){.product-category-grid,.product-category-grid.wide-names{grid-template-columns:repeat(2,minmax(0,1fr))!important}.product-category-card{width:100%;min-width:0;max-width:none}.product-category-edit-card{min-width:0}}
`;

export default function ProductCategoryDialog({ categories, run, close, canCreate, canEdit, canDelete }: { categories: ProductCategory[]; run: RunCommand; close: () => void; canCreate:boolean; canEdit:boolean; canDelete:boolean }) {
  const confirmAction = useAppConfirm();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editingName, setEditingName] = useState("");
  const originalOrder = new Map(categories.map((category, index) => [category.id, index]));
  const sortedCategories = [...categories].sort((a, b) => {
    const aTime = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
    const bTime = b.createdAt ? Date.parse(b.createdAt) : Number.NaN;
    const aHasTime = Number.isFinite(aTime);
    const bHasTime = Number.isFinite(bTime);
    if (aHasTime && bHasTime && aTime !== bTime) return bTime - aTime;
    if (aHasTime !== bHasTime) return aHasTime ? -1 : 1;
    return (originalOrder.get(b.id) ?? 0) - (originalOrder.get(a.id) ?? 0);
  });
  const hasWideCategoryNames = sortedCategories.some(category => category.name.trim().length > 14);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canCreate || !name.trim() || busy) return;
    setBusy(true);
    try { await run({ type: "product-category.create", name: name.trim() }, tr("تمت إضافة الفئة")); setName(""); } finally { setBusy(false); }
  };

  const startEdit = (category: ProductCategory) => {
    if (!canEdit || busyId) return;
    setEditingId(category.id);
    setEditingName(category.name);
  };

  const cancelEdit = () => {
    if (busyId) return;
    setEditingId("");
    setEditingName("");
  };

  const saveEdit = async (event: FormEvent, category: ProductCategory) => {
    event.preventDefault();
    const nextName = editingName.trim();
    if (!nextName || busyId) return;
    if (nextName === category.name) { cancelEdit(); return; }
    setBusyId(category.id);
    try {
      await run({ type: "product-category.update", id: category.id, name: nextName }, `${tr("common.save")}: ${nextName}`);
      setEditingId("");
      setEditingName("");
    } finally { setBusyId(""); }
  };

  const removeCategory = async (category: ProductCategory) => {
    if (!canDelete || busyId) return;
    const accepted = await confirmAction({
      message: `${tr("common.delete")} — ${category.name}?`,
      confirmLabel: tr("common.delete"),
      cancelLabel: tr("common.cancel"),
      tone: "danger",
    });
    if (!accepted) return;
    setBusyId(category.id);
    try { await run({ type: "product-category.delete", id: category.id }, `${tr("common.delete")}: ${category.name}`); }
    finally { setBusyId(""); }
  };

  return <><style>{categoryDialogStyles}</style><div className="modal-card product-category-modal">
    <div className="product-form-head"><div><small>{tr("الفئات")}</small><h2>{tr("إضافة فئة")}</h2></div><button type="button" className="icon" aria-label={tr("إغلاق")} onClick={close}><X /></button></div>
    {canCreate&&<form className="product-category-create" onSubmit={submit}><label>{tr("اسم الفئة")}<input autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label><button className="primary" disabled={busy || !name.trim()}><Plus />{busy ? tr("جاري الحفظ…") : tr("إضافة فئة")}</button></form>}
    <div className="product-category-list"><strong>{tr("الفئات الحالية")}</strong>{sortedCategories.length ? <div className={`product-category-grid${hasWideCategoryNames ? " wide-names" : ""}`}>{sortedCategories.map(category => editingId === category.id ? <form className="product-category-edit-card" key={category.id} onSubmit={event => void saveEdit(event, category)}><input autoFocus maxLength={80} value={editingName} onChange={event => setEditingName(event.target.value)} disabled={busyId === category.id} /><button type="submit" className="product-category-edit-action" disabled={busyId === category.id || !editingName.trim()} aria-label={tr("common.save")} title={tr("common.save")}><Check /></button><button type="button" className="product-category-edit-action" disabled={busyId === category.id} onClick={cancelEdit} aria-label={tr("common.cancel")} title={tr("common.cancel")}><X /></button></form> : <div className="product-category-card" key={category.id} tabIndex={0}><span className="product-category-name">{category.name}</span>{(canEdit||canDelete)&&<div className="product-category-actions">{canEdit&&<button type="button" className="product-category-action" onClick={() => startEdit(category)} disabled={Boolean(busyId)} aria-label={`${category.name} — ${tr("common.save")}`}><Pencil /></button>}{canDelete&&<button type="button" className="product-category-action product-category-delete-action" onClick={() => void removeCategory(category)} disabled={Boolean(busyId)} aria-label={`${category.name} — ${tr("common.delete")}`}><Trash2 /></button>}</div>}</div>)}</div> : <p>{tr("لا توجد فئات حتى الآن")}</p>}</div>
    <div className="product-form-actions"><button type="button" className="soft" onClick={close}>{tr("إغلاق")}</button></div>
  </div></>;
}
