"use client";
import {useEffect,useState} from "react";
import {FileText,PencilLine,X} from "lucide-react";
import {displayDocumentNumber,formatDateTime,money,quantity,type BootstrapData,type DocumentRecord} from "./domain";
import {managementKind,managementLabel} from "./perfume-management";
import {currentPerfumeOperations,relatedPerfumeDocuments,type PerfumeContext} from "./perfume-activity";
import {tr} from "./i18n/messages";

const kindLabels:Record<string,string>={"decant-sale":"فاتورة التقسيمات","decant-purchase":"فاتورة شراء زجاج التقسيمات",sale:"فاتورة بيع",purchase:"فاتورة شراء",transfer:"تحويل مخزني",adjustment:"تسوية المخزون"};
export function perfumeActionPermission(d:DocumentRecord,permissions:string[],owner:boolean,action:"edit"|"void"){
  if(d.status!=="posted"||d.replacedByDocumentId||d.perfumeStockOperationType==="unit-conversion")return false;
  const k=managementKind(d);if(k)return k!=="bottle"&&(owner||permissions.includes("perfume.divisions.manage"));
  if(d.legacyKey)return false;
  const suffix=action==="edit"?"edit":"delete",capability=["decant-sale","decant-purchase"].includes(d.kind)?"perfume.divisions.manage":({sale:"pos",purchase:"purchases",transfer:"warehouses.transfer",adjustment:"warehouses.adjust"} as Record<string,string>)[d.kind];
  return Boolean(capability)&&(owner||permissions.includes(capability==="perfume.divisions.manage"?capability:`${capability}.${suffix}`))&&!(action==="edit"&&d.productArchiveStockClearance);
}
function changeLabel(d:DocumentRecord,context:PerfumeContext,data:BootstrapData){
  if(context.lotId&&managementKind(d)&&d.decantProductId)context={...context,productId:d.decantProductId,lotId:d.perfumeLotId??context.lotId};
  const product=data.products.find(p=>p.id===context.productId),ml=product?.perfumeStockUnit==="ml",factor=Number(product?.legacyDecantUnitMl??1);
  if(d.perfumeStockOperationType==="unit-conversion")return tr("تهيئة وحدة القياس");
  let amount=0;
  for(const line of d.lines){
    if(line.productId===context.productId){
      if(d.kind==="decant-sale"||d.kind==="sale"){
        const allocations=context.lotId?line.perfumeAllocations?.filter(a=>a.lotId===context.lotId):line.perfumeAllocations;
        amount-=ml?(allocations?.length?allocations.reduce((sum,a)=>sum+a.quantity*(a.quantityUnit==="ml"?1:factor),0):Number(line.liquidQuantityMl??line.quantity*Number(line.fillMl??factor))):line.quantity;
      }else amount+=line.quantity*(ml&&d.quantityUnit!=="ml"?factor:1);
    }else if(!context.lotId&&line.bottleProductId===context.productId)amount-=Number(line.bottleQuantity??line.quantity);
  }
  if(d.kind==="transfer")return `${tr("نقل")}: ${quantity(Math.abs(amount))} ${tr(ml?"مل":"قطعة")} · ${d.warehouseName??""} ← ${d.destinationWarehouseName??""}`;
  if(context.lotId&&amount===0&&d.partialProductId)return tr("بيع العطر الناقص");
  if(context.lotId&&d.lines.some(l=>l.productId!==context.productId)&&d.kind==="sale")return `${tr("بيع العطر الناقص")} · ${money(d.total)}`;
  return `${amount>0?"+":""}${quantity(amount)} ${tr(ml?"مل":"قطعة")}`;
}
export default function PerfumeActivityPanel({context,data,busy,onEdit,onVoid,openDoc,onSource,close}:{context:PerfumeContext;data:BootstrapData;busy:boolean;onEdit:(d:DocumentRecord)=>void;onVoid:(d:DocumentRecord)=>void;openDoc:(id:string)=>void;onSource?:(d:DocumentRecord)=>void;close:()=>void}){
  const [showVoided,setShowVoided]=useState(false),[showRevisions,setShowRevisions]=useState(false),[page,setPage]=useState(1),[pages,setPages]=useState(1),[loaded,setLoaded]=useState<DocumentRecord[]|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const owner=data.principal.principalType!=="user",permissions=data.principal.permissions;
  useEffect(()=>{
    const controller=new AbortController();
    const params=new URLSearchParams({resource:"documents",scope:"perfume",productId:context.productId,lotId:context.lotId??"",conversionId:context.conversionId??"",latest:String(!showRevisions),status:showVoided||showRevisions?"all":"posted",page:String(page),pageSize:"100"});
    void fetch(`/api/history?${params}`,{signal:controller.signal}).then(async r=>{const payload=await r.json();if(!r.ok)throw Error(payload.error??tr("تعذر تحميل الحركات"));if(!controller.signal.aborted){setLoaded(payload.rows);setPages(payload.totalPages||1);setError("");}}).catch(e=>{if(!controller.signal.aborted)setError(e.message)}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});
    return()=>controller.abort();
  },[context.productId,context.lotId,context.conversionId,data.documents,showVoided,showRevisions,page]);
  const related=relatedPerfumeDocuments(data.documents,context);
  const documents=loaded??(showRevisions?related:currentPerfumeOperations(related,showVoided));
  return <fieldset className="erp-fieldset pm-context"><legend>{tr(context.lotId?"تفاصيل الدفعة":"حركات الزجاجة")} · {context.name}</legend>
    <div className="pm-section-head"><p className="pm-hint">{tr("كل حركة مرتبطة بمستندها الأصلي. التعديل والإلغاء يعكسان أثره دون إنشاء سجل مكرر.")}</p><label className="pm-check"><input type="checkbox" checked={showVoided} onChange={e=>{setShowVoided(e.target.checked);setPage(1);setLoading(true)}}/>{tr("إظهار الملغى")}</label><label className="pm-check"><input type="checkbox" checked={showRevisions} onChange={e=>{setShowRevisions(e.target.checked);setPage(1);setLoading(true)}}/>{tr("تاريخ التعديل")}</label><button type="button" className="soft" onClick={close}>{tr("إغلاق")}</button></div>
    {error&&<p role="alert" className="error">{error}</p>}{loading&&<p role="status">{tr("جاري تحميل الحركات…")}</p>}
    <div className="erp-table-wrap pm-table-scroll"><table className="erp-table"><thead><tr><th>{tr("التاريخ / المستند")}</th><th>{tr("العملية")}</th><th>{tr("الحركة")}</th><th>{tr("الحالة")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>{documents.map(d=>{const kind=managementKind(d);return <tr key={d.id}><td><span dir="ltr">{displayDocumentNumber(d)}</span><small>{formatDateTime(d.occurredAt)}</small></td><td>{tr(kind?managementLabel[kind]:kindLabels[d.kind]??d.kind)}<small>{d.note||d.title||d.partyName}</small></td><td>{changeLabel(d,context,data)}{Number(d.inventoryLoss)>0&&<small>{tr("الخسارة")}: {money(d.inventoryLoss??0)}</small>}{Number(d.inventoryGain)>0&&<small>{tr("فرق جرد موجب")}: {money(d.inventoryGain??0)}</small>}</td><td>{tr(d.replacedByDocumentId?"pm.superseded":d.status==="posted"?"pm.posted":"pm.voided")}</td><td><div className="pm-row-actions"><button type="button" className="soft pm-row-action pm-icon-action" title={tr("عرض المستند")} aria-label={tr("عرض المستند")} onClick={()=>openDoc(d.id)}><FileText/></button>{perfumeActionPermission(d,permissions,owner,"edit")&&<button type="button" className="soft pm-row-action pm-icon-action" title={tr("تعديل")} aria-label={tr("تعديل")} disabled={busy||(!kind&&!onSource)} onClick={()=>kind?onEdit(d):onSource?.(d)}><PencilLine/></button>}{perfumeActionPermission(d,permissions,owner,"void")&&<button type="button" className="soft danger pm-row-action pm-icon-action" title={tr("إلغاء العملية")} aria-label={tr("إلغاء العملية")} disabled={busy} onClick={()=>onVoid(d)}><X/></button>}</div></td></tr>})}{!documents.length&&!loading&&<tr><td colSpan={5}>{tr("لا توجد حركات")}</td></tr>}</tbody></table></div>
    {pages>1&&<div className="pm-form-actions"><button type="button" className="soft" disabled={page<=1} onClick={()=>{setPage(p=>p-1);setLoading(true)}}>{tr("السابق")}</button><span>{page} / {pages}</span><button type="button" className="soft" disabled={page>=pages} onClick={()=>{setPage(p=>p+1);setLoading(true)}}>{tr("التالي")}</button></div>}
  </fieldset>;
}
