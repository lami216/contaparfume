"use client";
import {useEffect,useState} from "react";
import {FileText,PencilLine,Search,X} from "lucide-react";
import {displayDocumentNumber,formatDateTime,money,quantity,type BootstrapData,type DocumentRecord} from "./domain";
import {perfumeActionPermission} from "./perfume-activity-panel";
import {tr} from "./i18n/messages";
import {managementKind} from "./perfume-management";

export default function PerfumeStockRegister({kind,data,busy,onEdit,onVoid,openDoc}:{kind:"opening"|"consumption"|"yield-correction";data:BootstrapData;busy:boolean;onEdit:(d:DocumentRecord)=>void;onVoid:(d:DocumentRecord)=>void;openDoc:(id:string)=>void}){
 const [query,setQuery]=useState(""),[from,setFrom]=useState(""),[to,setTo]=useState(""),[showVoided,setShowVoided]=useState(false),[revisions,setRevisions]=useState(false),[page,setPage]=useState(1),[pages,setPages]=useState(1),[rows,setRows]=useState<DocumentRecord[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState("");
 const title=kind==="consumption"?"سجل الاستهلاك":kind==="yield-correction"?"سجل التسويات":"سجل الأرصدة الافتتاحية";
 const owner=data.principal.principalType!=="user",permissions=data.principal.permissions;
 useEffect(()=>{
  const controller=new AbortController();
  const timer=window.setTimeout(()=>{
   setLoading(true);setError("");
   const params=new URLSearchParams({resource:"documents",scope:"perfume",managementKind:kind,q:query,from,to,latest:String(!revisions),status:showVoided||revisions?"all":"posted",page:String(page),pageSize:"30"});
   void fetch(`/api/history?${params}`,{signal:controller.signal}).then(async response=>{const json=await response.json();if(!response.ok)throw Error(json.error);if(!controller.signal.aborted){setRows(json.rows);setPages(Math.max(1,json.totalPages??1));}}).catch(e=>{if(!controller.signal.aborted){setError(e.message);setRows([])}}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});
  },150);
  return()=>{window.clearTimeout(timer);controller.abort()};
 },[kind,data.documents,query,from,to,showVoided,revisions,page]);
 const change=(setter:(value:string)=>void,value:string)=>{setter(value);setPage(1)};
 return <fieldset className="erp-fieldset pm-register pm-stock-register"><legend>{tr(title)}</legend>
  <div className="pm-section-head"><label className="search compact-search"><Search aria-hidden="true"/><input aria-label={tr("بحث في حركات المخزون")} placeholder={tr("بحث بالعطر أو المستند أو السبب")} value={query} onChange={e=>change(setQuery,e.target.value)}/></label><label>{tr("من")}<input type="date" value={from} onChange={e=>change(setFrom,e.target.value)}/></label><label>{tr("إلى")}<input type="date" value={to} onChange={e=>change(setTo,e.target.value)}/></label><label className="pm-check"><input type="checkbox" checked={showVoided} onChange={e=>{setShowVoided(e.target.checked);setPage(1)}}/>{tr("إظهار الملغى")}</label><label className="pm-check"><input type="checkbox" checked={revisions} onChange={e=>{setRevisions(e.target.checked);setPage(1)}}/>{tr("تاريخ التعديل")}</label></div>
  {error&&<p role="alert" className="error">{error}</p>}{loading&&<p role="status">{tr("جاري تحميل الحركات…")}</p>}
  <div className="erp-table-wrap pm-table-scroll"><table className="erp-table" aria-label={tr(title)}><thead><tr><th>{tr("التاريخ / المستند")}</th><th>{tr("العطر / السبب")}</th><th>{tr("قبل ← بعد")}</th><th>{tr("الفرق")}</th><th>{tr("الأثر المالي")}</th><th>{tr("الحالة")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>{rows.map(d=>{
   const wh=String(d.warehouseId),before=Number(d.perfumeLotBefore?.stocks?.[wh]??0),after=Number(d.perfumeLotAfter?.stocks?.[wh]??0),unit=d.quantityUnit==="ml"||d.perfumeLotAfter?.quantityUnit==="ml"||d.perfumeLotBefore?.quantityUnit==="ml"?tr("مل"):tr("تقسيمة"),loss=Number(d.inventoryLoss??0),gain=Number(d.inventoryGain??0),delta=Number(d.stockDelta??after-before);
   const name=d.perfumeLotBefore?.sourceProductName??d.perfumeLotAfter?.sourceProductName??data.products.find(p=>p.id===d.sourceProductId||p.id===d.decantProductId)?.name??d.lines[0]?.description;
   return <tr key={d.id}><td><span dir="ltr">{displayDocumentNumber(d)}</span><small>{formatDateTime(d.occurredAt)}</small></td><td className="pm-stock-description"><strong>{name}</strong><small>{d.warehouseName} · {d.note||d.title}</small></td><td className="num-cell"><bdi dir="ltr">{quantity(before)} → {quantity(after)}</bdi><small>{unit}</small></td><td className="num-cell">{delta>0?"+":""}{quantity(delta)} {unit}</td><td className="num-cell">{loss>0?<><strong className="negative">{money(-loss)}</strong><small>{tr("الخسارة")}</small></>:gain>0?<><strong className="positive">{money(gain)}</strong><small>{tr("فرق جرد موجب")}</small></>:<><strong>{money(0)}</strong><small>{tr("دون ربح أو خسارة")}</small></>}{d.status!=="posted"&&<small>{tr("أثر معكوس")}</small>}</td><td>{tr(d.replacedByDocumentId?"pm.superseded":d.status==="posted"?"pm.posted":"pm.voided")}</td><td><div className="pm-row-actions"><button type="button" className="soft pm-icon-action" title={tr("عرض المستند")} aria-label={tr("عرض المستند")} onClick={()=>openDoc(d.id)}><FileText/></button>{perfumeActionPermission(d,permissions,owner,"edit")&&managementKind(d)&&<button type="button" className="soft pm-icon-action" title={tr("تعديل")} aria-label={tr("تعديل")} disabled={busy} onClick={()=>onEdit(d)}><PencilLine/></button>}{perfumeActionPermission(d,permissions,owner,"void")&&<button type="button" className="soft danger pm-icon-action" title={tr("إلغاء العملية")} aria-label={tr("إلغاء العملية")} disabled={busy} onClick={()=>onVoid(d)}><X/></button>}</div></td></tr>
  })}{!loading&&!rows.length&&<tr><td colSpan={7}>{tr("لا توجد حركات مطابقة")}</td></tr>}</tbody></table></div>
  {pages>1&&<div className="pm-form-actions"><button type="button" className="soft" disabled={loading||page<=1} onClick={()=>setPage(p=>p-1)}>{tr("السابق")}</button><span>{page} / {pages}</span><button type="button" className="soft" disabled={loading||page>=pages} onClick={()=>setPage(p=>p+1)}>{tr("التالي")}</button></div>}
 </fieldset>;
}
