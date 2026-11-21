"use client";
import {useEffect,useId,useState} from "react";
import {statementNote} from "../lib/movement-statement";
import {Plus,PencilLine,X} from "lucide-react";
import {activePaymentAccounts,displayDocumentNumber,formatDate,money,type BootstrapData,type DocumentRecord,type Employee} from "./domain";
import {localBusinessDay} from "./history-filters";
import {canUseCapability} from "./transaction-ui";
import {useAppConfirm} from "./app-confirm";
import {tr} from "./i18n/messages";
import {useI18n} from "./i18n/provider";
import {translateApiError} from "./i18n/api-errors";

type Guard={isEditing:()=>boolean;isDirty:()=>boolean;discard:()=>void};
type Run=(body:Record<string,unknown>,message:string,after?:()=>void)=>Promise<unknown>;
type PaymentDirection = "withdraw" | "deposit";
type OpeningDirection = "payable" | "receivable";
type OpeningDraft = {direction:OpeningDirection;amount:string;occurredAt:string;note:string};
const earliestDay=(...values:(string|null|undefined)[])=>values.filter((value):value is string=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)).sort()[0]??localBusinessDay();
const initialOpening=(occurredAt=localBusinessDay()):OpeningDraft=>({direction:"payable",amount:"",occurredAt,note:""});
const openingDraft=(document:DocumentRecord):OpeningDraft=>({direction:document.employeeOpeningDirection==="receivable"?"receivable":"payable",amount:String(document.total),occurredAt:document.occurredAt.slice(0,10),note:document.note??""});
function EmployeeOpeningFields({value,onChange,maxDate,disabled}:{value:OpeningDraft;onChange:(value:OpeningDraft)=>void;maxDate:string;disabled:boolean}){
  const [noteOpen,setNoteOpen]=useState(Boolean(value.note)),noteId=useId();
  return <div className="employee-opening-fields-wrap"><div className="employee-opening-fields">
    <label>{tr("workerOpening.direction")}<select value={value.direction} disabled={disabled} onChange={e=>onChange({...value,direction:e.target.value as OpeningDirection})}><option value="payable">{tr("workerOpening.payable")}</option><option value="receivable">{tr("workerOpening.receivable")}</option></select></label>
    <label>{tr("المبلغ")}<input type="number" inputMode="decimal" min="0.01" step="0.01" required disabled={disabled} value={value.amount} onChange={e=>onChange({...value,amount:e.target.value})}/></label>
    <label>{tr("التاريخ")}<input type="date" required max={maxDate} disabled={disabled} value={value.occurredAt} onChange={e=>onChange({...value,occurredAt:e.target.value})}/></label>
  </div><button type="button" className="soft employee-opening-note-toggle" aria-expanded={noteOpen} aria-controls={noteId} disabled={disabled} onClick={()=>setNoteOpen(current=>!current)}>{tr(noteOpen?"workerOpening.hideNote":"workerOpening.addNote")}</button>
    {noteOpen&&<label className="employee-opening-note" id={noteId}>{tr("ملاحظة")}<input maxLength={1000} value={value.note} disabled={disabled} onChange={e=>onChange({...value,note:e.target.value})}/></label>}
  </div>;
}
const initial=()=>({name:"",phone:"",amount:"",startDate:localBusinessDay(),intervalMonths:"1",entitlement:"end"});
const initialPayment = () => ({amount:"",paymentMethod:"",occurredAt:localBusinessDay(),note:"",direction:"withdraw" as PaymentDirection});
const paymentDirection = (document:DocumentRecord):PaymentDirection => document.employeePaymentDirection==="deposit"?"deposit":"withdraw";
const balanceTone = (balance:number) => balance>0?"positive":balance<0?"negative":"neutral";
const balanceLabel = (balance:number) => tr(balance>0?"مستحق للعامل":balance<0?"مستحق على العامل":"الحساب متوازن");
export default function EmployeesPage({data,run,openDoc,sourceId,clearSource,registerEditorGuard}:{data:BootstrapData;run:Run;openDoc:(id:string)=>void;sourceId?:string|null;clearSource:()=>void;registerEditorGuard:(guard:Guard|null)=>void}){
  const {locale}=useI18n();
  const employees=(data.employees??[]).filter(row=>!row.isDeleted),canManage=canUseCapability(data.principal,"employees.manage"),canPay=canUseCapability(data.principal,"employees.pay"),confirm=useAppConfirm();
  const [openingEnabled,setOpeningEnabled]=useState(false),[openingOpen,setOpeningOpen]=useState(false),[opening,setOpening]=useState<OpeningDraft>(initialOpening),[openingEditing,setOpeningEditing]=useState<DocumentRecord|null>(null);
  const [resumeDate,setResumeDate]=useState(""),[selected,setSelected]=useState(""),[profile,setProfile]=useState(initial),[profileEdit,setProfileEdit]=useState(false),[payment,setPayment]=useState(initialPayment),[editing,setEditing]=useState<DocumentRecord|null>(null),[accrualEdit,setAccrualEdit]=useState<DocumentRecord|null>(null),[accrualAmount,setAccrualAmount]=useState(""),[accrualDate,setAccrualDate]=useState(""),[reason,setReason]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[search,setSearch]=useState("");
  const workerRecords=[...new Map([...(data.employeeOpeningHistory??[]),...data.documents].map(document=>[document.id,document])).values()];
  const employee=employees.find(e=>e.id===selected),documents=workerRecords.filter(d=>d.employeeId===selected&&["employee-accrual","employee-payment","employee-opening"].includes(d.kind)).sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)),accounts=activePaymentAccounts(data.paymentAccounts);
  const activeOpening=documents.find(document=>document.kind==="employee-opening"&&document.status==="posted");
  const openingMaxDate=earliestDay(localBusinessDay(),...documents.filter(document=>document.kind!=="employee-opening").map(document=>document.businessDate??document.occurredAt.slice(0,10)));
  const openingDefaultDate=earliestDay(openingMaxDate,employee?.startDate,employee?.accountStartDate);
  const openingCurrent=openingEditing?documents.find(document=>document.id===openingEditing.id):null;
  const openingStale=openingOpen&&(openingEditing?(!openingCurrent||openingCurrent.status!=="posted"||Number(openingCurrent.revision??0)!==Number(openingEditing.revision??0)):Boolean(activeOpening));
  const openingAmount=Number(opening.amount),openingValid=opening.amount.trim()!==""&&Number.isFinite(openingAmount)&&openingAmount>0&&Boolean(opening.occurredAt)&&opening.occurredAt<=openingMaxDate&&(!openingEditing||reason.trim()!=="");
  const openingSigned=opening.direction==="payable"?openingAmount:-openingAmount,openingPrevious=openingEditing?(openingEditing.employeeOpeningDirection==="receivable"?-openingEditing.total:openingEditing.total):0;
  const currentDay=localBusinessDay(), firstResumeDay=employee && employee.startDate>currentDay ? employee.startDate : currentDay;
  const chosenResumeDay=resumeDate||firstResumeDay;
  const originalAccount=editing && data.paymentAccounts.find(account=>account.id===editing.paymentMethod);
  const editAccounts=originalAccount && !accounts.some(account=>account.id===originalAccount.id) ? [...accounts,originalAccount] : accounts;
  const reset=()=>{setResumeDate("");setPayment(initialPayment());setEditing(null);setAccrualEdit(null);setReason("");setProfileEdit(false);setProfile(initial());setError("");setOpeningEnabled(false);setOpeningOpen(false);setOpeningEditing(null);setOpening(initialOpening())};
  const dirty=Boolean(profile.name||profile.amount||profile.phone||profile.startDate!==localBusinessDay()||profile.intervalMonths!=="1"||profile.entitlement!=="end"||payment.amount||payment.note||payment.paymentMethod||payment.occurredAt!==localBusinessDay()||payment.direction!=="withdraw"||editing||accrualEdit||openingEnabled||openingOpen);
  const normalizedSearch=search.trim().toLocaleLowerCase(),visibleEmployees=employees.filter(row=>`${row.name} ${row.phone}`.toLocaleLowerCase().includes(normalizedSearch));
  const paymentAmount=Number(payment.amount),validPayment=payment.amount.trim()!==""&&Number.isFinite(paymentAmount)&&paymentAmount>0&&Boolean(payment.paymentMethod)&&Boolean(payment.occurredAt);
  const previousPaymentFloor=employee&&(payment.direction==="deposit"&&employee.balance<0&&employee.accountStartDate&&employee.accountStartDate<employee.startDate?employee.accountStartDate:editing&&editing.occurredAt.slice(0,10)<employee.startDate?editing.occurredAt.slice(0,10):employee.startDate);
  const paymentDateFloor=employee?earliestDay(previousPaymentFloor,activeOpening?.occurredAt.slice(0,10)):undefined;
  useEffect(()=>{registerEditorGuard({isEditing:()=>dirty,isDirty:()=>dirty,discard:reset});return()=>registerEditorGuard(null)});
  // Consume an explicit navigation request once, preserving normal form state on data refresh.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(()=>{if(!sourceId)return;const source=workerRecords.find(d=>d.id===sourceId),employeeId=source?.employeeId??employees.find(row=>row.id===sourceId)?.id,target=employees.find(row=>row.id===employeeId);if(target){reset();setSelected(target.id);if(source?.kind==="employee-opening"){if(source.status==="posted"&&canManage){setOpeningOpen(true);setOpeningEditing(source);setOpening(openingDraft(source));window.requestAnimationFrame(()=>{const form=window.document.querySelector<HTMLFormElement>(".employee-opening-form");form?.scrollIntoView({block:"nearest"});form?.querySelector<HTMLInputElement>('input[type="number"]')?.focus({preventScroll:true})})}else openDoc(source.id)}}else if(source?.kind==="employee-opening")openDoc(source.id);clearSource()},[sourceId]);
  const mayReplace=async()=>!busy&&(!dirty||await confirm({message:tr("تجاهل التغييرات غير المحفوظة؟"),confirmLabel:tr("متابعة")}));
  const change=async(id:string)=>{if(!await mayReplace())return;reset();setSelected(id)};
  const act=async(body:Record<string,unknown>,done=reset)=>{if(busy)return;setBusy(true);setError("");try{await run(body,tr("تم حفظ العملية"));done()}catch(e){setError(translateApiError(locale,e instanceof Error?e.message:tr("تعذر تنفيذ العملية")))}finally{setBusy(false)}};
  const editProfile=async(e:Employee)=>{if(!await mayReplace())return;reset();const agreement=e.agreements.filter(row=>!row.canceledAt).at(-1)??e.agreements.at(-1);setProfileEdit(true);setProfile({name:e.name,phone:e.phone??"",amount:String(agreement?.amount??0),startDate:e.startDate,intervalMonths:String(agreement?.intervalMonths??1),entitlement:agreement?.entitlement??"end"})};
  const deleteEmployee=async(e:Employee)=>{
    if(!e.isArchived||!await mayReplace())return;
    if(e.balance<0){setError(tr("لا يمكن حذف العامل قبل تصفية المبلغ المستحق عليه للمحل."));return;}
    if(!await confirm({message:tr("سيُحذف العامل نهائيًا من القوائم ويُلغى المبلغ غير المسحوب المستحق له. ستبقى حركات السحب والإيداع السابقة محفوظة دون تغيير النقد. هل تريد المتابعة؟"),confirmLabel:tr("حذف نهائي"),tone:"danger"}))return;
    await act({type:"employee.delete",employeeId:e.id,expectedRevision:e.revision},()=>{reset();setSelected("")});
  };
  const remove=async(d:DocumentRecord)=>{if(d.status!=="posted"||!await mayReplace())return;if(!await confirm({message:tr(d.kind==="employee-opening"?"workerOpening.voidConfirm":"سيعكس الإلغاء أثر السند على رصيد العامل والصندوق حسب نوعه. هل تريد المتابعة؟"),confirmLabel:tr("إلغاء السند"),tone:"danger"}))return;await act({type:d.kind==="employee-opening"?"employee-opening.void":d.kind==="employee-payment"?"employee-payment.void":"employee-accrual.void",documentId:d.id,expectedRevision:d.revision??0,reason:tr("إلغاء من حساب العامل")})};
  const editDocument=async(d:DocumentRecord)=>{if(d.status!=="posted"||!await mayReplace())return;reset();if(d.kind==="employee-opening"){setOpeningOpen(true);setOpeningEditing(d);setOpening(openingDraft(d))}else if(d.kind==="employee-payment"){setEditing(d);setPayment({amount:String(d.total),paymentMethod:d.paymentMethod??"",occurredAt:d.occurredAt.slice(0,10),note:d.note??"",direction:paymentDirection(d)})}else{setAccrualEdit(d);setAccrualAmount(String(d.total));setAccrualDate(d.dueDate??d.occurredAt.slice(0,10))}};
  const addOpening=async()=>{if(!employee||!canManage||activeOpening||!await mayReplace())return;reset();setOpening(initialOpening(openingDefaultDate));setOpeningOpen(true)};
  return <section className="employees-workspace workspace-page">
    {error&&<div className="error employees-error" role="alert">{error}</div>}
    <fieldset className="erp-fieldset employees-list">
      <legend>{tr("العمال")}</legend>
      <div className="employees-toolbar"><input aria-label={tr("بحث بالاسم أو الهاتف")} placeholder={tr("بحث بالاسم أو الهاتف")} value={search} onChange={event=>setSearch(event.target.value)}/>{canManage&&<button type="button" className="soft" disabled={busy} onClick={()=>void change("")}><Plus/>{tr("عامل جديد")}</button>}</div>
      <div className="erp-table-wrap"><table className="erp-table employees-list-table" aria-label={tr("العمال")}><colgroup><col style={{width:"36%"}}/><col style={{width:"21%"}}/><col style={{width:"28%"}}/><col style={{width:"15%"}}/></colgroup>
        <thead><tr><th>{tr("الاسم")}</th><th>{tr("الهاتف")}</th><th>{tr("رصيد الحساب")}</th><th>{tr("الحالة")}</th></tr></thead>
        <tbody>{visibleEmployees.map(row=><tr key={row.id} className={selected===row.id?"selected":""} onClick={()=>void change(row.id)}>
          <td className="name-cell"><button type="button" className="source-link employee-source-link" title={row.name} disabled={busy} onClick={event=>{event.stopPropagation();void change(row.id)}}>{row.name}</button></td><td dir="ltr">{row.phone||"—"}</td>
          <td><strong className={balanceTone(row.balance)}>{money(Math.abs(row.balance))}</strong><small className="employee-balance-direction">{balanceLabel(row.balance)}</small></td>
          <td>{tr(row.isArchived?"مؤرشف":"نشط")}</td>
        </tr>)}{!visibleEmployees.length&&<tr><td colSpan={4}>{tr(employees.length?"لا توجد نتائج":"لا يوجد عمال")}</td></tr>}</tbody>
      </table></div>
    </fieldset>
    <div className="employees-account">
    {(!employee||profileEdit)&&canManage?<fieldset className="erp-fieldset employee-profile-panel"><legend>{tr(profileEdit?"تعديل العامل والاتفاق":"عامل جديد")}</legend><form className="employee-form employee-profile-form" onSubmit={e=>{e.preventDefault();if(!profileEdit&&openingEnabled&&!openingValid)return;void act({type:profileEdit?"employee.update":"employee.create",...(employee&&profileEdit?{employeeId:employee.id,expectedRevision:employee.revision}:{}),startDate:profile.startDate,name:profile.name,phone:profile.phone,amount:Number(profile.amount),intervalMonths:Number(profile.intervalMonths),entitlement:profile.entitlement,...(!profileEdit&&openingEnabled?{openingBalance:{...opening,amount:openingAmount}}:{})})}}>
      <label>{tr("الاسم")}<input required maxLength={120} value={profile.name} onChange={e=>setProfile({...profile,name:e.target.value})}/></label><label>{tr("الهاتف")}<input dir="ltr" value={profile.phone} onChange={e=>setProfile({...profile,phone:e.target.value})}/></label>
      <label>{tr("مبلغ الاستحقاق")}<input required type="number" min="0" step="0.01" value={profile.amount} onChange={e=>setProfile({...profile,amount:e.target.value})}/></label><label>{tr("تاريخ البداية")}<input required type="date" value={profile.startDate} onChange={e=>setProfile({...profile,startDate:e.target.value})}/></label>
      <label>{tr("المدة بالأشهر")}<input required type="number" min="1" max="12" value={profile.intervalMonths} onChange={e=>setProfile({...profile,intervalMonths:e.target.value})}/></label><label>{tr("موعد الاستحقاق")}<select value={profile.entitlement} onChange={e=>setProfile({...profile,entitlement:e.target.value})}><option value="beginning">{tr("بداية الفترة")}</option><option value="end">{tr("نهاية الفترة")}</option></select></label>
      {!profileEdit&&<div className="employee-opening-create"><button type="button" className="soft employee-opening-toggle" disabled={busy} aria-expanded={openingEnabled} onClick={()=>{if(!openingEnabled)setOpening(initialOpening(earliestDay(localBusinessDay(),profile.startDate)));setOpeningEnabled(current=>!current)}}>{tr(openingEnabled?"workerOpening.without":"workerOpening.add")}</button>{openingEnabled&&<div className="employee-opening-create-fields"><EmployeeOpeningFields key="create-opening" value={opening} onChange={setOpening} maxDate={localBusinessDay()} disabled={busy}/><p className="employee-hint">{tr("workerOpening.hint")}</p></div>}</div>}
      <p className="employee-hint">{tr(profileEdit?"تغيير تاريخ البداية أو الاتفاق يعيد حساب الاستحقاقات، مع الاحتفاظ بحركات السحب والإيداع دون تغيير النقد.":"الاستحقاق يضاف لحساب العامل عند موعده دون خصم نقد. حركة الحساب تسجل السحب أو الإيداع.")} {tr("يمكن أن يكون مبلغ الاستحقاق صفرًا للعامل الذي يستخدم الحساب للسحب والإيداع فقط.")}</p><div className="employee-actions"><button type="submit" className="primary" disabled={busy}>{tr("حفظ")}</button>{profileEdit&&<button type="button" className="soft" onClick={reset}>{tr("إلغاء التعديل")}</button>}</div></form></fieldset>:employee&&<>
      <fieldset className="erp-fieldset employee-card">
        <legend title={employee.name}>{employee.name}</legend>
        <div className="employee-balance"><span>{balanceLabel(employee.balance)}</span><strong className={balanceTone(employee.balance)}>{money(Math.abs(employee.balance))}</strong></div>
        <p className="employee-terms">{tr("مبلغ الاستحقاق")} {money(employee.agreements.at(-1)?.amount??0)} · {tr("المدة بالأشهر")} {employee.agreements.at(-1)?.intervalMonths??1}</p>
        {canManage&&employee.isArchived&&<label className="employee-resume-date">{tr("تاريخ الاستئناف")}<input type="date" min={firstResumeDay} value={chosenResumeDay} onChange={event=>setResumeDate(event.target.value)}/></label>}
        {canManage&&<div className="employee-actions">
          <button type="button" className="soft" disabled={busy||employee.isArchived} onClick={()=>void editProfile(employee)}><PencilLine/>{tr("تعديل العامل والاتفاق")}</button>
          <button type="button" className="soft" disabled={busy||(employee.isArchived&&chosenResumeDay<firstResumeDay)} onClick={async()=>{
            if(!await mayReplace())return;
            if(await confirm({message:tr(employee.isArchived?"استئناف العامل من التاريخ المحدد دون استحقاق فترة التوقف؟":"إيقاف الاستحقاقات القادمة مع الاحتفاظ بحساب العامل وسنده؟"),confirmLabel:tr("متابعة")}))
              void act({type:employee.isArchived?"employee.restore":"employee.archive",employeeId:employee.id,expectedRevision:employee.revision,resumeDate:chosenResumeDay});
          }}>{tr(employee.isArchived?"استعادة":"إيقاف العامل")}</button>
          {employee.isArchived&&<button type="button" className="soft danger employee-delete" disabled={busy} onClick={()=>void deleteEmployee(employee)}>{tr("حذف نهائي")}</button>}
        </div>}
        {activeOpening?<div className="employee-opening-summary"><span>{tr("workerOpening.title")} · {tr(activeOpening.employeeOpeningDirection==="receivable"?"workerOpening.receivable":"workerOpening.payable")} · <strong className="money-neutral">{money(activeOpening.total)}</strong></span>{canManage&&<button type="button" className="soft employee-opening-edit" disabled={busy} aria-label={tr("workerOpening.edit")} onClick={()=>void editDocument(activeOpening)}><PencilLine/>{tr("تعديل")}</button>}</div>:canManage&&!openingOpen&&<button type="button" className="soft employee-opening-add" disabled={busy} onClick={()=>void addOpening()}><Plus/>{tr("workerOpening.add")}</button>}
      </fieldset>
      {canManage&&openingOpen&&<fieldset className="erp-fieldset employee-opening-panel"><legend>{tr(openingEditing?"workerOpening.edit":"workerOpening.add")}</legend><form className="employee-opening-form" onSubmit={event=>{event.preventDefault();if(!employee||!openingValid||openingStale)return;void act({type:openingEditing?"employee-opening.update":"employee-opening.post",...(openingEditing?{documentId:openingEditing.id,expectedRevision:openingEditing.revision??0,reason}:{employeeId:employee.id}),...opening,amount:openingAmount})}}>
        <EmployeeOpeningFields key={openingEditing?.id??"new-opening"} value={opening} onChange={setOpening} maxDate={openingMaxDate} disabled={busy}/>
        {openingEditing&&<label className="employee-opening-reason">{tr("سبب التعديل")}<input required maxLength={1000} value={reason} disabled={busy} onChange={event=>setReason(event.target.value)}/></label>}
        <p className="employee-hint">{tr("workerOpening.hint")}</p>{Number.isFinite(openingAmount)&&openingAmount>0&&<p className="employee-opening-preview">{tr("workerOpening.after")}: <strong className="money-neutral">{money(Math.abs(employee.balance+openingSigned-openingPrevious))}</strong> · {balanceLabel(employee.balance+openingSigned-openingPrevious)}</p>}
        {openingStale&&<p className="error employee-opening-stale" role="alert">{tr("workerOpening.stale")}</p>}
        <div className="employee-actions"><button type="submit" className="primary" disabled={busy||!openingValid||openingStale}>{tr("workerOpening.save")}</button><button type="button" className="soft" disabled={busy} onClick={()=>void(async()=>{if(await mayReplace())reset()})()}>{tr("إلغاء")}</button></div>
      </form></fieldset>}
      {canPay&&!accrualEdit&&!openingOpen&&<fieldset className="erp-fieldset employee-payment-panel">
        <legend>{tr(editing?"تعديل حركة حساب العامل":"حركة حساب العامل")}</legend>
        <form className="employee-form employee-payment-form" onSubmit={event=>{
          event.preventDefault();if(!validPayment)return;
          void act({type:editing?"employee-payment.update":"employee-payment.post",...(editing?{documentId:editing.id,expectedRevision:editing.revision??0}:{employeeId:employee.id}),...payment,amount:paymentAmount,reason});
        }}>
          <label>{tr("نوع الحركة")}<select value={payment.direction} onChange={event=>setPayment({...payment,direction:event.target.value as PaymentDirection})}><option value="withdraw">{tr("سحب العامل")}</option><option value="deposit">{tr("إيداع العامل")}</option></select></label>
          <label>{tr("المبلغ")}<input type="number" step="0.01" min="0.01" required value={payment.amount} onChange={event=>setPayment({...payment,amount:event.target.value})}/></label>
          <label>{tr("وسيلة الدفع")}<select required value={payment.paymentMethod} onChange={event=>setPayment({...payment,paymentMethod:event.target.value})}><option value="">{tr("اختر وسيلة الدفع")}</option>{editAccounts.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <label>{tr("التاريخ")}<input type="date" required min={paymentDateFloor} max={localBusinessDay()} value={payment.occurredAt} onChange={event=>setPayment({...payment,occurredAt:event.target.value})}/></label>
          <label className="employee-wide">{tr("ملاحظة")}<input value={payment.note} onChange={event=>setPayment({...payment,note:event.target.value})}/></label>
          {editing&&<label className="employee-wide">{tr("سبب التعديل")}<input required value={reason} onChange={event=>setReason(event.target.value)}/></label>}
          <p className="employee-hint">{tr(payment.direction==="withdraw"?"سحب العامل ينقص رصيده، ويمكن تسجيل سلفة تتجاوز المستحق.":"إيداع العامل يزيد رصيده ويضيف المبلغ إلى وسيلة الدفع المختارة.")}</p>
          <div className="employee-actions"><button type="submit" className="primary" disabled={busy||!validPayment}>{tr("حفظ")}</button>{editing&&<button type="button" className="soft" onClick={reset}>{tr("إلغاء التعديل")}</button>}</div>
        </form>
      </fieldset>}
      {canManage&&accrualEdit&&<fieldset className="erp-fieldset employee-accrual-panel"><legend>{tr("تعديل الاستحقاق")}</legend><form className="employee-form employee-accrual-form" onSubmit={e=>{e.preventDefault();void act({type:"employee-accrual.update",documentId:accrualEdit.id,expectedRevision:accrualEdit.revision??0,amount:Number(accrualAmount),occurredAt:accrualDate,reason})}}><label>{tr("المبلغ")}<input required type="number" min="0.01" step="0.01" value={accrualAmount} onChange={e=>setAccrualAmount(e.target.value)}/></label><label>{tr("تاريخ الاستحقاق")}<input required type="date" max={localBusinessDay()} value={accrualDate} onChange={e=>setAccrualDate(e.target.value)}/></label><label>{tr("سبب التعديل")}<input required value={reason} onChange={e=>setReason(e.target.value)}/></label><div className="employee-actions"><button type="submit" className="primary" disabled={busy}>{tr("حفظ التعديل")}</button><button type="button" className="soft" onClick={reset}>{tr("إلغاء التعديل")}</button></div></form></fieldset>}
    </>}
    </div>
    {employee&&<fieldset className="erp-fieldset employees-history">
      <legend>{tr("سجل حساب العامل")}</legend>
      <div className="erp-table-wrap"><table className="erp-table employees-history-table" aria-label={tr("سجل حساب العامل")}><colgroup><col style={{width:"26%"}}/><col style={{width:"17%"}}/><col style={{width:"25%"}}/><col style={{width:"18%"}}/><col style={{width:"14%"}}/></colgroup>
        <thead><tr><th>{tr("المستند")}</th><th>{tr("التاريخ")}</th><th>{tr("النوع")}</th><th>{tr("المبلغ")}</th><th>{tr("إجراء")}</th></tr></thead>
        <tbody>{documents.map(document=>{
          const isOpening=document.kind==="employee-opening",isPayment=document.kind==="employee-payment",deposit=isPayment&&paymentDirection(document)==="deposit";
          const canChange=document.status==="posted"&&(isPayment?canPay:canManage);
          return <tr key={document.id} className={document.status==="voided"?"employee-history-voided":""}>
            <td><button type="button" className="source-link employee-source-link" dir="ltr" title={displayDocumentNumber(document)} onClick={()=>openDoc(document.id)}>{displayDocumentNumber(document)}</button></td>
            <td>{formatDate(document.occurredAt)}</td>
            <td className="employee-history-kind">{tr(isOpening?"workerOpening.title":isPayment?deposit?"إيداع العامل":"سحب العامل":"استحقاق عامل")}
              {statementNote(document)&&<small className="movement-statement-note" dir="auto">{statementNote(document)}</small>}
              {isOpening&&<small className="employee-period">{tr(document.employeeOpeningDirection==="receivable"?"workerOpening.receivable":"workerOpening.payable")} · {tr("workerOpening.nonCash")}</small>}
              {document.periodStart&&<small className="employee-period">{formatDate(document.periodStart)} — {formatDate(document.periodEnd??document.periodStart)}</small>}
              {document.status==="voided"&&<small className="employee-period">{tr("pm.voided")}</small>}
            </td>
            <td className={`num-cell ${isOpening?"money-neutral":isPayment&&!deposit?"negative":"positive"}`} title={money(document.total)}>{money(document.total)}</td>
            <td className="action-cell">{canChange&&<div className="employee-actions">
              <button type="button" className="soft" disabled={busy} aria-label={`${tr("تعديل")} ${displayDocumentNumber(document)}`} onClick={()=>void editDocument(document)}><PencilLine/></button>
              <button type="button" className="danger" disabled={busy} aria-label={`${tr("إلغاء السند")} ${displayDocumentNumber(document)}`} onClick={()=>void remove(document)}><X/></button>
            </div>}</td>
          </tr>;
        })}{!documents.length&&<tr><td colSpan={5}>{tr("لا توجد حركات")}</td></tr>}</tbody>
      </table></div>
    </fieldset>}
  </section>;
}
