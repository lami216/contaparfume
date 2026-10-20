"use client";

import { useMemo, useRef, useState } from "react";
import { activeProducts, activeWarehouses, displayDocumentNumber, formatDateTime, inventoryUnitCost, money, quantity, stockInWarehouse, type BootstrapData, type DocumentRecord } from "./domain";
import { divisionLiquidCost, lotRemainingTotal } from "./perfume-logic";
import { managementInputFor, managementKind, managementLabel, managementPostType, type ManagementKind } from "./perfume-management";
import { useAppConfirm } from "./app-confirm";
import { useI18n } from "./i18n/provider";
import { tr } from "./i18n/messages";
import { translateApiError } from "./i18n/api-errors";
import PerfumeProductPicker from "./perfume-product-picker";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;
type Props = { data: BootstrapData; run: RunCommand; openDoc?: (id: string) => void; editRequest?: string | null; clearEditRequest?: () => void };
type Tab = "convert" | "bottles" | "stock" | "history";
type Values = Record<string, string | boolean>;
const tabFor = (kind: ManagementKind): Tab => ["split", "recombine"].includes(kind) ? "convert" : ["bottle", "bottle-stock"].includes(kind) ? "bottles" : "stock";
const blank = (warehouseId: string): Values => ({ sourceProductId:"",decantProductId:"",lotId:"",warehouseId,divisionsCount:"10",salePrice:"",name:"",sizeMl:"10",cost:"",quantity:"",remainingValue:"",actualQuantity:"",reason:"",reasonCode:"samples",consumeBottle:false,bottleProductId:"",note:"" });
const normalize = (values: Record<string, unknown>): Values => Object.fromEntries(Object.entries(values).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,typeof v==="boolean"?v:String(v)]));
const bottleSnapshot = (p: BootstrapData["products"][number]) => ({name:p.name,sizeMl:p.decantSizeMl,cost:p.pieceCost,isArchived:p.isArchived===true});

