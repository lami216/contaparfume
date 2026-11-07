"use client";

import { useEffect, useState } from "react";
import type { EditorReplacementGuard } from "./editor-replacement";
import type { DocumentRecord, Party } from "./domain";
import { money } from "./domain";
import { partyNet } from "./party-balance";
import { useAppConfirm } from "./app-confirm";
import { useI18n } from "./i18n/provider";

type Direction = "receivable" | "payable";
export type PartyOpeningDraft = { enabled: boolean; direction: Direction; amount: string; note: string };
export const emptyPartyOpeningDraft = (): PartyOpeningDraft => ({ enabled: false, direction: "receivable", amount: "", note: "" });
type OpeningDocument = DocumentRecord & {
  partyOpeningAmount?: number;
  partyOpeningDirection?: Direction;
  partyOpeningContribution?: number;
};
type Run = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;
const copies = {
  ar: {
    title: "رصيد بداية الحساب", optional: "إضافة رصيد بداية", receivable: "مستحق لنا", payable: "مستحق علينا",
    amount: "المبلغ", note: "ملاحظة", add: "إضافة رصيد البداية", edit: "تعديل رصيد البداية", save: "حفظ رصيد البداية",
    cancel: "إلغاء التعديل", remove: "إلغاء رصيد البداية", noOpening: "لم يُسجّل رصيد بداية لهذا الحساب",
    additive: "هذا مبلغ سابق لم يُسجّل، وسيُضاف إلى الرصيد الحالي.",
    current: "الرصيد الحالي", result: "الرصيد بعد العملية", change: "التغيير", balanced: "الحساب متوازن",
    confirm: "هل تعتمد رصيد البداية بهذه النتيجة؟", confirmRemove: "هل تلغي رصيد البداية مع الإبقاء على الحركات اللاحقة؟",
    saved: "تم حفظ رصيد بداية الحساب", removed: "تم إلغاء رصيد بداية الحساب",
    changed: "تغير مستند رصيد البداية. ألغِ التعديل وافتحه من جديد.",
  },
  fr: {
    title: "Solde initial du compte", optional: "Ajouter un solde initial", receivable: "À nous devoir", payable: "À payer au tiers",
    amount: "Montant", note: "Note", add: "Ajouter le solde initial", edit: "Modifier le solde initial", save: "Enregistrer le solde initial",
    cancel: "Annuler la modification", remove: "Annuler le solde initial", noOpening: "Aucun solde initial enregistré pour ce compte",
    additive: "Ce montant antérieur non enregistré sera ajouté au solde actuel.",
    current: "Solde actuel", result: "Solde après l’opération", change: "Variation", balanced: "Compte équilibré",
    confirm: "Confirmer le solde initial avec ce résultat ?", confirmRemove: "Annuler le solde initial en conservant les mouvements ultérieurs ?",
    saved: "Solde initial enregistré", removed: "Solde initial annulé",
    changed: "Le document a changé. Annulez la modification puis ouvrez-le à nouveau.",
  },
};

function OpeningFields({ value, onChange, disabled = false }: {
  value: PartyOpeningDraft; onChange: (value: PartyOpeningDraft) => void; disabled?: boolean;
}) {
  const { locale } = useI18n(), copy = copies[locale];
  return <div className="party-opening-fields">
    <label>{copy.receivable} / {copy.payable}<select value={value.direction} disabled={disabled}
      onChange={event => onChange({ ...value, direction: event.target.value as Direction })}>
      <option value="receivable">{copy.receivable}</option><option value="payable">{copy.payable}</option>
    </select></label>
    <label>{copy.amount}<input type="number" inputMode="decimal" step="any" min="0" required value={value.amount}
      disabled={disabled} onChange={event => onChange({ ...value, amount: event.target.value })}/></label>
    <label>{copy.note}<input value={value.note} maxLength={1000} disabled={disabled}
      onChange={event => onChange({ ...value, note: event.target.value })}/></label>
  </div>;
}

export function PartyOpeningCreateFields({ value, onChange }: { value: PartyOpeningDraft; onChange: (value: PartyOpeningDraft) => void }) {
  const { locale } = useI18n(), copy = copies[locale];
  return <div className="party-opening-create">
    <label className="party-opening-toggle"><input type="checkbox" checked={value.enabled}
      onChange={event => onChange({ ...value, enabled: event.target.checked })}/>{copy.optional}</label>
    {value.enabled && <OpeningFields value={value} onChange={onChange}/>}
  </div>;
}

