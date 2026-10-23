"use client";

import { useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, ArrowUpRight, FileText, PencilLine, RotateCcw, Search, SlidersHorizontal, X, type LucideIcon } from "lucide-react";
import { activeProducts, activeWarehouses, displayDocumentNumber, formatDateTime, inventoryUnitCost, money, quantity, stockInWarehouse, type BootstrapData, type DocumentRecord } from "./domain";
import { divisionLiquidCost, lotRemainingTotal } from "./perfume-logic";
import { bottleStockReasonLabels, documentUsesPerfumeLot, isBottleStockReason, managementInputFor, managementKind, managementLabel, managementPostType, type ManagementKind } from "./perfume-management";
import { useAppConfirm } from "./app-confirm";
import { useI18n } from "./i18n/provider";
import { tr } from "./i18n/messages";
import { translateApiError } from "./i18n/api-errors";
import PerfumeProductPicker from "./perfume-product-picker";
import PerfumeDefaultsEditor from "./perfume-defaults-editor";
import { DEFAULT_PERFUME_SETTINGS, roundMl } from "./perfume-volume";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;
type Props = { data: BootstrapData; run: RunCommand; openDoc?: (id: string) => void; editRequest?: string | null; clearEditRequest?: () => void };
type Tab = "convert" | "bottles" | "stock" | "history";
type Values = Record<string, string | boolean>;
const tabFor = (kind: ManagementKind): Tab => ["split", "recombine"].includes(kind) ? "convert" : ["bottle", "bottle-stock"].includes(kind) ? "bottles" : "stock";
const blank = (warehouseId: string): Values => ({ sourceProductId:"",decantProductId:"",lotId:"",warehouseId,divisionsCount:"10",volumeMl:"",legacyPortionMl:"10",salePrice:"",name:"",sizeMl:"10",cost:"",quantity:"",remainingValue:"",actualQuantity:"",reason:"",reasonCode:"samples",bottleStockReason:"",consumeBottle:false,bottleQuantity:"1",bottleProductId:"",note:"" });
const normalize = (values: Record<string, unknown>): Values => Object.fromEntries(Object.entries(values).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,typeof v==="boolean"?v:String(v)]));
const bottleSnapshot = (p: BootstrapData["products"][number]) => ({name:p.name,sizeMl:p.decantSizeMl,cost:p.pieceCost,isArchived:p.isArchived===true});
const shortKindLabel: Record<ManagementKind, string> = {split:"pm.short.split",recombine:"pm.short.recombine",opening:"pm.short.opening",consumption:"pm.short.consumption","yield-correction":"pm.short.correction",bottle:"pm.short.bottle","bottle-stock":"pm.short.bottleStock"};

