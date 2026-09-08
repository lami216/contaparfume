"use client";
import { useState, type FormEvent } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import type { ProductCategory } from "./domain";
import { useAppConfirm } from "./app-confirm";
import { tr } from "./i18n/messages";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;

const categoryDialogStyles = `
.product-category-modal{width:min(540px,94vw);display:grid;gap:10px}
.product-category-create{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:7px}
.product-category-create label{display:grid;gap:4px;font-size:10px;font-weight:800}
.product-category-create input,.product-category-create button{height:34px;min-height:34px}
.product-category-create button{display:flex;align-items:center;gap:5px}.product-category-create button svg{width:15px;height:15px}
.product-category-list{display:grid;gap:7px;min-height:90px;padding:8px;border:1px solid var(--line);border-radius:6px;background:#fff}
.product-category-grid{display:flex;flex-wrap:wrap;align-items:flex-start;gap:7px;max-height:190px;overflow:auto;padding:2px}
.product-category-card{position:relative;display:grid;place-items:center;min-width:92px;max-width:190px;min-height:34px;padding:6px 31px;border:1px solid var(--line);border-radius:10px;background:#fff;box-shadow:0 1px 2px rgba(20,49,47,.04);transition:border-color .15s ease,background .15s ease,box-shadow .15s ease}
.product-category-card:hover,.product-category-card:focus-within{border-color:#a9c9c5;background:#fbfdfd;box-shadow:0 3px 10px rgba(20,49,47,.08);outline:none}
.product-category-name{display:block;width:100%;overflow:hidden;color:var(--ink);font-size:10px;font-weight:800;line-height:1.25;text-align:center;text-overflow:ellipsis;white-space:nowrap}
.product-category-actions{position:absolute;inset:0;display:flex;align-items:center;justify-content:space-between;padding:4px;opacity:0;visibility:hidden;pointer-events:none;transition:opacity .12s ease}
.product-category-card:hover .product-category-actions,.product-category-card:focus-within .product-category-actions{opacity:1;visibility:visible}
.product-category-action,.product-category-edit-action{display:inline-grid;place-items:center;width:24px;height:24px;min-height:24px;padding:0;border:1px solid var(--line);border-radius:7px;background:rgba(255,255,255,.96);color:var(--brand);pointer-events:auto}
.product-category-action:hover,.product-category-edit-action:hover{background:var(--soft)}
.product-category-action svg,.product-category-edit-action svg{width:13px;height:13px}
.product-category-delete-action{color:var(--red)}.product-category-delete-action:hover{background:#fff4f5;border-color:#efcbd0}
.product-category-edit-card{display:grid;grid-template-columns:minmax(110px,1fr) auto auto;align-items:center;gap:4px;min-width:190px;min-height:34px;padding:3px;border:1px solid #a9c9c5;border-radius:10px;background:#fbfdfd;box-shadow:0 3px 10px rgba(20,49,47,.08)}
.product-category-edit-card input{height:28px;min-height:28px;padding:4px 8px;border-radius:7px;font-size:10px;font-weight:800;text-align:center}
.product-category-list p{margin:0;color:var(--muted);font-size:10px}
@media(max-width:1050px){.product-category-create{grid-template-columns:1fr}}
@media(max-width:520px){.product-category-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr))}.product-category-card{width:100%;min-width:0;max-width:none}.product-category-edit-card{min-width:0}}
`;

export default function ProductCategoryDialog({ categories, run, close }: { categories: ProductCategory[]; run: RunCommand; close: () => void }) {
  const confirmAction = useAppConfirm();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editingName, setEditingName] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await run({ type: "product-category.create", name: name.trim() }, tr("تمت إضافة الفئة")); setName(""); } finally { setBusy(false); }
  };

  const startEdit = (category: ProductCategory) => {
    if (busyId) return;
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
    if (busyId) return;
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
    <form className="product-category-create" onSubmit={submit}><label>{tr("اسم الفئة")}<input autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label><button className="primary" disabled={busy || !name.trim()}><Plus />{busy ? tr("جاري الحفظ…") : tr("إضافة فئة")}</button></form>
    <div className="product-category-list"><strong>{tr("الفئات الحالية")}</strong>{categories.length ? <div className="product-category-grid">{categories.map(category => editingId === category.id ? <form className="product-category-edit-card" key={category.id} onSubmit={event => void saveEdit(event, category)}><input autoFocus maxLength={80} value={editingName} onChange={event => setEditingName(event.target.value)} disabled={busyId === category.id} /><button type="submit" className="product-category-edit-action" disabled={busyId === category.id || !editingName.trim()} aria-label={tr("common.save")} title={tr("common.save")}><Check /></button><button type="button" className="product-category-edit-action" disabled={busyId === category.id} onClick={cancelEdit} aria-label={tr("common.cancel")} title={tr("common.cancel")}><X /></button></form> : <div className="product-category-card" key={category.id} tabIndex={0}><span className="product-category-name">{category.name}</span><div className="product-category-actions"><button type="button" className="product-category-action" onClick={() => startEdit(category)} disabled={Boolean(busyId)} aria-label={`${category.name} — ${tr("common.save")}`}><Pencil /></button><button type="button" className="product-category-action product-category-delete-action" onClick={() => void removeCategory(category)} disabled={Boolean(busyId)} aria-label={`${category.name} — ${tr("common.delete")}`}><Trash2 /></button></div></div>)}</div> : <p>{tr("لا توجد فئات حتى الآن")}</p>}</div>
    <div className="product-form-actions"><button type="button" className="soft" onClick={close}>{tr("إغلاق")}</button></div>
  </div></>;
}
