"use client";
import {money} from "./domain";
import {reportNumber,type ReportResponse} from "./report-types";
import {reportCostUnknown} from "./report-cost-status";
import {tr} from "./i18n/messages";
export function PayrollReportPanel({result,openEmployee}:{result:ReportResponse;openEmployee?:()=>void}){
  const s=result.summary;
  return <section className="payroll-report-panel" aria-label={tr("حسابات العمال")}><h3>{tr("حسابات العمال")}</h3><div className="payroll-report-metrics"><div><small>{tr("رصيد العمال المستحق")}</small><strong className="positive">{money(reportNumber(s.currentWorkersOwed))}</strong></div><div><small>{tr("مصروف العمال المدفوع")}</small><strong className="negative">{money(reportNumber(s.workersPaid))}</strong></div><div><small>{tr("استحقاقات العمال خلال الفترة")}</small><strong>{money(reportNumber(s.workersAccrued))}</strong></div><div><small>{tr("الربح المتاح بعد حقوق العمال")}</small><strong className={reportNumber(s.ownerAvailableProfit)<0?"negative":"positive"}>{reportCostUnknown("netOperatingResult",s)?tr("ac.unknown"):money(reportNumber(s.ownerAvailableProfit))}</strong></div></div><p className="employee-hint">{tr("الرصيد المستحق حالي ولم يسحب بعد. المدفوع والاستحقاقات يخصان الفترة المختارة؛ صرف مستحق قديم لا يخصم حق العامل من الربح المتاح مرتين.")}</p>{openEmployee&&<button className="soft no-print" onClick={openEmployee}>{tr("حسابات العمال")}</button>}</section>;
}
