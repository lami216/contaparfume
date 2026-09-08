"use client";
import { useState, type FormEvent } from "react";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import type { ProductCategory } from "./domain";
import { useAppConfirm } from "./app-confirm";
import { tr } from "./i18n/messages";
import styles from "./product-category-dialog.module.css";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;

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

  return <div className={`modal-card ${styles.modal}`}>
    <div className="product-form-head"><div><small>{tr("الفئات")}</small><h2>{tr("إضافة فئة")}</h2></div><button type="button" className="icon" aria-label={tr("إغلاق")} onClick={close}><X /></button></div>
    <form className={styles.create} onSubmit={submit}><label>{tr("اسم الفئة")}<input autoFocus maxLength={80} value={name} onChange={event => setName(event.target.value)} /></label><button className="primary" disabled={busy || !name.trim()}><Plus />{busy ? tr("جاري الحفظ…") : tr("إضافة فئة")}</button></form>
    <div className={styles.list}><strong>{tr("الفئات الحالية")}</strong>{categories.length ? <div className={styles.grid}>{categories.map(category => editingId === category.id ? <form className={styles.editCard} key={category.id} onSubmit={event => void saveEdit(event, category)}><input autoFocus maxLength={80} value={editingName} onChange={event => setEditingName(event.target.value)} disabled={busyId === category.id} /><button type="submit" className={styles.editActionButton} disabled={busyId === category.id || !editingName.trim()} aria-label={tr("common.save")} title={tr("common.save")}><Check /></button><button type="button" className={styles.editActionButton} disabled={busyId === category.id} onClick={cancelEdit} aria-label={tr("common.cancel")} title={tr("common.cancel")}><X /></button></form> : <div className={styles.categoryCard} key={category.id} tabIndex={0}><span className={styles.categoryName}>{category.name}</span><div className={styles.categoryActions}><button type="button" className={styles.actionButton} onClick={() => startEdit(category)} disabled={Boolean(busyId)} aria-label={`${category.name} — ${tr("common.save")}`}><Pencil /></button><button type="button" className={`${styles.actionButton} ${styles.deleteAction}`} onClick={() => void removeCategory(category)} disabled={Boolean(busyId)} aria-label={`${category.name} — ${tr("common.delete")}`}><Trash2 /></button></div></div>)}</div> : <p>{tr("لا توجد فئات حتى الآن")}</p>}</div>
    <div className="product-form-actions"><button type="button" className="soft" onClick={close}>{tr("إغلاق")}</button></div>
  </div>;
}
