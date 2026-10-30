"use client";

import { useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from "react";
import { Archive, ArchiveRestore, List, PencilLine, Search, SlidersHorizontal, X, type LucideIcon } from "lucide-react";
import { activePaymentAccounts, activeProducts, activeWarehouses, formatDateTime, inventoryUnitCost, money, quantity, stockInWarehouse, type BootstrapData, type DocumentRecord } from "./domain";
import { divisionLiquidCost, lotRemainingTotal } from "./perfume-logic";
import { bottleStockReasonLabels, documentUsesPerfumeLot, isBottleStockReason, managementInputFor, managementKind, managementLabel, managementPostType, managementPreviewLot, managementTabForKind, conversionSourceProducts, type PerfumeManagementTab, type ManagementKind } from "./perfume-management";
import { useAppConfirm } from "./app-confirm";
import { useI18n } from "./i18n/provider";
import { tr } from "./i18n/messages";
import { translateApiError } from "./i18n/api-errors";
import PerfumeProductPicker from "./perfume-product-picker";
import PerfumeDefaultsEditor from "./perfume-defaults-editor";
import {InvoicePartyPicker,PaymentModeButtons} from "./perfume-invoices";
import {isRemainderSale,remainderSaleInput,remainderSaleAvailable,remainderSaleBatches} from "./perfume-remainder-ui";
import PerfumeActivityPanel from "./perfume-activity-panel";
import PerfumeStockRegister from "./perfume-stock-register";
import {openSourceLots,type PerfumeDependency} from "./perfume-operation-guards";
import type { PerfumeContext } from "./perfume-activity";
import { DEFAULT_PERFUME_SETTINGS, roundMl } from "./perfume-volume";
import { defaultWarehouse as preferredWarehouse, warehouseSelectionId } from "./warehouse-selection";
import { DEFAULT_ORIGINAL_VOLUME_ML, openingLiquidValue } from "./perfume-opening-valuation";

type RunCommand = (body: Record<string, unknown>, message: string, afterSuccess?: () => void) => Promise<unknown>;
type Props = { data: BootstrapData; run: RunCommand; openDoc?: (id: string) => void; onSource?: (document:DocumentRecord) => void; editRequest?: string | null; clearEditRequest?: () => void; section?: Tab; onSectionChange?: (tab:Tab)=>void; navigationRef?:Ref<PerfumeManagementNavigation> };
type Tab = PerfumeManagementTab;
export type PerfumeManagementNavigation = {navigate:(next:Tab)=>Promise<boolean>;canLeave:()=>Promise<boolean>};
type Values = Record<string, string | boolean>;
const tabFor = managementTabForKind;

const blank = (warehouseId: string): Values => ({ sourceProductId:"",decantProductId:"",lotId:"",warehouseId,divisionsCount:"10",volumeMl:"",originalVolumeMl:String(DEFAULT_ORIGINAL_VOLUME_ML),legacyPortionMl:"10",salePrice:"",name:"",sizeMl:"10",cost:"",quantity:"",remainingValue:"",actualQuantity:"",reason:"",reasonCode:"samples",bottleStockReason:"",consumeBottle:false,bottleQuantity:"1",bottleProductId:"",paymentMethod:"",partyId:"",note:"" });
const normalize = (values: Record<string, unknown>): Values => Object.fromEntries(Object.entries(values).filter(([,v])=>v!==undefined&&v!==null).map(([k,v])=>[k,typeof v==="boolean"?v:String(v)]));
const bottleSnapshot = (p: BootstrapData["products"][number]) => ({name:p.name,sizeMl:p.decantSizeMl,cost:p.pieceCost,isArchived:p.isArchived===true});
const shortKindLabel: Record<ManagementKind, string> = {split:"pm.short.split",recombine:"pm.short.recombine",opening:"pm.short.opening",consumption:"pm.short.consumption","yield-correction":"pm.short.correction",bottle:"pm.short.bottle","bottle-stock":"pm.short.bottleStock"};

function RowAction({label, icon: Icon, text, disabled, danger, onClick}: {label: string; icon: LucideIcon; text?: string; disabled?: boolean; danger?: boolean; onClick: () => void}) {
  return <button type="button" className={`soft pm-row-action${danger?" danger":""}${text?"":" pm-icon-action"}`} title={label} aria-label={label} disabled={disabled} onClick={onClick}><Icon aria-hidden="true"/>{text&&<span>{text}</span>}</button>;
}

export default function PerfumeDivisions({ data, run, openDoc, onSource, editRequest, clearEditRequest, section="convert", onSectionChange, navigationRef }: Props) {
  const {locale}=useI18n(), confirm=useAppConfirm();
  const defaultWarehouse=preferredWarehouse(activeWarehouses(data.warehouses))?.id??"";
  const initialDocument=editRequest?data.documents.find(d=>d.id===editRequest&&(managementKind(d)||isRemainderSale(d))):undefined;
  const initialEditing=initialDocument?.status==="posted"?initialDocument:undefined;
  const initialKind=initialDocument?(isRemainderSale(initialDocument)?"recombine":managementKind(initialDocument)!):section==="stock"?"opening":section==="bottles"?"bottle":"split";
  const initialBottle=initialEditing&&initialKind==="bottle"?data.products.find(p=>p.id===initialEditing.managementProductId):undefined;
  const [tab,setTab]=useState<Tab>(tabFor(initialKind)),[kind,setKind]=useState<ManagementKind>(initialKind);
  const [editing,setEditing]=useState<DocumentRecord|undefined>(initialEditing),[bottleEdit,setBottleEdit]=useState(initialBottle?.id??"");
  const warehouses=data.warehouses.filter(warehouse=>!warehouse.isArchived||warehouse.id===editing?.warehouseId);
  const [bottleExpected,setBottleExpected]=useState<ReturnType<typeof bottleSnapshot>|undefined>(()=>initialBottle?bottleSnapshot(initialBottle):undefined);
  const [values,setValues]=useState<Values>(()=>({...blank(defaultWarehouse),...(initialEditing?normalize(inputFor(initialEditing)): {})}));
  function inputFor(document:DocumentRecord){
    const input=isRemainderSale(document)?remainderSaleInput(document):managementInputFor(document,data.products);
    if(isRemainderSale(document))input.paymentMethod=data.paymentAccounts.find(account=>account.id===document.paymentMethod||account.code===document.paymentMethod)?.id??document.paymentMethod??"";
    return input;
  }
  const [dirty,setDirty]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const [dependencies,setDependencies]=useState<PerfumeDependency[]>([]);
  const locked=useRef(false);
  const [search,setSearch]=useState(""),[archived,setArchived]=useState(false),[showClosed,setShowClosed]=useState(false);
  const [context,setContext]=useState<PerfumeContext|null>(null),[lastSaved,setLastSaved]=useState("");
  const editorRef=useRef<HTMLFieldSetElement>(null),contextRef=useRef<HTMLDivElement>(null),consumedRequest=useRef<string|null>(null),followedSaved=useRef("");
  const showContext=(next:PerfumeContext)=>{setContext(next);window.requestAnimationFrame(()=>contextRef.current?.scrollIntoView({block:"nearest",behavior:"smooth"}))};
  useEffect(()=>{
    if(!lastSaved||followedSaved.current===lastSaved)return;
    const saved=data.documents.find(d=>d.id===lastSaved||d.partialProductId===lastSaved&&d.status==="posted");if(!saved)return;
    if(!context||!saved.decantProductId||!saved.perfumeLotId){followedSaved.current=lastSaved;return}
    const timer=window.setTimeout(()=>{followedSaved.current=lastSaved;setContext({productId:saved.decantProductId!,lotId:saved.perfumeLotId!,conversionId:saved.perfumeLotAfter?.conversionDocumentId,name:context.name})},0);
    return()=>window.clearTimeout(timer);
    // Follow a replacement once, without changing the user's later context selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[lastSaved,data.documents]);
  const canManage=data.principal.principalType==="owner"||data.principal.permissions.includes("perfume.divisions.manage");
  const sources=activeProducts(data.products).filter(p=>!["decant","partial","bottle"].includes(p.perfumeForm??""));
  const bottles=data.products.filter(p=>p.perfumeForm==="bottle");
  const activeBottles=bottles.filter(p=>!p.isArchived);
  const batches=useMemo(()=>data.products.filter(p=>p.perfumeForm==="decant"&&(!p.isArchived||editing?.decantProductId===p.id)).flatMap(product=>(product.perfumeLots??[]).map(lot=>({product,lot}))),[data.products,editing?.decantProductId]);
  const operations=useMemo(()=>data.documents.filter(d=>managementKind(d)).sort((a,b)=>String(b.occurredAt).localeCompare(String(a.occurredAt))||b.id.localeCompare(a.id)),[data.documents]);
  const operationsById=useMemo(()=>new Map(operations.map(document=>[document.id,document])),[operations]);
  const needle=search.trim().toLocaleLowerCase(),text=(field:string)=>String(values[field]??""),n=(field:string)=>Number(text(field));
  const set=(field:string,value:string|boolean)=>{setValues(v=>({...v,[field]:value}));setDirty(true);setError("");setDependencies([])};
  const source=sources.find(p=>p.id===text("sourceProductId"));
  const selectedBatch=batches.find(b=>b.product.id===text("decantProductId")&&b.lot.id===text("lotId"));
  const lot=selectedBatch?.lot,warehouseId=warehouseSelectionId(warehouses,text("warehouseId"),Boolean(editing));
  const ml=lot?.quantityUnit==="ml",legacyEdit=Boolean(editing&&editing.quantityUnit!=="ml"),defaults=data.perfumeDefaults??DEFAULT_PERFUME_SETTINGS;
  const sourceCost=source?inventoryUnitCost(source):0;
  const automaticOpening=kind==="opening"&&!legacyEdit&&(!editing||editing.openingBottleCost!==undefined);
  const openingCost=editing?.sourceProductId===source?.id&&editing?.openingBottleCost!==undefined?editing.openingBottleCost:sourceCost;
  let openingValue:ReturnType<typeof openingLiquidValue>|null=null;
  if(automaticOpening&&source){try{openingValue=openingLiquidValue(openingCost,text("volumeMl"),text("originalVolumeMl"))}catch{ /* Incomplete fields remain unsaved. */ }}
  const sourceChoices=kind==="split"?conversionSourceProducts(sources,warehouseId,editing?.sourceProductId):sources;
  const pendingSourceLots=source&&kind==="split"?openSourceLots(data.products,source.id,editing?.perfumeLotId??undefined):[];
  const splitQuantity=legacyEdit?n("divisionsCount"):n("volumeMl");
  const liquidCost=sourceCost>0&&splitQuantity>0?(legacyEdit?divisionLiquidCost(sourceCost,splitQuantity):sourceCost/splitQuantity):0;
  const restoredRemainder=lot&&isRemainderSale(editing)?remainderSaleAvailable(text("decantProductId"),lot,warehouseId,editing):null;
  const previewLot=lot&&restoredRemainder!==null?{...lot,stocks:{...lot.stocks,[warehouseId]:restoredRemainder},remainingQuantity:roundMl(lot.remainingQuantity+restoredRemainder-Number(lot.stocks[warehouseId]??0))}:managementPreviewLot(editing,text("decantProductId"),text("lotId"),warehouseId,lot);
  const lotStock=Number(previewLot?.stocks?.[warehouseId]??0),bookValue=Number(previewLot?.remainingQuantity??0)*Number(previewLot?.liquidUnitCost??0);
  const selectedBottle=bottles.find(p=>p.id===text("bottleProductId"));
  const editingSameBottle=editing&&managementKind(editing)==="bottle-stock"&&editing.managementProductId===selectedBottle?.id&&editing.warehouseId===warehouseId;
  const priorBottleLine=editingSameBottle?editing.lines.find(line=>line.productId===selectedBottle?.id):undefined;
  const bottleBefore=Number(priorBottleLine?.balanceBefore??(selectedBottle?stockInWarehouse(selectedBottle,warehouseId):0));
  const bottleCost=Number(priorBottleLine?.unitPrice??(selectedBottle?inventoryUnitCost(selectedBottle):0));
  const physicalBottleLoss=["breakage","damage"].includes(text("bottleStockReason"));
  const bottleLoss=physicalBottleLoss&&text("actualQuantity").trim()!==""?Math.max(0,bottleBefore-n("actualQuantity"))*bottleCost:0;
  const remainderMode=kind==="recombine"&&(!editing||isRemainderSale(editing));
  const accounts=data.paymentAccounts.filter(account=>activePaymentAccounts([account]).length>0||isRemainderSale(editing)&&(account.id===editing?.paymentMethod||account.code===editing?.paymentMethod)),customers=data.parties.filter(p=>p.partyType==="customer"&&(!p.isArchived||p.id===text("partyId")));
  const formTitle=remainderMode?tr("بيع المتبقي"):tr(managementLabel[kind]);
  const selectableBatches=remainderMode?remainderSaleBatches(batches,warehouseId,editing):batches;
  const batchItems=selectableBatches.map(b=>({id:`${b.product.id}::${b.lot.id}`,name:b.lot.sourceProductName,meta:`${formatDateTime(b.lot.createdAt)} · ${tr("pm.remaining")}: ${quantity(remainderMode?remainderSaleAvailable(b.product.id,b.lot,warehouseId,editing):lotRemainingTotal(b.lot))} ${b.lot.quantityUnit==="ml"?tr("مل"):tr("تقسيمة")} · ${b.lot.id.slice(-6)}`}));

  async function mayDiscard(){return !dirty||await confirm({message:tr("pm.discard"),tone:"warning"})}
  function reset(){setDependencies([]);setEditing(undefined);setBottleEdit("");setBottleExpected(undefined);setValues(blank(defaultWarehouse));setDirty(false);setError("");clearEditRequest?.()}
  async function choose(next:ManagementKind,seed:Record<string,unknown>={},document?:DocumentRecord,productId=""){
    if(busy||!await mayDiscard())return;
    setDependencies([]);
    const selected=batches.find(batch=>batch.product.id===seed.decantProductId&&batch.lot.id===seed.lotId);
    const wh=String(seed.warehouseId??defaultWarehouse);
    setKind(next);setTab(tabFor(next));onSectionChange?.(tabFor(next));setValues({...blank(defaultWarehouse),...(selected?{actualQuantity:String(next==="recombine"?remainderSaleAvailable(selected.product.id,selected.lot,wh,document):selected.lot.stocks[wh]??0)}:{}),...normalize(seed)});setEditing(document);setBottleEdit(productId);setDirty(false);setError("");setSearch("");
    const selectedBottle=bottles.find(p=>p.id===productId);setBottleExpected(selectedBottle?bottleSnapshot(selectedBottle):undefined);
    editorRef.current?.scrollIntoView({block:"start",behavior:"smooth"});
  }
  async function switchTab(next:Tab){if(busy||!await mayDiscard())return false;reset();setContext(null);setLastSaved("");setTab(next);setKind(next==="bottles"?"bottle":next==="stock"?"opening":"split");setSearch("");return true}
  useImperativeHandle(navigationRef,()=>({navigate:switchTab,canLeave:async()=>!busy&&await mayDiscard()}));
  const process=async(body:Record<string,unknown>,after?:(result:unknown)=>void)=>{
    if(locked.current||!canManage)return;locked.current=true;setBusy(true);setError("");setDependencies([]);
    try{const result=await run(body,tr("pm.saved"));setDirty(false);after?.(result)}catch(e){const payload=(e as {payload?:{dependencies?:PerfumeDependency[]}}).payload;setDependencies(payload?.dependencies??[]);setError(translateApiError(locale,e instanceof Error?e.message:tr("pm.failed")))}finally{locked.current=false;setBusy(false)}
  };
  function validate():boolean{
    const good=(key:string,integer=false,zero=false)=>text(key).trim()!==""&&Number.isFinite(n(key))&&(integer?Number.isSafeInteger(n(key)):true)&&(zero?n(key)>=0:n(key)>0);
    let valid=kind==="bottle"?!!text("name").trim()&&good("sizeMl")&&good("cost"):!!warehouseId;
    if(kind==="split")valid=valid&&!!source&&good(legacyEdit?"divisionsCount":"volumeMl",legacyEdit)&&good("salePrice")&&liquidCost>0;
    if(kind==="opening")valid=valid&&!!source&&good(legacyEdit?"quantity":"volumeMl",legacyEdit)&&(automaticOpening?!!openingValue:good("remainingValue"))&&good("salePrice");
    if(kind==="recombine"&&!remainderMode)valid=valid&&!!selectedBatch&&(ml?good("actualQuantity",false,true)&&(n("actualQuantity")===0||good("salePrice"))&&(n("actualQuantity")===lotStock||!!text("reason").trim()):good("salePrice"));
    if(remainderMode)valid=valid&&!!selectedBatch&&ml&&good("actualQuantity")&&n("actualQuantity")<=lotStock&&good("salePrice")&&(text("paymentMethod")==="note"?!!text("partyId"):accounts.some(account=>account.id===text("paymentMethod")));
    if(kind==="consumption")valid=valid&&!!selectedBatch&&!!text("reason").trim()&&good("quantity",!ml)&&(!values.consumeBottle||!!text("bottleProductId")&&good("bottleQuantity",true));
    if(kind==="yield-correction")valid=valid&&!!selectedBatch&&(ml?good("actualQuantity",false,true)&&(n("actualQuantity")===lotStock||!!text("reason").trim()):good("legacyPortionMl"));
    if(kind==="bottle-stock")valid=valid&&!!selectedBottle&&good("actualQuantity",true,true)&&!!text("reason").trim()&&isBottleStockReason(text("bottleStockReason"))&&(!physicalBottleLoss||n("actualQuantity")<bottleBefore&&bottleCost>0);
    if(!valid)setError(tr("pm.invalid"));return valid;
  }
  async function save(){
    if(kind==="split"&&pendingSourceLots.length){setError(tr("pm.pendingDecantNotice"));return;}
    if(!validate())return;
    if(remainderMode){
      if(editing&&!await confirm({message:tr("pm.editConfirm"),tone:"warning"}))return;
      const currentWarehouse=warehouseId;
      await process({type:editing?"perfume-remainder-sale.update":"perfume-remainder-sale.post",documentId:editing?.id,expectedRevision:editing?.revision??0,productId:text("decantProductId"),lotId:text("lotId"),warehouseId,quantityMl:n("actualQuantity"),totalPrice:n("salePrice"),paymentMethod:text("paymentMethod"),partyId:text("partyId")||null,cashAmount:text("paymentMethod")==="note"?0:n("salePrice"),note:text("note")},result=>{reset();setValues(blank(currentWarehouse));setKind("recombine");setLastSaved(String(result??""))});return;
    }
    const payload:Record<string,unknown>={...values,warehouseId,type:editing?"perfume-management.update":managementPostType[kind],...(editing?{documentId:editing.id,expectedRevision:editing.revision??0}:{})};
    if(!["split","opening"].includes(kind)||legacyEdit)delete payload.volumeMl;
    if(automaticOpening)payload.remainingValue=openingValue!.remainingValue;else delete payload.originalVolumeMl;
    if(!legacyEdit&&["split","opening"].includes(kind))payload.priceBasisMl=defaults.fillMl;
    if(kind==="yield-correction"&&!ml&&!editing){
      if(!await confirm({message:tr("سيتم تحويل وحدة الرصيد إلى المل مع حفظ قيمته وسجله")+` (${quantity(lotStock)} × ${text("legacyPortionMl")} ${tr("مل")})`}))return;
      payload.type="perfume-volume.migrate";
    }
    const bottle=bottles.find(p=>p.id===bottleEdit);
    if(bottle){payload.type="perfume-bottle.update";payload.id=bottle.id;payload.expectedProduct=bottleExpected}
    if(editing&&!await confirm({message:tr("pm.editConfirm"),tone:"warning"}))return;
    const currentTab=tab,currentWarehouse=warehouseId;
    await process(payload,result=>{reset();setValues(blank(currentWarehouse));setTab(currentTab);setLastSaved(kind==="bottle"?"":String(result??""))});
  }
  async function edit(document:DocumentRecord){
    const k=isRemainderSale(document)?"recombine":managementKind(document)!;const p=k==="bottle"?bottles.find(b=>b.id===document.managementProductId):undefined;
    await choose(k,inputFor(document),document,p?.id??"");
    const productId=document.decantProductId??document.managementProductId;
    if(productId&&tabFor(k)!=="stock")setContext({productId,lotId:document.perfumeLotId??undefined,conversionId:document.perfumeLotId?undefined:document.id,name:data.products.find(p=>p.id===productId)?.name});
    editorRef.current?.scrollIntoView({block:"start",behavior:"smooth"});
  }
  async function voidDocument(document:DocumentRecord){
    if(busy||!await mayDiscard())return;
    const split=managementKind(document)==="split";
    if(!await confirm({message:tr(split?"pm.cancelSplitConfirm":"pm.voidConfirm"),confirmLabel:tr(split?"pm.cancelSplit":"pm.void"),tone:"danger"}))return;
    const command=managementKind(document)?"perfume-management.void":`${document.kind}.void`;
    await process({type:command,documentId:document.id,expectedRevision:document.revision??0},()=>reset());
  }
  useEffect(()=>{
    if(!editRequest||consumedRequest.current===editRequest)return;
    const requested=data.documents.find(d=>d.id===editRequest&&(managementKind(d)||isRemainderSale(d)));if(!requested)return;
    consumedRequest.current=editRequest;
    const timer=window.setTimeout(()=>{void(async()=>{if(requested.status==="posted")await edit(requested);clearEditRequest?.()})()},0);
    return()=>{window.clearTimeout(timer);consumedRequest.current=null};
    // A source request is consumed once; later data refreshes must not overwrite unsaved input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[editRequest]);
  const field=(key:string,label:string,options:{integer?:boolean;zero?:boolean;type?:string}={})=><label>{label}<input value={text(key)} onChange={e=>set(key,e.target.value)} type={options.type??"number"} min={options.type?undefined:options.zero?"0":options.integer?"1":"0.000001"} step={options.integer?"1":"any"} inputMode={options.type?undefined:options.integer?"numeric":"decimal"}/></label>;
  const selectWarehouse=<label className="pm-wide">{tr("المخزن")}<select value={warehouseId} onChange={e=>{setValues(v=>({...v,warehouseId:e.target.value,...(lot?{actualQuantity:String(remainderMode?remainderSaleAvailable(text("decantProductId"),lot,e.target.value,editing):lot.stocks[e.target.value]??0)}:{})}));setDirty(true)}}><option value="">{tr("اختر المخزن")}</option>{warehouses.map(w=><option key={w.id} value={w.id}>{w.name}</option>)}</select></label>;
  const selectSource=<label className="pm-wide">{tr("العطر")}<PerfumeProductPicker items={sourceChoices.map(p=>({id:p.id,name:p.name,meta:`${tr("المتوفر")}: ${quantity(stockInWarehouse(p,warehouseId))}`}))} value={text("sourceProductId")} onChange={value=>{const p=sources.find(p=>p.id===value);setValues(v=>({...v,sourceProductId:value,...(kind==="split"?{volumeMl:String(p?.perfumeBottleVolumeMl??DEFAULT_ORIGINAL_VOLUME_ML)}:{}),originalVolumeMl:String(p?.perfumeBottleVolumeMl??DEFAULT_ORIGINAL_VOLUME_ML)}));setDirty(true)}} placeholder={tr("اختر العطر")} ariaLabel={tr("العطر")}/></label>;
  const selectBatch=<label className="pm-wide">{tr("pm.batch")}<PerfumeProductPicker items={batchItems} value={text("decantProductId")?`${text("decantProductId")}::${text("lotId")}`:""} onChange={value=>{const [productId,lotId]=value.split("::"),batch=batches.find(b=>b.product.id===productId&&b.lot.id===lotId);setValues(v=>({...v,decantProductId:productId??"",lotId:lotId??"",actualQuantity:String(batch?(remainderMode?remainderSaleAvailable(batch.product.id,batch.lot,warehouseId,editing):batch.lot.stocks[warehouseId]??0):0)}));setDirty(true)}} placeholder={tr("pm.chooseBatch")} ariaLabel={tr("pm.batch")}/></label>;
  const selectBottle=<label>{tr("الزجاجة")}<select value={text("bottleProductId")} onChange={e=>{set("bottleProductId",e.target.value);const p=bottles.find(b=>b.id===e.target.value);if(p)set("cost",String(p.lastPurchaseCost??p.pieceCost??""))}}><option value="">{tr("pm.chooseBottle")}</option>{activeBottles.map(b=><option key={b.id} value={b.id}>{b.name} · {quantity(stockInWarehouse(b,warehouseId))}</option>)}</select></label>;
  const open=(id:string)=>openDoc?.(id);
  return <section className="perfume-divisions-page perfume-management-page">
    <div className="pm-overview pm-overview-row"><span>{tr("pm.batches")}: <b>{quantity(batches.filter(b=>lotRemainingTotal(b.lot)>0).length)}</b></span><span>{tr("زجاج التقسيمات")}: <b>{quantity(activeBottles.length)}</b></span>{lastSaved&&<button type="button" className="soft" onClick={()=>open(lastSaved)}>{tr("آخر مستند")}</button>}</div>
    {!canManage&&<p className="pm-hint">{tr("pm.readOnly")}</p>}
    {error&&<div className="error perfume-local-error" role="alert">{error}</div>}
    {dependencies.length>0&&<div className="pm-blocking-documents">{dependencies.map(d=><button type="button" className="soft" key={d.documentId} onClick={()=>open(d.documentId)}>{tr("عرض الحركة المرتبطة")} · {d.number}</button>)}</div>}
    {tab==="stock"&&<p className="pm-hint pm-stock-explanation">{tr(kind==="consumption"?"pm.consumptionHelp":kind==="yield-correction"?"pm.reconciliationHelp":"pm.stockModesHelp")}</p>}
    <div className="pm-workspace">
      <fieldset ref={editorRef} className="erp-fieldset popover-host pm-editor"><legend>{editing||bottleEdit?`${tr("تعديل")} · ${formTitle}`:formTitle}</legend>
      <form className="bank-operation-form pm-editor-form" onSubmit={event=>{event.preventDefault();void save()}}>
        {!editing&&!bottleEdit&&<div className="invoice-toolbar-modes pm-kind-tabs" role="group" aria-label={tr("العملية")}>{(tab==="convert"?["split","recombine"]:tab==="bottles"?["bottle","bottle-stock"]:["opening","consumption","yield-correction"]).map(k=><button type="button" className="selection-option" aria-pressed={kind===k} aria-label={tr(k==="recombine"?"بيع المتبقي":managementLabel[k as ManagementKind])} title={tr(k==="recombine"?"بيع المتبقي":managementLabel[k as ManagementKind])} disabled={busy} key={k} onClick={()=>void choose(k as ManagementKind)}>{tr(k==="recombine"?"بيع المتبقي":shortKindLabel[k as ManagementKind])}</button>)}</div>}
        <fieldset disabled={busy||!canManage} className="pm-fields">
          {kind!=="bottle"&&selectWarehouse}
          {(kind==="split"||kind==="opening")&&selectSource}
          {kind==="split"&&pendingSourceLots.length>0&&<div role="status" className="pm-hint pm-source-blocked pm-wide"><strong>{tr("pm.pendingDecantNotice")}</strong>{pendingSourceLots.map(l=>{const batch=batches.find(b=>b.product.id===l.productId&&b.lot.id===l.lotId),pendingWarehouse=batch?Object.entries(batch.lot.stocks).find(([,q])=>Number(q)>0)?.[0]??warehouseId:warehouseId;return <div key={l.lotId||l.productId} className="pm-source-actions"><span>{l.name} · {quantity(l.quantity)} {tr("مل")}</span><button type="button" className="soft" onClick={()=>showContext({productId:l.productId,lotId:l.lotId,conversionId:l.documentId,name:l.name})}>{tr("تفاصيل الدفعة")}</button>{batch&&<><button type="button" className="soft" onClick={()=>void choose("consumption",{decantProductId:l.productId,lotId:l.lotId,warehouseId:pendingWarehouse})}>{tr("تسجيل استهلاك")}</button><button type="button" className="soft" onClick={()=>void choose("yield-correction",{decantProductId:l.productId,lotId:l.lotId,warehouseId:pendingWarehouse})}>{tr("تسوية المتبقي")}</button></>}</div>})}</div>}
          {kind==="split"&&field(legacyEdit?"divisionsCount":"volumeMl",tr(legacyEdit?"عدد التقسيمات":"كمية العطر المبدئية بالمل"),{integer:legacyEdit})}
          {!remainderMode&&["split","opening","recombine"].includes(kind)&&!(kind==="recombine"&&ml&&text("actualQuantity")==="0")&&field("salePrice",tr(remainderMode?"إجمالي سعر بيع المتبقي":kind==="recombine"?"سعر بيع العطر الناقص":"سعر البيع للتقسيمة"))}
          {["recombine","consumption","yield-correction"].includes(kind)&&selectBatch}
          {remainderMode&&<>{field("actualQuantity",tr("كمية بيع المتبقي بالمل"))}{field("salePrice",tr("إجمالي سعر بيع المتبقي"))}<p className="pm-hint pm-wide">{tr("بيع مباشر من الدفعة دون زجاجة تقسيمات. سجل أي فرق فعلي من التسوية أولًا.")}</p><div className="pm-wide pm-remainder-payment"><PaymentModeButtons note={text("paymentMethod")==="note"} onDirect={()=>set("paymentMethod","")} onNote={()=>set("paymentMethod","note")}/><div className={text("paymentMethod")==="note"?"pos-payment-row note":"pos-payment-row"}>{text("paymentMethod")!=="note"&&<label>{tr("وسيلة الدفع")}<select aria-label={tr("وسيلة الدفع")} value={text("paymentMethod")} onChange={e=>set("paymentMethod",e.target.value)}><option value="">{tr("اختر وسيلة الدفع")}</option>{accounts.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select></label>}<InvoicePartyPicker partyId={text("partyId")} onChange={id=>set("partyId",id)} parties={customers} isCustomer note={text("paymentMethod")==="note"} run={run} canCreate={data.principal.principalType==="owner"||data.principal.permissions.includes("customers.create")}/></div></div></>}
          {kind==="bottle"&&<>{field("name",tr("اسم الزجاجة"),{type:"text"})}{field("sizeMl",tr("الحجم (ml)"))}{field("cost",tr("التكلفة المرجعية"))}<p className="pm-hint">{tr("pm.bottleHelp")}</p></>}
          {kind==="bottle-stock"&&<>{selectBottle}{field("actualQuantity",tr("pm.actual"),{integer:true,zero:true})}<label className="pm-wide">{tr("pm.bottleReason")}<select value={text("bottleStockReason")} onChange={e=>set("bottleStockReason",e.target.value)}><option value="">{tr("pm.chooseBottleReason")}</option>{Object.entries(bottleStockReasonLabels).map(([value,label])=><option key={value} value={value}>{tr(label)}</option>)}</select></label><p className="pm-hint">{tr("pm.stockHelp")}</p>{isBottleStockReason(text("bottleStockReason"))&&<p className="pm-hint">{tr(physicalBottleLoss?"pm.bottleLossHelp":"pm.bottleCorrectionHelp")}</p>}</>}
          {kind==="opening"&&<>{automaticOpening&&field("originalVolumeMl",tr("pm.originalVolume"))}{field(legacyEdit?"quantity":"volumeMl",tr(legacyEdit?"pm.actual":"المتبقي الفعلي بالمل"),{integer:legacyEdit})}{automaticOpening?<><label>{tr("pm.remainingValue")}<input readOnly value={openingValue?money(openingValue.remainingValue):"—"}/></label><p className="pm-hint">{tr("pm.openingValuationHelp")} {source&&<b>{tr("pm.originalBottleCost")}: {money(openingCost)}</b>}</p></>:field("remainingValue",tr("pm.remainingValue"))}<p className="pm-hint">{tr("pm.openingHelp")}</p></>}
          {kind==="consumption"&&<>{field("quantity",tr(ml?"الكمية الخارجة بالمل":"pm.quantityOut"),{integer:!ml})}<label>{tr("pm.reasonCode")}<select value={text("reasonCode")} onChange={e=>set("reasonCode",e.target.value)}>{["samples","waste","leak","internal","stock-difference","other"].map(r=><option value={r} key={r}>{tr(`pm.reason.${r}`)}</option>)}</select></label><label className="pm-check"><input type="checkbox" checked={values.consumeBottle===true} onChange={e=>set("consumeBottle",e.target.checked)}/>{tr("خرجت عبوات مع السائل")}</label>{values.consumeBottle&&<>{selectBottle}{ml&&field("bottleQuantity",tr("عدد العبوات"),{integer:true})}</>}</>}
          {kind==="yield-correction"&&lot&&!ml&&field("legacyPortionMl",tr("حجم التقسيمة القديمة بالمل"))}
          {!remainderMode&&ml&&["yield-correction","recombine"].includes(kind)&&<>{field("actualQuantity",tr("المتبقي الفعلي بالمل"),{zero:true})}<p className="pm-hint">{tr("أدخل صفرًا إذا انتهى العطر فعليًا؛ يُحسب النقص أو الزيادة من رصيد البرنامج")}</p></>}
          {(["consumption","yield-correction","bottle-stock"].includes(kind)||kind==="recombine"&&ml&&!remainderMode)&&field("reason",tr(kind==="bottle-stock"?"البيان":kind==="consumption"?"سبب الاستهلاك":"سبب التصحيح"),{type:"text"})}
          <label className="pm-wide">{tr("ملاحظة")}<textarea rows={1} maxLength={1000} value={text("note")} onChange={e=>set("note",e.target.value)}/></label>
        </fieldset>

        {kind==="split"&&<div className="pm-summary"><span>{tr("pm.sourceValue")}: <b>{money(sourceCost)}</b></span><span>{tr(legacyEdit?"تكلفة السائل للتقسيمة":"تكلفة المل")}: <b>{money(liquidCost)}</b></span><small>{tr("لا تشمل الزجاجة")} · {tr("سعر البيع للتقسيمة")} {defaults.fillMl} {tr("مل")}</small></div>}
        {selectedBatch&&<div className="pm-summary"><span>{tr("رصيد البرنامج")}: <b>{quantity(lotStock)} {ml?tr("مل"):tr("تقسيمة")}</b></span><span>{tr("pm.remainingValue")}: <b>{money(bookValue)}</b></span>{!remainderMode&&ml&&["yield-correction","recombine"].includes(kind)&&text("actualQuantity")!==""&&<span>{tr("فرق الجرد")}: <b>{roundMl(n("actualQuantity")-lotStock)>0?"+":""}{quantity(roundMl(n("actualQuantity")-lotStock))} {tr("مل")}</b></span>}{remainderMode?<small>{tr("بدون زجاجة تقسيمات")}</small>:kind==="recombine"&&<small>{tr("pm.recombineHelp")}</small>}</div>}
        {kind==="bottle-stock"&&selectedBottle&&<div className="pm-summary"><span>{tr("رصيد البرنامج")}: <b>{quantity(bottleBefore)}</b></span><span>{tr("pm.addedCost")}: <b>{bottleCost>0?money(bottleCost):"—"}</b></span>{isBottleStockReason(text("bottleStockReason"))&&<span>{tr("pm.bottleRecognizedLoss")}: <b>{money(bottleLoss)}</b></span>}</div>}
        <footer className="pm-form-actions"><button type="submit" className="primary" disabled={busy||!canManage}>{busy?tr("جاري الحفظ…"):editing||bottleEdit?tr("pm.saveEdit"):remainderMode?tr("إتمام البيع"):tr("pm.post")}</button>{(editing||bottleEdit)&&<button type="button" className="soft" disabled={busy} onClick={()=>void choose(kind)}>{tr("إلغاء")}</button>}{editing&&<><button type="button" className="soft danger" disabled={busy} onClick={()=>void voidDocument(editing)}>{tr("إلغاء العملية")}</button><button type="button" className="soft" onClick={()=>open(editing.id)}>{tr("pm.view")}</button></>}</footer>
      </form></fieldset>
      {tab==="stock"?<PerfumeStockRegister key={kind} kind={kind as "opening"|"consumption"|"yield-correction"} data={data} busy={busy} onEdit={d=>void edit(d)} onVoid={d=>void voidDocument(d)} openDoc={open}/>:<fieldset className="erp-fieldset pm-register"><legend>{tr(tab==="bottles"?"زجاج التقسيمات":"pm.batches")}</legend>
        {tab==="bottles"&&<PerfumeDefaultsEditor key={`${defaults.fillMl}:${defaults.bottleProductId}`} defaults={defaults} bottles={activeBottles} run={run} disabled={busy||!canManage}/>}
        <div className="pm-section-head"><label className="search compact-search"><Search aria-hidden="true"/><input aria-label={tr("بحث")} placeholder={tr("بحث")} value={search} onChange={e=>setSearch(e.target.value)} /></label>{tab!=="bottles"&&!remainderMode&&<label className="pm-check"><input type="checkbox" checked={showClosed} onChange={e=>setShowClosed(e.target.checked)}/>{tr("إظهار الدفعات المغلقة")}</label>}{tab==="bottles"&&<label className="pm-check"><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>{tr("pm.showArchived")}</label>}</div>
        <div className="erp-table-wrap pm-table-scroll"><table className="erp-table"><thead>{tab==="bottles"?<tr><th>{tr("الزجاجة")}</th><th>{tr("الحجم")}</th><th>{tr("المخزون")}</th><th>{tr("إجراء")}</th></tr>:<tr><th>{tr("pm.batch")}</th><th>{tr("pm.remaining")}</th><th>{tr("تكلفة السائل")}</th><th>{tr("الحالة")}</th><th>{tr("إجراء")}</th></tr>}</thead>
          <tbody>{tab==="bottles"?bottles.filter(b=>(archived||!b.isArchived)&&b.name.toLocaleLowerCase().includes(needle)).map(b=><tr key={b.id}>
            <td title={b.name}><span className="pm-cell-text">{b.name}</span>{b.isArchived&&<small>{tr("pm.archived")}</small>}</td>
            <td className="num-cell">{quantity(Number(b.decantSizeMl??0))} ml</td><td className="num-cell">{quantity(stockInWarehouse(b,warehouseId))}</td>
            <td><div className="pm-row-actions"><RowAction label={tr("حركات الزجاجة")} icon={List} onClick={()=>showContext({productId:b.id,name:b.name})}/>{b.isArchived
              ?<RowAction label={tr("pm.restore")} icon={ArchiveRestore} disabled={busy||!canManage} onClick={()=>void process({type:"perfume-bottle.restore",id:b.id})}/>
              :<><RowAction label={tr("تعديل")} icon={PencilLine} disabled={busy||!canManage} onClick={()=>void choose("bottle",{name:b.name,sizeMl:b.decantSizeMl,cost:b.pieceCost},undefined,b.id)}/>
                <RowAction label={tr("تصحيح الكمية")} icon={SlidersHorizontal} disabled={busy||!canManage} onClick={()=>void choose("bottle-stock",{bottleProductId:b.id,warehouseId,actualQuantity:stockInWarehouse(b,warehouseId),cost:b.lastPurchaseCost??b.pieceCost})}/>
                <RowAction label={tr("pm.archive")} icon={Archive} danger disabled={busy||!canManage} onClick={()=>void (async()=>{if(await confirm({message:tr("pm.archiveConfirm"),tone:"danger"}))await process({type:"perfume-bottle.archive",id:b.id,expectedProduct:bottleSnapshot(b)})})()}/></>}
            </div></td></tr>)
            :(remainderMode?selectableBatches:batches).filter(b=>(showClosed||!b.lot.settledAt&&!b.lot.recombinedAt)&&[b.lot.sourceProductName,b.lot.id].join(" ").toLocaleLowerCase().includes(needle)).map(b=>{
              const conversion=operationsById.get(b.lot.conversionDocumentId);
              const blocked=Boolean(b.lot.recombinedAt||b.lot.settledAt)||data.documents.some(document=>document.id!==conversion?.id&&document.status!=="voided"&&documentUsesPerfumeLot(document,b.product.id,b.lot.id));
              return <tr key={b.lot.id}>
              <td title={`${b.lot.sourceProductName} · ${formatDateTime(b.lot.createdAt)} · ${b.lot.id}`}><span className="pm-cell-text">{b.lot.sourceProductName}</span><small>{formatDateTime(b.lot.createdAt)} · {b.lot.id.slice(-6)}</small></td>
              <td className="num-cell">{quantity(lotRemainingTotal(b.lot))} {b.lot.quantityUnit==="ml"?tr("مل"):tr("تقسيمة")}</td><td className="num-cell">{money(b.lot.liquidUnitCost)} / {tr(b.lot.quantityUnit==="ml"?"مل":"تقسيمة")}</td>
              <td>{tr(b.lot.recombinedAt?"أُرجع الباقي":b.lot.settledAt?"مغلقة":lotRemainingTotal(b.lot)===0?"بانتظار الجرد":"نشطة")}</td>
              <td><div className="pm-row-actions pm-batch-actions"><RowAction label={tr("تفاصيل الدفعة")} icon={List} onClick={()=>showContext({productId:b.product.id,lotId:b.lot.id,conversionId:b.lot.conversionDocumentId,name:b.lot.sourceProductName})}/>{conversion?.status==="posted"&&<RowAction label={tr("تعديل العملية")} icon={PencilLine} disabled={busy||!canManage||blocked} onClick={()=>void edit(conversion)}/>}
                {conversion?.status==="posted"&&["split","opening"].includes(managementKind(conversion)??"")&&<RowAction label={tr(blocked?"pm.cancelSplitBlocked":"pm.cancelSplit")} text={tr("pm.short.cancelSplit")} icon={X} danger disabled={busy||!canManage||blocked} onClick={()=>void voidDocument(conversion)}/>}
              </div></td></tr>})}{remainderMode&&selectableBatches.length===0&&<tr><td colSpan={5}>{tr("لا توجد دفعات بمتبقي قابل للبيع")}</td></tr>}</tbody></table></div>
        <p className="pm-hint">{tr(tab==="bottles"?"pm.bottleRegisterHelp":"pm.batchRegisterHelp")}</p>
      </fieldset>}
    </div>
    {context&&<div ref={contextRef}><PerfumeActivityPanel key={context.productId+":"+(context.lotId??"")} context={context} data={data} busy={busy} onEdit={d=>void edit(d)} onVoid={d=>void voidDocument(d)} openDoc={open} onSource={onSource?d=>{void(async()=>{if(await mayDiscard()){reset();onSource(d)}})()}:undefined} close={()=>setContext(null)}/></div>}
  </section>;
}
