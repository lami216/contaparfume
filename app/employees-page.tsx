"use client";
import {useEffect,useState} from "react";
import {Plus,PencilLine,X} from "lucide-react";
import {activePaymentAccounts,displayDocumentNumber,formatDate,money,type BootstrapData,type DocumentRecord,type Employee} from "./domain";
import {localBusinessDay} from "./history-filters";
import {canUseCapability} from "./transaction-ui";
import {useAppConfirm} from "./app-confirm";
import {tr} from "./i18n/messages";

type Guard={isEditing:()=>boolean;isDirty:()=>boolean;discard:()=>void};
type Run=(body:Record<string,unknown>,message:string,after?:()=>void)=>Promise<unknown>;
type PaymentDirection = "withdraw" | "deposit";
const initial=()=>({name:"",phone:"",amount:"",startDate:localBusinessDay(),intervalMonths:"1",entitlement:"end"});
const initialPayment = () => ({amount:"",paymentMethod:"",occurredAt:localBusinessDay(),note:"",direction:"withdraw" as PaymentDirection});
const paymentDirection = (document:DocumentRecord):PaymentDirection => document.employeePaymentDirection==="deposit"?"deposit":"withdraw";
const balanceTone = (balance:number) => balance>0?"positive":balance<0?"negative":"neutral";
const balanceLabel = (balance:number) => tr(balance>0?"مستحق للعامل":balance<0?"مستحق على العامل":"الحساب متوازن");
export default function EmployeesPage({data,run,openDoc,sourceId,clearSource,registerEditorGuard}:{data:BootstrapData;run:Run;openDoc:(id:string)=>void;sourceId?:string|null;clearSource:()=>void;registerEditorGuard:(guard:Guard|null)=>void}){
  const employees=data.employees??[],canManage=canUseCapability(data.principal,"employees.manage"),canPay=canUseCapability(data.principal,"employees.pay"),confirm=useAppConfirm();
  const [resumeDate,setResumeDate]=useState(""),[selected,setSelected]=useState(""),[profile,setProfile]=useState(initial),[profileEdit,setProfileEdit]=useState(false),[payment,setPayment]=useState(initialPayment),[editing,setEditing]=useState<DocumentRecord|null>(null),[accrualEdit,setAccrualEdit]=useState<DocumentRecord|null>(null),[accrualAmount,setAccrualAmount]=useState(""),[accrualDate,setAccrualDate]=useState(""),[reason,setReason]=useState(""),[error,setError]=useState(""),[busy,setBusy]=useState(false),[search,setSearch]=useState("");
  const employee=employees.find(e=>e.id===selected),documents=data.documents.filter(d=>d.employeeId===selected&&["employee-accrual","employee-payment"].includes(d.kind)).sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)),accounts=activePaymentAccounts(data.paymentAccounts);
  const currentDay=localBusinessDay(), firstResumeDay=employee && employee.startDate>currentDay ? employee.startDate : currentDay;
  const chosenResumeDay=resumeDate||firstResumeDay;
  const originalAccount=editing && data.paymentAccounts.find(account=>account.id===editing.paymentMethod);
  const editAccounts=originalAccount && !accounts.some(account=>account.id===originalAccount.id) ? [...accounts,originalAccount] : accounts;
  const reset=()=>{setResumeDate("");setPayment(initialPayment());setEditing(null);setAccrualEdit(null);setReason("");setProfileEdit(false);setProfile(initial());setError("")};
  const dirty=Boolean(profile.name||profile.amount||profile.phone||profile.startDate!==localBusinessDay()||profile.intervalMonths!=="1"||profile.entitlement!=="end"||payment.amount||payment.note||payment.paymentMethod||payment.occurredAt!==localBusinessDay()||payment.direction!=="withdraw"||editing||accrualEdit);
  const normalizedSearch=search.trim().toLocaleLowerCase(),visibleEmployees=employees.filter(row=>`${row.name} ${row.phone}`.toLocaleLowerCase().includes(normalizedSearch));
  const paymentAmount=Number(payment.amount),validPayment=payment.amount.trim()!==""&&Number.isFinite(paymentAmount)&&paymentAmount>0&&Boolean(payment.paymentMethod)&&Boolean(payment.occurredAt);
  useEffect(()=>{registerEditorGuard({isEditing:()=>dirty,isDirty:()=>dirty,discard:reset});return()=>registerEditorGuard(null)});
  // Consume an explicit navigation request once, preserving normal form state on data refresh.
  // eslint-disable-next-line react-hooks/set-state-in-effect, react-hooks/exhaustive-deps
  useEffect(()=>{if(!sourceId)return;const source=data.documents.find(d=>d.id===sourceId),employeeId=source?.employeeId??employees.find(row=>row.id===sourceId)?.id;if(employeeId){reset();setSelected(employeeId)}clearSource()},[sourceId]);
  const mayReplace=async()=>!busy&&(!dirty||await confirm({message:tr("تجاهل التغييرات غير المحفوظة؟"),confirmLabel:tr("متابعة")}));
  const change=async(id:string)=>{if(!await mayReplace())return;reset();setSelected(id)};
  const act=async(body:Record<string,unknown>,done=reset)=>{if(busy)return;setBusy(true);setError("");try{await run(body,tr("تم حفظ العملية"));done()}catch(e){setError(e instanceof Error?e.message:tr("تعذر تنفيذ العملية"))}finally{setBusy(false)}};
  const editProfile=async(e:Employee)=>{if(!await mayReplace())return;reset();const agreement=e.agreements.at(-1);setProfileEdit(true);setProfile({name:e.name,phone:e.phone??"",amount:String(agreement?.amount??""),startDate:"",intervalMonths:String(agreement?.intervalMonths??1),entitlement:agreement?.entitlement??"end"})};
  const remove=async(d:DocumentRecord)=>{if(d.status!=="posted"||!await mayReplace())return;if(!await confirm({message:tr("سيعكس الإلغاء أثر السند على رصيد العامل والصندوق حسب نوعه. هل تريد المتابعة؟"),confirmLabel:tr("إلغاء السند"),tone:"danger"}))return;await act({type:d.kind==="employee-payment"?"employee-payment.void":"employee-accrual.void",documentId:d.id,expectedRevision:d.revision??0,reason:tr("إلغاء من حساب العامل")})};
  const editDocument=async(d:DocumentRecord)=>{if(d.status!=="posted"||!await mayReplace())return;reset();if(d.kind==="employee-payment"){setEditing(d);setPayment({amount:String(d.total),paymentMethod:d.paymentMethod??"",occurredAt:d.occurredAt.slice(0,10),note:d.note??"",direction:paymentDirection(d)})}else{setAccrualEdit(d);setAccrualAmount(String(d.total));setAccrualDate(d.dueDate??d.occurredAt.slice(0,10))}};
  return <section className="employees-workspace workspace-page">
    {error&&<div className="error employees-error" role="alert">{error}</div>}
    <fieldset className="panel employees-list">
      <legend>{tr("العمال")}</legend>
      <div className="employees-toolbar"><input aria-label={tr("بحث بالاسم أو الهاتف")} placeholder={tr("بحث بالاسم أو الهاتف")} value={search} onChange={event=>setSearch(event.target.value)}/>{canManage&&<button className="soft" disabled={busy} onClick={()=>void change("")}><Plus/>{tr("عامل جديد")}</button>}</div>
      <div className="erp-table-wrap"><table className="erp-table">
        <thead><tr><th>{tr("الاسم")}</th><th>{tr("الهاتف")}</th><th>{tr("رصيد الحساب")}</th><th>{tr("الحالة")}</th></tr></thead>
        <tbody>{visibleEmployees.map(row=><tr key={row.id} className={selected===row.id?"selected":""} onClick={()=>void change(row.id)}>
          <td><button className="source-link" onClick={event=>{event.stopPropagation();void change(row.id)}}>{row.name}</button></td><td dir="ltr">{row.phone||"—"}</td>
          <td><strong className={balanceTone(row.balance)}>{money(Math.abs(row.balance))}</strong><small className="employee-balance-direction">{balanceLabel(row.balance)}</small></td>
          <td>{tr(row.isArchived?"مؤرشف":"نشط")}</td>
        </tr>)}{!visibleEmployees.length&&<tr><td colSpan={4}>{tr(employees.length?"لا توجد نتائج":"لا يوجد عمال")}</td></tr>}</tbody>
      </table></div>
    </fieldset>
    <div className="employees-account">
    {(!employee||profileEdit)&&canManage?<fieldset className="panel"><legend>{tr(profileEdit?"تعديل العامل والاتفاق":"عامل جديد")}</legend><form className="employee-form" onSubmit={e=>{e.preventDefault();void act({type:profileEdit?"employee.update":"employee.create",...(employee&&profileEdit?{employeeId:employee.id,expectedRevision:employee.revision,...(profile.startDate?{effectiveFrom:profile.startDate}:{})}:{startDate:profile.startDate}),name:profile.name,phone:profile.phone,amount:Number(profile.amount),intervalMonths:Number(profile.intervalMonths),entitlement:profile.entitlement})}}>
      <label>{tr("الاسم")}<input required maxLength={120} value={profile.name} onChange={e=>setProfile({...profile,name:e.target.value})}/></label><label>{tr("الهاتف")}<input dir="ltr" value={profile.phone} onChange={e=>setProfile({...profile,phone:e.target.value})}/></label>
      <label>{tr("مبلغ الاستحقاق")}<input required type="number" min="0.01" step="0.01" value={profile.amount} onChange={e=>setProfile({...profile,amount:e.target.value})}/></label><label>{tr(profileEdit?"بداية الاتفاق الجديد":"تاريخ البداية")}<input required={!profileEdit} type="date" value={profile.startDate} onChange={e=>setProfile({...profile,startDate:e.target.value})}/></label>
      <label>{tr("المدة بالأشهر")}<input required type="number" min="1" max="12" value={profile.intervalMonths} onChange={e=>setProfile({...profile,intervalMonths:e.target.value})}/></label><label>{tr("موعد الاستحقاق")}<select value={profile.entitlement} onChange={e=>setProfile({...profile,entitlement:e.target.value})}><option value="beginning">{tr("بداية الفترة")}</option><option value="end">{tr("نهاية الفترة")}</option></select></label>
      <p className="employee-hint">{tr(profileEdit?"الاتفاق الجديد يطبق على الفترات القادمة؛ الاستحقاقات السابقة تبقى كما هي.":"الاستحقاق يضاف لحساب العامل عند موعده دون خصم نقد. حركة الحساب تسجل السحب أو الإيداع.")}</p><div className="employee-actions"><button className="primary" disabled={busy}>{tr("حفظ")}</button>{profileEdit&&<button type="button" className="soft" onClick={reset}>{tr("إلغاء التعديل")}</button>}</div></form></fieldset>:employee&&<>
      <fieldset className="panel employee-card">
        <legend>{employee.name}</legend>
        <div className="employee-balance"><span>{balanceLabel(employee.balance)}</span><strong className={balanceTone(employee.balance)}>{money(Math.abs(employee.balance))}</strong></div>
        <p className="employee-terms">{tr("مبلغ الاستحقاق")} {money(employee.agreements.at(-1)?.amount??0)} · {tr("المدة بالأشهر")} {employee.agreements.at(-1)?.intervalMonths??1}</p>
        {canManage&&employee.isArchived&&<label className="employee-resume-date">{tr("تاريخ الاستئناف")}<input type="date" min={firstResumeDay} value={chosenResumeDay} onChange={event=>setResumeDate(event.target.value)}/></label>}
        {canManage&&<div className="employee-actions">
          <button className="soft" disabled={busy||employee.isArchived} onClick={()=>void editProfile(employee)}><PencilLine/>{tr("تعديل العامل والاتفاق")}</button>
          <button className="soft" disabled={busy||(employee.isArchived&&chosenResumeDay<firstResumeDay)} onClick={async()=>{
            if(!await mayReplace())return;
            if(await confirm({message:tr(employee.isArchived?"استئناف العامل من التاريخ المحدد دون استحقاق فترة التوقف؟":"إيقاف الاستحقاقات القادمة مع الاحتفاظ بحساب العامل وسنده؟"),confirmLabel:tr("متابعة")}))
              void act({type:employee.isArchived?"employee.restore":"employee.archive",employeeId:employee.id,expectedRevision:employee.revision,resumeDate:chosenResumeDay});
          }}>{tr(employee.isArchived?"استعادة":"إيقاف العامل")}</button>
        </div>}
      </fieldset>
      {canPay&&!accrualEdit&&<fieldset className="panel employee-payment-panel">
        <legend>{tr(editing?"تعديل حركة حساب العامل":"حركة حساب العامل")}</legend>
        <form className="employee-form" onSubmit={event=>{
          event.preventDefault();if(!validPayment)return;
          void act({type:editing?"employee-payment.update":"employee-payment.post",...(editing?{documentId:editing.id,expectedRevision:editing.revision??0}:{employeeId:employee.id}),...payment,amount:paymentAmount,reason});
        }}>
          <label>{tr("نوع الحركة")}<select value={payment.direction} onChange={event=>setPayment({...payment,direction:event.target.value as PaymentDirection})}><option value="withdraw">{tr("سحب العامل")}</option><option value="deposit">{tr("إيداع العامل")}</option></select></label>
          <label>{tr("المبلغ")}<input type="number" step="0.01" min="0.01" required value={payment.amount} onChange={event=>setPayment({...payment,amount:event.target.value})}/></label>
          <label>{tr("وسيلة الدفع")}<select required value={payment.paymentMethod} onChange={event=>setPayment({...payment,paymentMethod:event.target.value})}><option value="">{tr("اختر وسيلة الدفع")}</option>{editAccounts.map(account=><option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
          <label>{tr("التاريخ")}<input type="date" required min={employee.startDate} max={localBusinessDay()} value={payment.occurredAt} onChange={event=>setPayment({...payment,occurredAt:event.target.value})}/></label>
          <label className="employee-wide">{tr("ملاحظة")}<input value={payment.note} onChange={event=>setPayment({...payment,note:event.target.value})}/></label>
          {editing&&<label className="employee-wide">{tr("سبب التعديل")}<input required value={reason} onChange={event=>setReason(event.target.value)}/></label>}
          <p className="employee-hint">{tr(payment.direction==="withdraw"?"سحب العامل ينقص رصيده، ويمكن تسجيل سلفة تتجاوز المستحق.":"إيداع العامل يزيد رصيده ويضيف المبلغ إلى وسيلة الدفع المختارة.")}</p>
          <div className="employee-actions"><button className="primary" disabled={busy||!validPayment}>{tr("حفظ")}</button>{editing&&<button type="button" className="soft" onClick={reset}>{tr("إلغاء التعديل")}</button>}</div>
        </form>
      </fieldset>}
      {canManage&&accrualEdit&&<fieldset className="panel"><legend>{tr("تعديل الاستحقاق")}</legend><form className="employee-form" onSubmit={e=>{e.preventDefault();void act({type:"employee-accrual.update",documentId:accrualEdit.id,expectedRevision:accrualEdit.revision??0,amount:Number(accrualAmount),occurredAt:accrualDate,reason})}}><label>{tr("المبلغ")}<input required type="number" min="0.01" step="0.01" value={accrualAmount} onChange={e=>setAccrualAmount(e.target.value)}/></label><label>{tr("تاريخ الاستحقاق")}<input required type="date" max={localBusinessDay()} value={accrualDate} onChange={e=>setAccrualDate(e.target.value)}/></label><label>{tr("سبب التعديل")}<input required value={reason} onChange={e=>setReason(e.target.value)}/></label><div className="employee-actions"><button className="primary" disabled={busy}>{tr("حفظ التعديل")}</button><button className="soft" type="button" onClick={reset}>{tr("إلغاء التعديل")}</button></div></form></fieldset>}
    </>}
    </div>
    {employee&&<fieldset className="panel employees-history">
      <legend>{tr("سجل حساب العامل")}</legend>
      <div className="erp-table-wrap"><table className="erp-table">
        <thead><tr><th>{tr("المستند")}</th><th>{tr("التاريخ")}</th><th>{tr("النوع")}</th><th>{tr("المبلغ")}</th><th>{tr("إجراء")}</th></tr></thead>
        <tbody>{documents.map(document=>{
          const isPayment=document.kind==="employee-payment",deposit=isPayment&&paymentDirection(document)==="deposit";
          const canChange=document.status==="posted"&&(isPayment?canPay:canManage);
          return <tr key={document.id} className={document.status==="voided"?"employee-history-voided":""}>
            <td><button className="source-link" dir="ltr" title={displayDocumentNumber(document)} onClick={()=>openDoc(document.id)}>{displayDocumentNumber(document)}</button></td>
            <td>{formatDate(document.occurredAt)}</td>
            <td>{tr(isPayment?deposit?"إيداع العامل":"سحب العامل":"استحقاق عامل")}
              {document.periodStart&&<small className="employee-period">{formatDate(document.periodStart)} — {formatDate(document.periodEnd??document.periodStart)}</small>}
              {document.status==="voided"&&<small className="employee-period">{tr("pm.voided")}</small>}
            </td>
            <td className={isPayment&&!deposit?"negative":"positive"}>{money(document.total)}</td>
            <td className="action-cell">{canChange&&<div className="employee-actions">
              <button className="soft" disabled={busy} aria-label={`${tr("تعديل")} ${displayDocumentNumber(document)}`} onClick={()=>void editDocument(document)}><PencilLine/></button>
              <button className="danger" disabled={busy} aria-label={`${tr("إلغاء السند")} ${displayDocumentNumber(document)}`} onClick={()=>void remove(document)}><X/></button>
            </div>}</td>
          </tr>;
        })}{!documents.length&&<tr><td colSpan={5}>{tr("لا توجد حركات")}</td></tr>}</tbody>
      </table></div>
    </fieldset>}
  </section>;
}
