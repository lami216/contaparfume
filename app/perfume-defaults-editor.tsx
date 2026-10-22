"use client";
import { useState } from "react";
import { DEFAULT_PERFUME_SETTINGS, type PerfumeDefaults } from "./perfume-volume";
import type { Product } from "./domain";
import { tr } from "./i18n/messages";

export default function PerfumeDefaultsEditor({ defaults=DEFAULT_PERFUME_SETTINGS,bottles,run,disabled }: {
  defaults?:PerfumeDefaults;bottles:Product[];disabled:boolean;
  run:(body:Record<string,unknown>,message:string)=>Promise<unknown>;
}) {
  const [fill,setFill]=useState(String(defaults.fillMl)),[bottle,setBottle]=useState(defaults.bottleProductId),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const save=async()=>{setBusy(true);setError("");try{await run({type:"perfume-defaults.update",fillMl:Number(fill),bottleProductId:bottle},tr("تم حفظ التعبئة الافتراضية"))}catch(e){setError(e instanceof Error?e.message:tr("تعذر الحفظ"))}finally{setBusy(false)}};
  return <form className="pm-defaults-row" onSubmit={event=>{event.preventDefault();void save()}}>
    <label>{tr("التعبئة الافتراضية بالمل")}<input aria-label={tr("التعبئة الافتراضية بالمل")} type="number" min="0.001" step="any" required value={fill} onChange={e=>setFill(e.target.value)} disabled={disabled||busy}/></label>
    <label>{tr("العبوة الافتراضية")}<select aria-label={tr("العبوة الافتراضية")} value={bottle} onChange={e=>setBottle(e.target.value)} disabled={disabled||busy} required><option value="">{tr("اختر الزجاجة")}</option>{bottles.map(p=><option key={p.id} value={p.id} disabled={Number(p.decantSizeMl)<Number(fill)}>{p.name} · {p.decantSizeMl} {tr("مل")}</option>)}</select></label>
    <button type="submit" className="soft" disabled={disabled||busy}>{tr("حفظ")}</button>
    {error&&<small className="error" role="alert">{error}</small>}
  </form>;
}
