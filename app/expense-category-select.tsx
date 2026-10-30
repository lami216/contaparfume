"use client";
import {useId,useState} from "react";
import {Plus,X} from "lucide-react";
import type {ExpenseCategory} from "./domain";
import {tr} from "./i18n/messages";

export default function ExpenseCategorySelect({categories,value,onChange,run,canCreate}:{categories:ExpenseCategory[];value:string;onChange:(id:string)=>void;canCreate:boolean;run:(body:Record<string,unknown>,message:string)=>Promise<unknown>}){
  const selectId=useId(),[adding,setAdding]=useState(false),[name,setName]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const close=()=>{if(busy)return;setAdding(false);setName("");setError("")};
  const create=async()=>{
    if(busy||!canCreate||!name.trim())return;setBusy(true);setError("");
    try{const result=await run({type:"expense-category.create",name},tr("تمت إضافة فئة المصروف"));onChange(String(result));setAdding(false);setName("")}
    catch(e){setError(e instanceof Error?e.message:tr("تعذر تنفيذ العملية"))}finally{setBusy(false)}
  };
  return <div className="expense-category-field"><label htmlFor={selectId}>{tr("فئة المصروف")}</label><div className="expense-category-row"><select id={selectId} value={value} onChange={e=>onChange(e.target.value)}><option value="">{tr("بدون فئة")}</option>{categories.map(c=><option value={c.id} key={c.id}>{c.name}</option>)}</select>{canCreate&&<button type="button" className="soft expense-category-add" title={tr("إضافة فئة مصروف")} aria-label={tr("إضافة فئة مصروف")} onClick={()=>adding?close():setAdding(true)} disabled={busy}>{adding?<X/>:<Plus/>}</button>}</div>{adding&&<div className="expense-category-create"><label>{tr("اسم فئة المصروف")}<input autoFocus maxLength={80} value={name} onChange={e=>setName(e.target.value)} disabled={busy} onKeyDown={e=>{if(e.key==="Enter"){e.preventDefault();e.stopPropagation();void create()}if(e.key==="Escape"){e.preventDefault();e.stopPropagation();close()}}}/></label><button type="button" className="soft" onClick={()=>void create()} disabled={busy||!name.trim()}>{tr(busy?"جاري الحفظ…":"حفظ")}</button></div>}{error&&<small role="alert" className="error">{error}</small>}</div>;
}
