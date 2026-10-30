"use client";
import { useState } from "react";
import { DEFAULT_PERFUME_SETTINGS, type PerfumeDefaults } from "./perfume-volume";
import type { Product } from "./domain";
import { tr } from "./i18n/messages";

export default function PerfumeDefaultsEditor({ defaults=DEFAULT_PERFUME_SETTINGS,bottles,run,disabled }: {
  defaults?:PerfumeDefaults;bottles:Product[];disabled:boolean;
  run:(body:Record<string,unknown>,message:string)=>Promise<unknown>;
}) {
  const [bottle,setBottle]=useState(defaults.bottleProductId),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const selected=bottles.find(p=>p.id===bottle);
  const save=async()=>{setBusy(true);setError("");try{await run({type:"perfume-defaults.update",bottleProductId:bottle},tr("تم حفظ العبوة الافتراضية"))}catch(e){setError(e instanceof Error?e.message:tr("تعذر الحفظ"))}finally{setBusy(false)}};
  return <form className="pm-defaults-row" onSubmit={event=>{event.preventDefault();void save()}}>
    <label>{tr("العبوة الافتراضية")}<select aria-label={tr("العبوة الافتراضية")} value={bottle} onChange={e=>setBottle(e.target.value)} disabled={disabled||busy} required><option value="">{tr("اختر الزجاجة")}</option>{bottles.map(p=><option key={p.id} value={p.id}>{p.name} · {p.decantSizeMl} {tr("مل")}</option>)}</select></label>
    <small>{selected?`${tr("التعبئة")}: ${selected.decantSizeMl} ${tr("مل")}. `:""}{tr("يمكن تغيير التعبئة عند البيع")}</small>
    <button type="submit" className="soft" disabled={disabled||busy}>{tr("حفظ")}</button>
    {error&&<small className="error" role="alert">{error}</small>}
  </form>;
}