function RowAction({label, icon: Icon, text, disabled, danger, onClick}: {label: string; icon: LucideIcon; text?: string; disabled?: boolean; danger?: boolean; onClick: () => void}) {
  return <button type="button" className={`soft pm-row-action${danger?" danger":""}${text?"":" pm-icon-action"}`} title={label} aria-label={label} disabled={disabled} onClick={onClick}><Icon aria-hidden="true"/>{text&&<span>{text}</span>}</button>;
}

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
  const operationsById=useMemo(()=>new Map(operations.map(document=>[document.id,document])),[operations]);
  const needle=search.trim().toLocaleLowerCase(),text=(field:string)=>String(values[field]??""),n=(field:string)=>Number(text(field));
  const set=(field:string,value:string|boolean)=>{setValues(v=>({...v,[field]:value}));setDirty(true);setError("")};
  const source=sources.find(p=>p.id===text("sourceProductId"));
  const selectedBatch=batches.find(b=>b.product.id===text("decantProductId")&&b.lot.id===text("lotId"));
  const lot=selectedBatch?.lot,warehouseId=text("warehouseId");
  const ml=lot?.quantityUnit==="ml",legacyEdit=Boolean(editing&&editing.quantityUnit!=="ml"),defaults=data.perfumeDefaults??DEFAULT_PERFUME_SETTINGS;
  const sourceCost=source?inventoryUnitCost(source):0;
  const splitQuantity=legacyEdit?n("divisionsCount"):n("volumeMl");
  const liquidCost=sourceCost>0&&splitQuantity>0?(legacyEdit?divisionLiquidCost(sourceCost,splitQuantity):sourceCost/splitQuantity):0;
  const lotStock=Number(lot?.stocks?.[warehouseId]??0),bookValue=Number(lot?.remainingQuantity??0)*Number(lot?.liquidUnitCost??0);
  const selectedBottle=bottles.find(p=>p.id===text("bottleProductId"));
  const editingSameBottle=editing&&managementKind(editing)==="bottle-stock"&&editing.managementProductId===selectedBottle?.id&&editing.warehouseId===warehouseId;
  const priorBottleLine=editingSameBottle?editing.lines.find(line=>line.productId===selectedBottle?.id):undefined;
  const bottleBefore=Number(priorBottleLine?.balanceBefore??(selectedBottle?stockInWarehouse(selectedBottle,warehouseId):0));
  const bottleCost=Number(priorBottleLine?.unitPrice??(selectedBottle?inventoryUnitCost(selectedBottle):0));
  const physicalBottleLoss=["breakage","damage"].includes(text("bottleStockReason"));
  const bottleLoss=physicalBottleLoss&&text("actualQuantity").trim()!==""?Math.max(0,bottleBefore-n("actualQuantity"))*bottleCost:0;
  const formTitle=tr(managementLabel[kind]);
  const batchItems=batches.map(b=>({id:`${b.product.id}::${b.lot.id}`,name:b.lot.sourceProductName,meta:`${formatDateTime(b.lot.createdAt)} · ${tr("pm.remaining")}: ${quantity(lotRemainingTotal(b.lot))} ${b.lot.quantityUnit==="ml"?tr("مل"):tr("تقسيمة")} · ${b.lot.id.slice(-6)}`}));

  async function mayDiscard(){return !dirty||await confirm({message:tr("pm.discard"),tone:"warning"})}
  function reset(){setEditing(undefined);setBottleEdit("");setBottleExpected(undefined);setValues(blank(defaultWarehouse));setDirty(false);setError("");clearEditRequest?.()}
  async function choose(next:ManagementKind,seed:Record<string,unknown>={},document?:DocumentRecord,productId=""){
    if(busy||!await mayDiscard())return;
    const selected=batches.find(batch=>batch.product.id===seed.decantProductId&&batch.lot.id===seed.lotId);
    const wh=String(seed.warehouseId??defaultWarehouse);
    setKind(next);setTab(tabFor(next));setValues({...blank(defaultWarehouse),...(selected?{actualQuantity:String(selected.lot.stocks[wh]??0)}:{}),...normalize(seed)});setEditing(document);setBottleEdit(productId);setDirty(false);setError("");setSearch("");
    const selectedBottle=bottles.find(p=>p.id===productId);setBottleExpected(selectedBottle?bottleSnapshot(selectedBottle):undefined);
  }
  async function switchTab(next:Tab){if(busy||!await mayDiscard())return;reset();setTab(next);setKind(next==="bottles"?"bottle":next==="stock"?"opening":"split");setSearch("")}
  const process=async(body:Record<string,unknown>,after?:()=>void)=>{
    if(locked.current||!canManage)return;locked.current=true;setBusy(true);setError("");
    try{await run(body,tr("pm.saved"));setDirty(false);after?.()}catch(e){setError(translateApiError(locale,e instanceof Error?e.message:tr("pm.failed")))}finally{locked.current=false;setBusy(false)}
  };
  function validate():boolean{
    const good=(key:string,integer=false,zero=false)=>text(key).trim()!==""&&Number.isFinite(n(key))&&(integer?Number.isSafeInteger(n(key)):true)&&(zero?n(key)>=0:n(key)>0);
    let valid=kind==="bottle"?!!text("name").trim()&&good("sizeMl")&&good("cost"):!!warehouseId;
    if(kind==="split")valid=valid&&!!source&&good(legacyEdit?"divisionsCount":"volumeMl",legacyEdit)&&good("salePrice")&&liquidCost>0;
    if(kind==="opening")valid=valid&&!!source&&good(legacyEdit?"quantity":"volumeMl",legacyEdit)&&good("remainingValue")&&good("salePrice");
    if(kind==="recombine")valid=valid&&!!selectedBatch&&(ml?good("actualQuantity",false,true)&&(n("actualQuantity")===0||good("salePrice"))&&(n("actualQuantity")===lotStock||!!text("reason").trim()):good("salePrice"));
    if(kind==="consumption")valid=valid&&!!selectedBatch&&!!text("reason").trim()&&good("quantity",!ml)&&(!values.consumeBottle||!!text("bottleProductId")&&good("bottleQuantity",true));
    if(kind==="yield-correction")valid=valid&&!!selectedBatch&&(ml?good("actualQuantity",false,true)&&(n("actualQuantity")===lotStock||!!text("reason").trim()):good("legacyPortionMl"));
    if(kind==="bottle-stock")valid=valid&&!!selectedBottle&&good("actualQuantity",true,true)&&!!text("reason").trim()&&isBottleStockReason(text("bottleStockReason"))&&(!physicalBottleLoss||n("actualQuantity")<bottleBefore&&bottleCost>0);
    if(!valid)setError(tr("pm.invalid"));return valid;
  }
  async function save(){
    if(!validate())return;
    const payload:Record<string,unknown>={...values,type:editing?"perfume-management.update":managementPostType[kind],...(editing?{documentId:editing.id,expectedRevision:editing.revision??0}:{})};
    if(!["split","opening"].includes(kind)||legacyEdit)delete payload.volumeMl;
    if(!legacyEdit&&["split","opening"].includes(kind))payload.priceBasisMl=defaults.fillMl;
    if(kind==="yield-correction"&&!ml&&!editing){
      if(!await confirm({message:tr("سيتم تحويل وحدة الرصيد إلى المل مع حفظ قيمته وسجله")+` (${quantity(lotStock)} × ${text("legacyPortionMl")} ${tr("مل")})`}))return;
      payload.type="perfume-volume.migrate";
    }
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
    if(busy||!await mayDiscard())return;
    const split=managementKind(document)==="split";
    if(!await confirm({message:tr(split?"pm.cancelSplitConfirm":"pm.voidConfirm"),confirmLabel:tr(split?"pm.cancelSplit":"pm.void"),tone:"danger"}))return;
    await process({type:"perfume-management.void",documentId:document.id,expectedRevision:document.revision??0},()=>reset());
  }
  const field=(key:string,label:string,options:{integer?:boolean;zero?:boolean;type?:string}={})=><label>{label}<input value={text(key)} onChange={e=>set(key,e.target.value)} type={options.type??"number"} min={options.type?undefined:options.zero?"0":options.integer?"1":"0.000001"} step={options.integer?"1":"any"} inputMode={options.type?undefined:options.integer?"numeric":"decimal"}/></label>;
  const selectWarehouse=<label className="pm-wide">{tr("المخزن")}<select value={warehouseId} onChange={e=>{setValues(v=>({...v,warehouseId:e.target.value,...(lot?{actualQuantity:String(lot.stocks[e.target.value]??0)}:{})}));setDirty(true)}}><option value="">{tr("اختر المخزن")}</option>{warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>;
  const selectSource=<label className="pm-wide">{tr("العطر")}<PerfumeProductPicker items={sources.map(p=>({id:p.id,name:p.name,meta:`${tr("المتوفر")}: ${quantity(stockInWarehouse(p,warehouseId))}`}))} value={text("sourceProductId")} onChange={value=>{const p=sources.find(p=>p.id===value);setValues(v=>({...v,sourceProductId:value,...(p?.perfumeBottleVolumeMl?{volumeMl:String(p.perfumeBottleVolumeMl)}:{})}));setDirty(true)}} placeholder={tr("اختر العطر")} ariaLabel={tr("العطر")}/></label>;
  const selectBatch=<label className="pm-wide">{tr("pm.batch")}<PerfumeProductPicker items={batchItems} value={text("decantProductId")?`${text("decantProductId")}::${text("lotId")}`:""} onChange={value=>{const [productId,lotId]=value.split("::"),batch=batches.find(b=>b.product.id===productId&&b.lot.id===lotId);setValues(v=>({...v,decantProductId:productId??"",lotId:lotId??"",actualQuantity:String(batch?.lot.stocks[warehouseId]??0)}));setDirty(true)}} placeholder={tr("pm.chooseBatch")} ariaLabel={tr("pm.batch")}/></label>;
  const selectBottle=<label>{tr("الزجاجة")}<select value={text("bottleProductId")} onChange={e=>{set("bottleProductId",e.target.value);const p=bottles.find(b=>b.id===e.target.value);if(p)set("cost",String(p.lastPurchaseCost??p.pieceCost??""))}}><option value="">{tr("pm.chooseBottle")}</option>{activeBottles.map(b=><option key={b.id} value={b.id}>{b.name} · {quantity(stockInWarehouse(b,warehouseId))}</option>)}</select></label>;
  const open=(id:string)=>openDoc?.(id);
  return <section className="perfume-divisions-page perfume-management-page">
    <fieldset className="erp-fieldset pm-navigation"><legend>{tr("pm.title")}</legend><div className="pm-navigation-row">
      <nav className="invoice-toolbar-modes pm-tabs" aria-label={tr("pm.title")}>{(["convert","stock","bottles","history"] as const).map(t=><button key={t} type="button" aria-pressed={tab===t} className="selection-option" disabled={busy} onClick={()=>void switchTab(t)}>{tr(`pm.tab.${t}`)}</button>)}</nav>
      <div className="pm-overview"><span>{tr("pm.batches")}: <b>{quantity(batches.filter(b=>lotRemainingTotal(b.lot)>0).length)}</b></span><span>{tr("زجاج التقسيمات")}: <b>{quantity(activeBottles.length)}</b></span><span>{tr("pm.operations")}: <b>{quantity(operations.length)}</b></span></div>
    </div></fieldset>
    {!canManage&&<p className="pm-hint">{tr("pm.readOnly")}</p>}
    {error&&<div className="error perfume-local-error" role="alert">{error}</div>}
    {tab!=="history"&&<div className="pm-workspace">
      <fieldset className="erp-fieldset popover-host pm-editor"><legend>{editing||bottleEdit?`${tr("تعديل")} · ${formTitle}`:formTitle}</legend>
      <form className="bank-operation-form pm-editor-form" onSubmit={event=>{event.preventDefault();void save()}}>
        {!editing&&!bottleEdit&&<div className="invoice-toolbar-modes pm-kind-tabs" role="group" aria-label={tr("العملية")}>{(tab==="convert"?["split","recombine"]:tab==="bottles"?["bottle","bottle-stock"]:["opening","consumption","yield-correction"]).map(k=><button type="button" className="selection-option" aria-pressed={kind===k} aria-label={tr(managementLabel[k as ManagementKind])} title={tr(managementLabel[k as ManagementKind])} disabled={busy} key={k} onClick={()=>void choose(k as ManagementKind)}>{tr(shortKindLabel[k as ManagementKind])}</button>)}</div>}
        <fieldset disabled={busy||!canManage} className="pm-fields">
          {kind!=="bottle"&&selectWarehouse}
          {(kind==="split"||kind==="opening")&&selectSource}
          {kind==="split"&&field(legacyEdit?"divisionsCount":"volumeMl",tr(legacyEdit?"عدد التقسيمات":"كمية العطر المبدئية بالمل"),{integer:legacyEdit})}
          {["split","opening","recombine"].includes(kind)&&!(kind==="recombine"&&ml&&text("actualQuantity")==="0")&&field("salePrice",tr(kind==="recombine"?"سعر بيع العطر الناقص":"سعر البيع للتقسيمة"))}
          {["recombine","consumption","yield-correction"].includes(kind)&&selectBatch}
          {kind==="bottle"&&<>{field("name",tr("اسم الزجاجة"),{type:"text"})}{field("sizeMl",tr("الحجم (ml)"))}{field("cost",tr("التكلفة المرجعية"))}<p className="pm-hint">{tr("pm.bottleHelp")}</p></>}
          {kind==="bottle-stock"&&<>{selectBottle}{field("actualQuantity",tr("pm.actual"),{integer:true,zero:true})}<label className="pm-wide">{tr("pm.bottleReason")}<select value={text("bottleStockReason")} onChange={e=>set("bottleStockReason",e.target.value)}><option value="">{tr("pm.chooseBottleReason")}</option>{Object.entries(bottleStockReasonLabels).map(([value,label])=><option key={value} value={value}>{tr(label)}</option>)}</select></label><p className="pm-hint">{tr("pm.stockHelp")}</p>{isBottleStockReason(text("bottleStockReason"))&&<p className="pm-hint">{tr(physicalBottleLoss?"pm.bottleLossHelp":"pm.bottleCorrectionHelp")}</p>}</>}
          {kind==="opening"&&<>{field(legacyEdit?"quantity":"volumeMl",tr(legacyEdit?"pm.actual":"المتبقي الفعلي بالمل"),{integer:legacyEdit})}{field("remainingValue",tr("pm.remainingValue"))}<p className="pm-hint">{tr("pm.openingHelp")}</p></>}
          {kind==="consumption"&&<>{field("quantity",tr(ml?"الكمية الخارجة بالمل":"pm.quantityOut"),{integer:!ml})}<label>{tr("pm.reasonCode")}<select value={text("reasonCode")} onChange={e=>set("reasonCode",e.target.value)}>{["samples","waste","leak","internal","stock-difference","other"].map(r=><option value={r} key={r}>{tr(`pm.reason.${r}`)}</option>)}</select></label><label className="pm-check"><input type="checkbox" checked={values.consumeBottle===true} onChange={e=>set("consumeBottle",e.target.checked)}/>{tr("خرجت عبوات مع السائل")}</label>{values.consumeBottle&&<>{selectBottle}{ml&&field("bottleQuantity",tr("عدد العبوات"),{integer:true})}</>}</>}
          {kind==="yield-correction"&&!ml&&field("legacyPortionMl",tr("حجم التقسيمة القديمة بالمل"))}
          {ml&&["yield-correction","recombine"].includes(kind)&&<>{field("actualQuantity",tr("المتبقي الفعلي بالمل"),{zero:true})}<p className="pm-hint">{tr("أدخل صفرًا إذا انتهى العطر فعليًا؛ يُحسب النقص أو الزيادة من رصيد البرنامج")}</p></>}
          {(["consumption","yield-correction","bottle-stock"].includes(kind)||kind==="recombine"&&ml)&&field("reason",tr(kind==="bottle-stock"?"البيان":"سبب التصحيح"),{type:"text"})}
          <label className="pm-wide">{tr("ملاحظة")}<textarea rows={1} maxLength={1000} value={text("note")} onChange={e=>set("note",e.target.value)}/></label>
        </fieldset>
        {kind==="split"&&<div className="pm-summary"><span>{tr("pm.sourceValue")}: <b>{money(sourceCost)}</b></span><span>{tr(legacyEdit?"تكلفة السائل للتقسيمة":"تكلفة المل")}: <b>{money(liquidCost)}</b></span><small>{tr("لا تشمل الزجاجة")} · {tr("سعر البيع للتقسيمة")} {defaults.fillMl} {tr("مل")}</small></div>}
        {selectedBatch&&<div className="pm-summary"><span>{tr("رصيد البرنامج")}: <b>{quantity(lotStock)} {ml?tr("مل"):tr("تقسيمة")}</b></span><span>{tr("pm.remainingValue")}: <b>{money(bookValue)}</b></span>{ml&&["yield-correction","recombine"].includes(kind)&&text("actualQuantity")!==""&&<span>{tr("فرق الجرد")}: <b>{roundMl(n("actualQuantity")-lotStock)>0?"+":""}{quantity(roundMl(n("actualQuantity")-lotStock))} {tr("مل")}</b></span>}{kind==="recombine"&&<small>{tr("pm.recombineHelp")}</small>}</div>}
        {kind==="bottle-stock"&&selectedBottle&&<div className="pm-summary"><span>{tr("رصيد البرنامج")}: <b>{quantity(bottleBefore)}</b></span><span>{tr("pm.addedCost")}: <b>{bottleCost>0?money(bottleCost):"—"}</b></span>{isBottleStockReason(text("bottleStockReason"))&&<span>{tr("pm.bottleRecognizedLoss")}: <b>{money(bottleLoss)}</b></span>}</div>}
        <footer className="pm-form-actions"><button type="submit" className="primary" disabled={busy||!canManage}>{busy?tr("جاري الحفظ…"):editing||bottleEdit?tr("pm.saveEdit"):tr("pm.post")}</button>{(editing||bottleEdit)&&<button type="button" className="soft" disabled={busy} onClick={()=>void choose(kind)}>{tr("إلغاء")}</button>}{editing&&<button type="button" className="soft" onClick={()=>open(editing.id)}>{tr("pm.view")}</button>}</footer>
      </form></fieldset>
      <fieldset className="erp-fieldset pm-register"><legend>{tr(tab==="bottles"?"زجاج التقسيمات":"pm.batches")}</legend>
        {tab==="bottles"&&<PerfumeDefaultsEditor key={`${defaults.fillMl}:${defaults.bottleProductId}`} defaults={defaults} bottles={activeBottles} run={run} disabled={busy||!canManage}/>}
        <div className="pm-section-head"><label className="search compact-search"><Search aria-hidden="true"/><input aria-label={tr("بحث")} placeholder={tr("بحث")} value={search} onChange={e=>setSearch(e.target.value)} /></label>{tab==="bottles"&&<label className="pm-check"><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>{tr("pm.showArchived")}</label>}</div>
        <div className="erp-table-wrap pm-table-scroll"><table className="erp-table"><thead>{tab==="bottles"?<tr><th>{tr("الزجاجة")}</th><th>{tr("الحجم")}</th><th>{tr("المخزون")}</th><th>{tr("إجراء")}</th></tr>:<tr><th>{tr("pm.batch")}</th><th>{tr("pm.remaining")}</th><th>{tr("تكلفة السائل")}</th><th>{tr("إجراء")}</th></tr>}</thead>
          <tbody>{tab==="bottles"?bottles.filter(b=>(archived||!b.isArchived)&&b.name.toLocaleLowerCase().includes(needle)).map(b=><tr key={b.id}>
            <td title={b.name}><span className="pm-cell-text">{b.name}</span>{b.isArchived&&<small>{tr("pm.archived")}</small>}</td>
            <td className="num-cell">{quantity(Number(b.decantSizeMl??0))} ml</td><td className="num-cell">{quantity(stockInWarehouse(b,warehouseId))}</td>
            <td><div className="pm-row-actions">{b.isArchived
              ?<RowAction label={tr("pm.restore")} icon={ArchiveRestore} disabled={busy||!canManage} onClick={()=>void process({type:"perfume-bottle.restore",id:b.id})}/>
              :<><RowAction label={tr("تعديل")} icon={PencilLine} disabled={busy||!canManage} onClick={()=>void choose("bottle",{name:b.name,sizeMl:b.decantSizeMl,cost:b.pieceCost},undefined,b.id)}/>
                <RowAction label={tr("تصحيح الكمية")} icon={SlidersHorizontal} disabled={busy||!canManage} onClick={()=>void choose("bottle-stock",{bottleProductId:b.id,warehouseId,actualQuantity:stockInWarehouse(b,warehouseId),cost:b.lastPurchaseCost??b.pieceCost})}/>
                <RowAction label={tr("pm.archive")} icon={Archive} danger disabled={busy||!canManage} onClick={()=>void (async()=>{if(await confirm({message:tr("pm.archiveConfirm"),tone:"danger"}))await process({type:"perfume-bottle.archive",id:b.id,expectedProduct:bottleSnapshot(b)})})()}/></>}
            </div></td></tr>)
            :batches.filter(b=>[b.lot.sourceProductName,b.lot.id].join(" ").toLocaleLowerCase().includes(needle)).map(b=>{
              const conversion=operationsById.get(b.lot.conversionDocumentId);
              const blocked=Boolean(b.lot.recombinedAt||b.lot.settledAt)||data.documents.some(document=>document.id!==conversion?.id&&document.status!=="voided"&&documentUsesPerfumeLot(document,b.product.id,b.lot.id));
              return <tr key={b.lot.id}>
              <td title={`${b.lot.sourceProductName} · ${formatDateTime(b.lot.createdAt)} · ${b.lot.id}`}><span className="pm-cell-text">{b.lot.sourceProductName}</span><small>{formatDateTime(b.lot.createdAt)} · {b.lot.id.slice(-6)}</small></td>
              <td className="num-cell">{quantity(lotRemainingTotal(b.lot))} {b.lot.quantityUnit==="ml"?tr("مل"):tr("تقسيمة")}</td><td className="num-cell">{money(b.lot.liquidUnitCost)} / {tr(b.lot.quantityUnit==="ml"?"مل":"تقسيمة")}</td>
              <td><div className="pm-row-actions pm-batch-actions"><RowAction label={tr("pm.source")} icon={FileText} onClick={()=>open(b.lot.conversionDocumentId)}/>
                {conversion?.status==="posted"&&managementKind(conversion)==="split"&&<RowAction label={tr(blocked?"pm.cancelSplitBlocked":"pm.cancelSplit")} text={tr("pm.short.cancelSplit")} icon={X} danger disabled={busy||!canManage||blocked} onClick={()=>void voidDocument(conversion)}/>}
                {tab!=="stock"&&<RowAction label={tr("pm.correction")} text={tr("pm.short.correction")} icon={SlidersHorizontal} disabled={busy||!canManage||Boolean(b.lot.recombinedAt)} onClick={()=>void choose("yield-correction",{decantProductId:b.product.id,lotId:b.lot.id,warehouseId})}/>}<RowAction label={tr(tab==="stock"?"pm.correction":"pm.recombine")} icon={tab==="stock"?SlidersHorizontal:RotateCcw} text={tr(tab==="stock"?"pm.short.correction":"pm.short.recombine")} disabled={busy||!canManage||(b.lot.quantityUnit!=="ml"&&lotRemainingTotal(b.lot)<=0)||Boolean(b.lot.recombinedAt)} onClick={()=>void choose(tab==="stock"?"yield-correction":"recombine",{decantProductId:b.product.id,lotId:b.lot.id,warehouseId:Object.entries(b.lot.stocks).find(([,q])=>q>0)?.[0]??defaultWarehouse})}/>
              </div></td></tr>})}</tbody></table></div>
        <p className="pm-hint">{tr(tab==="bottles"?"pm.bottleRegisterHelp":"pm.batchRegisterHelp")}</p>
      </fieldset>
    </div>}
    {tab==="history"&&<fieldset className="erp-fieldset pm-history"><legend>{tr("pm.history")}</legend><div className="pm-section-head"><label className="search compact-search"><Search aria-hidden="true"/><input aria-label={tr("بحث")} placeholder={tr("بحث")} value={search} onChange={e=>setSearch(e.target.value)}/></label><label>{tr("النوع")}<select value={historyType} onChange={e=>setHistoryType(e.target.value)}><option value="all">{tr("pm.all")}</option>{Object.keys(managementLabel).map(k=><option value={k} key={k}>{tr(managementLabel[k as ManagementKind])}</option>)}</select></label><label>{tr("الحالة")}<select value={historyStatus} onChange={e=>setHistoryStatus(e.target.value)}><option value="all">{tr("pm.all")}</option><option value="posted">{tr("pm.posted")}</option><option value="voided">{tr("pm.voided")}</option></select></label></div>
      <p className="pm-hint">{tr("pm.historyHelp")}</p><div className="erp-table-wrap pm-table-scroll"><table className="erp-table"><thead><tr><th>{tr("المستند")}</th><th>{tr("النوع")}</th><th>{tr("المخزن")}</th><th>{tr("ملاحظة")}</th><th>{tr("الحالة")}</th><th>{tr("إجراء")}</th></tr></thead><tbody>{operations.filter(d=>(historyType==="all"||managementKind(d)===historyType)&&(historyStatus==="all"||d.status===historyStatus)&&[d.number,d.title,d.note,...d.lines.map(l=>l.description)].join(" ").toLocaleLowerCase().includes(needle)).map(d=><tr key={d.id}>
        <td title={displayDocumentNumber(d)}><span className="pm-cell-text" dir="ltr">{displayDocumentNumber(d)}</span><small>{formatDateTime(d.occurredAt)}</small></td>
        <td title={`${tr(managementLabel[managementKind(d)!])} · ${d.lines[0]?.description??""}`}><span className="pm-cell-text">{tr(shortKindLabel[managementKind(d)!])}</span><small>{d.lines[0]?.description}</small></td>
        <td title={d.warehouseName??""}>{d.warehouseName??"—"}</td><td title={d.note||d.title||""}>{d.note||d.title||"—"}{managementKind(d)==="bottle-stock"&&<small>{tr(bottleStockReasonLabels[d.bottleStockReason??"correction"])}{Number(d.inventoryLoss)>0?` · ${money(d.inventoryLoss??0)}`:""}</small>}</td>
        <td title={tr(d.replacedByDocumentId?"pm.superseded":d.status==="posted"?"pm.posted":"pm.voided")}>{tr(d.replacedByDocumentId?"pm.short.superseded":d.status==="posted"?"pm.posted":"pm.voided")}</td>
        <td><div className="pm-row-actions"><RowAction label={tr("pm.view")} icon={FileText} onClick={()=>open(d.id)}/>
          {d.replacedByDocumentId&&<RowAction label={tr("pm.newRevision")} icon={ArrowUpRight} onClick={()=>open(d.replacedByDocumentId!)}/>}
          {d.status==="posted"&&<><RowAction label={tr("تعديل")} icon={PencilLine} disabled={busy||!canManage} onClick={()=>void edit(d)}/><RowAction label={tr("pm.void")} icon={X} danger disabled={busy||!canManage} onClick={()=>void voidDocument(d)}/></>}
        </div></td></tr>)}</tbody></table></div>{operations.length===0&&<p>{tr("pm.emptyHistory")}</p>}
    </fieldset>}
  </section>;
}
