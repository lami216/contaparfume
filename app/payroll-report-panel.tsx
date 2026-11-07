"use client";
import { money } from "./domain";
import { reportNumber, type ReportResponse } from "./report-types";
import { tr } from "./i18n/messages";

export function PayrollReportPanel({ result, openBalance, openPaid }: {
  result: ReportResponse;
  openBalance?: () => void;
  openPaid?: () => void;
}) {
  const owed = reportNumber(result.summary.currentWorkersUnpaidWages ?? result.summary.currentWorkersOwed);
  const paid = reportNumber(result.summary.workersExpense ?? result.summary.workersPaid);
  const counters = [
    { key: "owed", label: tr("حقوق العمال غير المصروفة"), value: owed ? -owed : 0, tone: "positive", open: openBalance },
    { key: "paid", label: tr("مصروف أجور العمال"), value: paid ? -paid : 0, tone: "negative", open: openPaid },
  ];
  return <div className="payroll-profit-counters" aria-label={tr("حسابات العمال")}>
    {counters.map(counter => {
      const content = <><small>{counter.label}</small><strong className={counter.tone} dir="ltr">{money(counter.value)}</strong></>;
      return counter.open
        ? <button type="button" className="payroll-profit-counter" key={counter.key} onClick={counter.open}>{content}</button>
        : <div className="payroll-profit-counter" key={counter.key}>{content}</div>;
    })}
  </div>;
}