export function PartyOpeningPanel({ party, documents, canManage, run, registerGuard, prepareEditorReplacement, editRequest, clearEditRequest }: {
  party: Party; documents: DocumentRecord[]; canManage: boolean; run: Run;
  registerGuard: (guard: EditorReplacementGuard | null) => void; prepareEditorReplacement: () => Promise<boolean>;
  editRequest: string | null; clearEditRequest: () => void;
}) {
  const { locale } = useI18n(), copy = copies[locale], confirm = useAppConfirm();
  const [expanded, setExpanded] = useState(false), [draft, setDraft] = useState(emptyPartyOpeningDraft);
  const [editing, setEditing] = useState<{ id: string; revision: number; baseline: string } | null>(null);
  const [pending, setPending] = useState(false);
  const opening = documents.find(document => document.kind === "party-opening" && document.status === "posted" && document.partyId === party.id) as OpeningDocument | undefined;
  const current = partyNet(party), permitted = canManage && party.isArchived !== true;
  const amount = Number(draft.amount), valid = draft.amount.trim() !== "" && Number.isFinite(amount) && amount > 0;
  const signed = draft.direction === "receivable" ? amount : -amount;
  const originalContribution = editing ? Number(opening?.partyOpeningContribution ?? 0) : 0;
  const result = current + signed - originalContribution;
  const stale = Boolean(editing && (opening?.id !== editing.id || opening.revision !== editing.revision));
  const summary = (value: number) => value === 0 ? copy.balanced : money(Math.abs(value)) + " · " + (value > 0 ? copy.receivable : copy.payable);
  const reset = () => { setExpanded(false); setEditing(null); setDraft(emptyPartyOpeningDraft()); };
  const load = (document: OpeningDocument) => {
    const value: PartyOpeningDraft = { enabled: true, direction: document.partyOpeningDirection ?? "receivable",
      amount: String(document.partyOpeningAmount ?? document.total), note: document.note ?? "" };
    setDraft(value); setEditing({ id: document.id, revision: document.revision ?? 0, baseline: JSON.stringify(value) }); setExpanded(true);
  };
  useEffect(() => {
    registerGuard({
      isEditing: () => expanded,
      isDirty: () => expanded && (editing ? JSON.stringify(draft) !== editing.baseline : Boolean(draft.amount || draft.note || draft.direction !== "receivable")),
      discard: reset,
    });
    return () => registerGuard(null);
  });
  // External history requests already pass the page's unsaved-editor guard.
  useEffect(() => {
    if (!editRequest) return;
    const document = documents.find(item => item.id === editRequest && item.partyId === party.id && item.kind === "party-opening" && item.status === "posted");
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (document && permitted) load(document as OpeningDocument);
    clearEditRequest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editRequest]);
  const openEditor = async () => {
    if (!permitted || pending || !await prepareEditorReplacement()) return;
    if (opening) load(opening);
    else { setDraft({ ...emptyPartyOpeningDraft(), enabled: true }); setExpanded(true); }
  };
  const save = async () => {
    if (!permitted || pending || stale || !valid || !Number.isFinite(result)) return;
    const delta = signed - originalContribution;
    const message = [copy.confirm, copy.current + " " + summary(current), copy.change + " " + money(delta),
      copy.result + " " + summary(result)].join("\n");
    if (!await confirm({ title: copy.title, message, confirmLabel: copy.save })) return;
    setPending(true);
    try {
      await run({ type: editing ? "party-opening.update" : "party-opening.post",
        ...(editing ? { documentId: editing.id, expectedRevision: editing.revision } : { partyId: party.id }),
        direction: draft.direction, amount, note: draft.note }, copy.saved, reset);
    } catch {
      // The shared runner displays the error and the draft stays available.
    } finally { setPending(false); }
  };
  const remove = async () => {
    if (!permitted || !opening || pending || !await prepareEditorReplacement()) return;
    const after = current - Number(opening.partyOpeningContribution);
    const message = [copy.confirmRemove, copy.current + " " + summary(current), copy.result + " " + summary(after)].join("\n");
    if (!await confirm({ title: copy.title, message, confirmLabel: copy.remove, tone: "danger" })) return;
    setPending(true);
    try { await run({ type: "party-opening.void", documentId: opening.id, expectedRevision: opening.revision }, copy.removed, reset); }
    catch { /* The shared runner displays the command error. */ }
    finally { setPending(false); }
  };
  return <fieldset className="erp-fieldset party-opening-panel">
    <legend>{copy.title}</legend>
    <div className="party-opening-summary"><strong>{opening ? summary(Number(opening.partyOpeningContribution)) : copy.noOpening}</strong>
      {permitted && !expanded && <button type="button" className="soft" onClick={() => void openEditor()}>{opening ? copy.edit : copy.add}</button>}
      {permitted && opening && <button type="button" className="danger compact-delete" disabled={pending} onClick={() => void remove()}>{copy.remove}</button>}
    </div>
    {expanded && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      {!editing && current !== 0 && <small>{copy.additive}</small>}
      <OpeningFields value={draft} onChange={setDraft} disabled={!permitted || pending}/>
      <div className="party-opening-preview"><span>{copy.current} · {summary(current)}</span>
        {valid && <strong>{copy.result} · {summary(result)}</strong>}</div>
      {stale && <div className="error" role="alert">{copy.changed}</div>}
      <div className="party-row-actions"><button className="primary" disabled={!permitted || pending || stale || !valid}>{copy.save}</button>
        <button type="button" className="soft" disabled={pending} onClick={reset}>{copy.cancel}</button></div>
    </form>}
  </fieldset>;
}