export default function PerfumeDivisions({ data, run, openDoc, editRequest, clearEditRequest }: Props) {
  const {locale}=useI18n(), confirm=useAppConfirm();
  const warehouses=activeWarehouses(data.warehouses),defaultWarehouse=warehouses.find(w=>w.isSalesDefault)?.id??warehouses[0]?.id??"";
  const initialDocument=editRequest?data.documents.find(d=>d.id===editRequest&&managementKind(d)):undefined;
  const initialEditing=initialDocument?.status==="posted"?initialDocument:undefined;
  const initialKind=initialDocument?managementKind(initialDocument)!:"split";
  const initialBottle=initialEditing&&initialKind==="bottle"?data.products.find(p=>p.id===initialEditing.managementProductId):undefined;
  const [tab,setTab]=useState<Tab>(initialDocument&&!initialEditing?"history":tabFor(initialKind)),[kind,setKind]=useState<ManagementKind>(initialKind);
  const [editing,setEditing]=useState<DocumentRecord|undefined>(initialEditing),[bottleEdit,setBottleEdit]=useState(initialBottle?.id??"");
  const [bottleExpected,setBottleExpected]=useState<ReturnType<typeof bottleSnapshot>|undefined>(()=>initialBottle?bottleSnapshot(initialBottle):undefined);
  const [values,setValues]=useState<Values>(()=>({...blank(defaultWarehouse),...(initialEditing?normalize(managementInputFor(initialEditing,data.products)): {})}));
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const locked=useRef(false);
  const [search,setSearch]=useState(""),[historyType,setHistoryType]=useState("all"),[historyStatus,setHistoryStatus]=useState("all"),[archived,setArchived]=useState(false);
  const canManage=data.principal.principalType==="owner"||data.principal.permissions.includes("perfume.divisions.manage");
  const sources=activeProducts(data.products).filter(p=>!["decant","partial","bottle"].includes(p.perfumeForm??""));
  const bottles=data.products.filter(p=>p.perfumeForm==="bottle");
  const activeBottles=bottles.filter(p=>!p.isArchived);
  const batches=useMemo(()=>data.products.filter(p=>p.perfumeForm==="decant"&&!p.isArchived).flatMap(product=>(product.perfumeLots??[]).map(lot=>({product,lot}))),[data.products]);
  const operations=useMemo(()=>data.documents.filter(d=>managementKind(d)).sort((a,b)=>String(b.occurredAt).localeCompare(String(a.occurredAt))||b.id.localeCompare(a.id)),[data.documents]);
  const needle=search.trim().toLocaleLowerCase(),text=(field:string)=>String(values[field]??""),n=(field:string)=>Number(text(field));
  const set=(field:string,value:string|boolean)=>{setValues(v=>({...v,[field]:value}));setDirty(true);setError("")};
  const source=sources.find(p=>p.id===text("sourceProductId"));
  const selectedBatch=batches.find(b=>b.product.id===text("decantProductId")&&b.lot.id===text("lotId"));
  const lot=selectedBatch?.lot,warehouseId=text("warehouseId");
  const sourceCost=source?inventoryUnitCost(source):0;
  const liquidCost=sourceCost>0&&Number.isSafeInteger(n("divisionsCount"))&&n("divisionsCount")>0?divisionLiquidCost(sourceCost,n("divisionsCount")):0;
  const lotStock=Number(lot?.stocks?.[warehouseId]??0),bookValue=Number(lot?.remainingQuantity??0)*Number(lot?.liquidUnitCost??0);
  const selectedBottle=bottles.find(p=>p.id===text("bottleProductId"));
  const formTitle=tr(managementLabel[kind]);
  const batchItems=batches.map(b=>({id:`${b.product.id}::${b.lot.id}`,name:b.lot.sourceProductName,meta:`${formatDateTime(b.lot.createdAt)} · ${tr("pm.remaining")}: ${quantity(lotRemainingTotal(b.lot))} · ${b.lot.id.slice(-6)}`}));

  async function mayDiscard(){return !dirty||await confirm({message:tr("pm.discard"),tone:"warning"})}
  function reset(){setEditing(undefined);setBottleEdit("");setBottleExpected(undefined);setValues(blank(defaultWarehouse));setDirty(false);setError("");clearEditRequest?.()}
  async function choose(next:ManagementKind,seed:Record<string,unknown>={},document?:DocumentRecord,productId=""){
    if(busy||!await mayDiscard())return;
    setKind(next);setTab(tabFor(next));setValues({...blank(defaultWarehouse),...normalize(seed)});setEditing(document);setBottleEdit(productId);setDirty(false);setError("");setSearch("");
    const selected=bottles.find(p=>p.id===productId);setBottleExpected(selected?bottleSnapshot(selected):undefined);
  }
  async function switchTab(next:Tab){if(busy||!await mayDiscard())return;reset();setTab(next);setKind(next==="bottles"?"bottle":next==="stock"?"opening":"split");setSearch("")}
  const process=async(body:Record<string,unknown>,after?:()=>void)=>{
    if(locked.current||!canManage)return;locked.current=true;setBusy(true);setError("");
    try{await run(body,tr("pm.saved"));setDirty(false);after?.()}catch(e){setError(translateApiError(locale,e instanceof Error?e.message:tr("pm.failed")))}finally{locked.current=false;setBusy(false)}
  };
  function validate():boolean{
    const good=(key:string,integer=false,zero=false)=>text(key).trim()!==""&&Number.isFinite(n(key))&&(integer?Number.isSafeInteger(n(key)):true)&&(zero?n(key)>=0:n(key)>0);
    let valid=kind==="bottle"?!!text("name").trim()&&good("sizeMl")&&good("cost"):!!warehouseId;
    if(kind==="split")valid=valid&&!!source&&good("divisionsCount",true)&&n("divisionsCount")>=2&&good("salePrice")&&liquidCost>0;
    if(kind==="opening")valid=valid&&!!source&&good("quantity",true)&&good("remainingValue")&&good("salePrice");
    if(kind==="recombine")valid=valid&&!!selectedBatch&&good("salePrice");
    if(kind==="consumption"||kind==="yield-correction")valid=valid&&!!selectedBatch&&!!text("reason").trim()&&good(kind==="consumption"?"quantity":"actualQuantity",true,kind==="yield-correction")&&(kind!=="consumption"||!values.consumeBottle||!!text("bottleProductId"));
    if(kind==="bottle-stock")valid=valid&&!!selectedBottle&&good("actualQuantity",true,true)&&!!text("reason").trim()&&(!(n("actualQuantity")>stockInWarehouse(selectedBottle!,warehouseId))||good("cost"));
    if(!valid)setError(tr("pm.invalid"));return valid;
  }
  async function save(){
    if(!validate())return;
    const payload:Record<string,unknown>={...values,type:editing?"perfume-management.update":managementPostType[kind],...(editing?{documentId:editing.id,expectedRevision:editing.revision??0}:{})};
    const bottle=bottles.find(p=>p.id===bottleEdit);
    if(bottle){payload.type="perfume-bottle.update";payload.id=bottle.id;payload.expectedProduct=bottleExpected}
    if(editing&&!await confirm({message:tr("pm.editConfirm"),tone:"warning"}))return;
    await process(payload,()=>{reset();setTab("history")});
  }
  async function edit(document:DocumentRecord){
    const k=managementKind(document)!;const p=k==="bottle"?bottles.find(b=>b.id===document.managementProductId):undefined;
    await choose(k,managementInputFor(document,data.products),document,p?.id??"");
  }
  async function voidDocument(document:DocumentRecord){
    if(!await confirm({message:tr("pm.voidConfirm"),confirmLabel:tr("pm.void"),tone:"danger"}))return;
    await process({type:"perfume-management.void",documentId:document.id,expectedRevision:document.revision??0});
  }
  const field=(key:string,label:string,options:{integer?:boolean;zero?:boolean;type?:string}={})=><label>{label}<input value={text(key)} onChange={e=>set(key,e.target.value)} type={options.type??"number"} min={options.type?undefined:options.zero?"0":options.integer?"1":"0.000001"} step={options.integer?"1":"any"} inputMode={options.type?undefined:options.integer?"numeric":"decimal"}/></label>;
  const selectWarehouse=<label>{tr("المخزن")}<select value={warehouseId} onChange={e=>set("warehouseId",e.target.value)}><option value="">{tr("اختر المخزن")}</option>{warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>;
  const selectSource=<label>{tr("العطر")}<PerfumeProductPicker items={sources.map(p=>({id:p.id,name:p.name,meta:`${tr("المتوفر")}: ${quantity(stockInWarehouse(p,warehouseId))}`}))} value={text("sourceProductId")} onChange={v=>set("sourceProductId",v)} placeholder={tr("اختر العطر")} ariaLabel={tr("العطر")}/></label>;
  const selectBatch=<label>{tr("pm.batch")}<PerfumeProductPicker items={batchItems} value={text("decantProductId")?`${text("decantProductId")}::${text("lotId")}`:""} onChange={v=>{const [productId,lotId]=v.split("::");set("decantProductId",productId??"");set("lotId",lotId??"")}} placeholder={tr("pm.chooseBatch")} ariaLabel={tr("pm.batch")}/></label>;
  const selectBottle=<label>{tr("الزجاجة")}<select value={text("bottleProductId")} onChange={e=>{set("bottleProductId",e.target.value);const p=bottles.find(b=>b.id===e.target.value);if(p)set("cost",String(p.lastPurchaseCost??p.pieceCost??""))}}><option value="">{tr("pm.chooseBottle")}</option>{activeBottles.map(b=><option key={b.id} value={b.id}>{b.name} · {quantity(stockInWarehouse(b,warehouseId))}</option>)}</select></label>;
  const open=(id:string)=>openDoc?.(id);
  return <section className="perfume-divisions-page perfume-management-page">
    <header className="pm-header"><div><h2>{tr("pm.title")}</h2><p>{tr("pm.subtitle")}</p></div><div className="pm-overview"><span>{tr("pm.batches")}: <b>{quantity(batches.filter(b=>lotRemainingTotal(b.lot)>0).length)}</b></span><span>{tr("زجاج التقسيمات")}: <b>{quantity(activeBottles.length)}</b></span><span>{tr("pm.operations")}: <b>{quantity(operations.length)}</b></span></div></header>
    <nav className="pm-tabs" aria-label={tr("pm.title")}>{(["convert","stock","bottles","history"] as const).map(t=><button key={t} type="button" aria-pressed={tab===t} className={tab===t?"primary":"soft"} disabled={busy} onClick={()=>void switchTab(t)}>{tr(`pm.tab.${t}`)}</button>)}</nav>
    {!canManage&&<p className="pm-hint">{tr("pm.readOnly")}</p>}
    {error&&<div className="error perfume-local-error" role="alert">{error}</div>}
    {tab!=="history"&&<div className="pm-workspace">
      <form className="panel pm-editor" onSubmit={event=>{event.preventDefault();void save()}}>
        <div className="pm-section-head"><h3>{editing||bottleEdit?`${tr("تعديل")} — ${formTitle}`:formTitle}</h3>{(editing||bottleEdit)&&<button type="button" className="soft" disabled={busy} onClick={()=>void choose(kind)}>{tr("إلغاء")}</button>}</div>
        {!editing&&!bottleEdit&&<div className="pm-kind-tabs">{(tab==="convert"?["split","recombine"]:tab==="bottles"?["bottle","bottle-stock"]:["opening","consumption","yield-correction"]).map(k=><button type="button" className={kind===k?"primary":"soft"} disabled={busy} key={k} onClick={()=>void choose(k as ManagementKind)}>{tr(managementLabel[k as ManagementKind])}</button>)}</div>}
        <fieldset disabled={busy||!canManage} className="pm-fields">
          {kind!=="bottle"&&selectWarehouse}
          {(kind==="split"||kind==="opening")&&selectSource}
          {kind==="split"&&field("divisionsCount",tr("عدد التقسيمات"),{integer:true})}
          {["split","opening","recombine"].includes(kind)&&field("salePrice",tr(kind==="recombine"?"سعر بيع العطر الناقص":"سعر البيع للتقسيمة"))}
          {["recombine","consumption","yield-correction"].includes(kind)&&selectBatch}
          {kind==="bottle"&&<>{field("name",tr("اسم الزجاجة"),{type:"text"})}{field("sizeMl",tr("الحجم (ml)"))}{field("cost",tr("التكلفة المرجعية"))}<p className="pm-hint">{tr("pm.bottleHelp")}</p></>}
          {kind==="bottle-stock"&&<>{selectBottle}{field("actualQuantity",tr("pm.actual"),{integer:true,zero:true})}{field("cost",tr("pm.addedCost"),{zero:true})}<p className="pm-hint">{tr("pm.stockHelp")}</p></>}
          {kind==="opening"&&<>{field("quantity",tr("pm.actual"),{integer:true})}{field("remainingValue",tr("pm.remainingValue"))}<p className="pm-hint">{tr("pm.openingHelp")}</p></>}
          {kind==="consumption"&&<>{field("quantity",tr("pm.quantityOut"),{integer:true})}<label>{tr("pm.reasonCode")}<select value={text("reasonCode")} onChange={e=>set("reasonCode",e.target.value)}>{["samples","waste","leak","internal","stock-difference","other"].map(r=><option value={r} key={r}>{tr(`pm.reason.${r}`)}</option>)}</select></label><label className="pm-check"><input type="checkbox" checked={values.consumeBottle===true} onChange={e=>set("consumeBottle",e.target.checked)}/>{tr("pm.consumeBottle")}</label>{values.consumeBottle&&selectBottle}</>}
          {kind==="yield-correction"&&<>{field("actualQuantity",tr("pm.actual"),{integer:true,zero:true})}<p className="pm-hint">{tr("pm.correctHelp")}</p></>}
          {["consumption","yield-correction","bottle-stock"].includes(kind)&&field("reason",tr("سبب التصحيح"),{type:"text"})}
          <label className="pm-wide">{tr("ملاحظة")}<textarea rows={2} maxLength={1000} value={text("note")} onChange={e=>set("note",e.target.value)}/></label>
        </fieldset>
        {kind==="split"&&<div className="pm-summary"><span>{tr("pm.sourceValue")}: <b>{money(sourceCost)}</b></span><span>{tr("تكلفة السائل للتقسيمة")}: <b>{money(liquidCost)}</b></span><small>{tr("لا تشمل الزجاجة")}</small></div>}
        {selectedBatch&&<div className="pm-summary"><span>{tr("pm.stockInWarehouse")}: <b>{quantity(lotStock)}</b></span><span>{tr("pm.remainingValue")}: <b>{money(bookValue)}</b></span>{kind==="recombine"&&<small>{tr("pm.recombineHelp")}</small>}</div>}
        <footer className="pm-form-actions"><button type="submit" className="primary" disabled={busy||!canManage}>{busy?tr("جاري الحفظ…"):editing||bottleEdit?tr("pm.saveEdit"):tr("pm.post")}</button>{editing&&<button type="button" className="soft" onClick={()=>open(editing.id)}>{tr("pm.view")}</button>}</footer>
      </form>
      <section className="panel pm-register">
        <div className="pm-section-head"><h3>{tr(tab==="bottles"?"زجاج التقسيمات":"pm.batches")}</h3><label className="pm-search"><span>{tr("بحث")}</span><input value={search} onChange={e=>setSearch(e.target.value)} /></label>{tab==="bottles"&&<label className="pm-check"><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>{tr("pm.showArchived")}</label>}</div>
        <div className="erp-table-wrap pm-table-scroll"><table className="erp-table"><thead>{tab==="bottles"?<tr><th>{tr("الزجاجة")}</th><th>{tr("الحجم")}</th><th>{tr("المخزون")}</th><th>{tr("إجراء")}</th></tr>:<tr><th>{tr("pm.batch")}</th><th>{tr("pm.remaining")}</th><th>{tr("تكلفة السائل")}</th><th>{tr("إجراء")}</th></tr>}</thead>
          <tbody>{tab==="bottles"?bottles.filter(b=>(archived||!b.isArchived)&&b.name.toLocaleLowerCase().includes(needle)).map(b=><tr key={b.id}><td>{b.name}{b.isArchived&&<small>{tr("pm.archived")}</small>}</td><td className="num-cell">{quantity(Number(b.decantSizeMl??0))} ml</td><td className="num-cell">{quantity(stockInWarehouse(b,warehouseId))}</td><td><div className="pm-row-actions">{b.isArchived?<button type="button" className="soft" disabled={busy||!canManage} onClick={()=>void process({type:"perfume-bottle.restore",id:b.id})}>{tr("pm.restore")}</button>:<><button type="button" className="soft" disabled={busy||!canManage} onClick={()=>void choose("bottle",{name:b.name,sizeMl:b.decantSizeMl,cost:b.pieceCost},undefined,b.id)}>{tr("تعديل")}</button><button type="button" className="soft" disabled={busy||!canManage} onClick={()=>void choose("bottle-stock",{bottleProductId:b.id,warehouseId,actualQuantity:stockInWarehouse(b,warehouseId),cost:b.lastPurchaseCost??b.pieceCost})}>{tr("تصحيح الكمية")}</button><button type="button" className="soft danger" disabled={busy||!canManage} onClick={()=>void (async()=>{if(await confirm({message:tr("pm.archiveConfirm"),tone:"danger"}))await process({type:"perfume-bottle.archive",id:b.id,expectedProduct:bottleSnapshot(b)})})()}>{tr("pm.archive")}</button></>}</div></td></tr>):batches.filter(b=>[b.lot.sourceProductName,b.lot.id].join(" ").toLocaleLowerCase().includes(needle)).map(b=><tr key={b.lot.id}><td>{b.lot.sourceProductName}<small>{formatDateTime(b.lot.createdAt)} · {b.lot.id.slice(-6)}</small></td><td className="num-cell">{quantity(lotRemainingTotal(b.lot))}</td><td className="num-cell">{money(b.lot.liquidUnitCost)}</td><td><div className="pm-row-actions"><button type="button" className="soft" onClick={()=>open(b.lot.conversionDocumentId)}>{tr("pm.source")}</button><button type="button" className="soft" disabled={busy||!canManage||lotRemainingTotal(b.lot)<=0} onClick={()=>void choose(tab==="stock"?"consumption":"recombine",{decantProductId:b.product.id,lotId:b.lot.id,warehouseId:Object.entries(b.lot.stocks).find(([,q])=>q>0)?.[0]??defaultWarehouse})}>{tr(tab==="stock"?"pm.consumption":"pm.recombine")}</button></div></td></tr>)}</tbody></table></div>
        <p className="pm-hint">{tr(tab==="bottles"?"pm.bottleRegisterHelp":"pm.batchRegisterHelp")}</p>
      </section>
    </div>}
    {tab==="history"&&<section className="panel pm-history"><div className="pm-section-head"><h3>{tr("pm.history")}</h3><label>{tr("بحث")}<input value={search} onChange={e=>setSearch(e.target.value)}/></label><label>{tr("النوع")}<select value={historyType} onChange={e=>setHistoryType(e.target.value)}><option value="all">{tr("pm.all")}</option>{Object.keys(managementLabel).map(k=><option value={k} key={k}>{tr(managementLabel[k as ManagementKind])}</option>)}</select></label><label>{tr("الحالة")}<select value={historyStatus} onChange={e=>setHistoryStatus(e.target.value)}><option value="all">{tr("pm.all")}</option><option value="posted">{tr("pm.posted")}</option><option value="voided">{tr("pm.voided")}</option></select></label></div>
      <p className="pm-hint">{tr("pm.historyHelp")}</p><div className="erp-table-wrap pm-table-scroll"><table className="erp-table"><thead><tr><th>{tr("المستند")}</th><th>{tr("النوع")}</th><th>{tr("المخزن")}</th><th>{tr("ملاحظة")}</th><th>{tr("الحالة")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>{operations.filter(d=>(historyType==="all"||managementKind(d)===historyType)&&(historyStatus==="all"||d.status===historyStatus)&&[d.number,d.title,d.note,...d.lines.map(l=>l.description)].join(" ").toLocaleLowerCase().includes(needle)).map(d=><tr key={d.id}><td>{displayDocumentNumber(d)}<small>{formatDateTime(d.occurredAt)}</small></td><td>{tr(managementLabel[managementKind(d)!])}<small>{d.lines[0]?.description}</small></td><td>{d.warehouseName??"—"}</td><td className="pm-note" title={d.note??d.title??""}>{d.note||d.title||"—"}</td><td>{tr(d.replacedByDocumentId?"pm.superseded":d.status==="posted"?"pm.posted":"pm.voided")}</td><td><div className="pm-row-actions"><button type="button" className="soft" onClick={()=>open(d.id)}>{tr("pm.view")}</button>{d.replacedByDocumentId&&<button type="button" className="soft" onClick={()=>open(d.replacedByDocumentId!)}>{tr("pm.newRevision")}</button>}{d.status==="posted"&&<><button type="button" className="soft" disabled={busy||!canManage} onClick={()=>void edit(d)}>{tr("تعديل")}</button><button type="button" className="soft danger" disabled={busy||!canManage} onClick={()=>void voidDocument(d)}>{tr("pm.void")}</button></>}</div></td></tr>)}</tbody></table></div>{operations.length===0&&<p>{tr("pm.emptyHistory")}</p>}
    </section>}
  </section>;
}
