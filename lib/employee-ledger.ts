import type { ReportRow } from "../app/report-types.ts";
import { displayDocumentNumber } from "./document-sequences.ts";
import { employeePaymentDirection } from "./payroll.ts";

type Stored = Record<string, unknown>;
type Period = { from?: string; to?: string };

function finiteAmount(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

const cents = (value: unknown) => Math.round((finiteAmount(value) ?? 0) * 100);

/** Worker balances use the opposite sign to the shop's receivable/payable ledger. */
export function employeeAccountRow(employee: Stored): ReportRow {
  const net = cents(employee.balance) ? -cents(employee.balance) / 100 : 0;
  return {
    id: String(employee.id), partyId: String(employee.id), employeeId: String(employee.id),
    name: String(employee.name ?? ""), phone: String(employee.phone ?? ""),
    partyType: "employee", accountType: "عامل", balance: Math.abs(net), net,
    receivable: Math.max(net, 0), payable: Math.max(-net, 0),
    lastMovement: String(employee.lastMovementAt ?? employee.updatedAt ?? ""),
  };
}

function employeeDelta(document: Stored) {
  const saved = finiteAmount(document.balanceDelta);
  if (saved !== null) return cents(saved);
  const amount = cents(document.total);
  if (document.kind === "employee-accrual") return amount;
  return employeePaymentDirection(document) === "deposit" ? amount : -amount;
}

/** Running balances include the full posted history before period selection or paging. */
export function buildEmployeeLedger(employee: Stored, documents: Stored[], period: Period = {}) {
  const employeeId = String(employee.id);
  const posted = documents.filter(document => document.employeeId === employeeId && document.status === "posted" &&
    (document.kind === "employee-accrual" || document.kind === "employee-payment"));
  const ordered = [...posted].sort((left, right) =>
    String(left.businessDate ?? String(left.occurredAt).slice(0, 10)).localeCompare(String(right.businessDate ?? String(right.occurredAt).slice(0, 10))) ||
    Number(left.kind === "employee-payment") - Number(right.kind === "employee-payment") ||
    Number(left.employeeAccountOrder ?? 0) - Number(right.employeeAccountOrder ?? 0) ||
    String(left.createdAt ?? left.occurredAt).localeCompare(String(right.createdAt ?? right.occurredAt)) ||
    String(left.id).localeCompare(String(right.id)));
  let running = 0, opening = 0, closing = 0, debit = 0, credit = 0;
  let accrued = 0, withdrawn = 0, deposited = 0;
  const rows: ReportRow[] = [];
  for (const document of ordered) {
    const delta = -employeeDelta(document);
    const day = String(document.businessDate ?? document.occurredAt ?? "").slice(0, 10);
    running += delta;
    if (period.from && day < period.from) opening += delta;
    if (!period.to || day <= period.to) closing += delta;
    if ((period.from && day < period.from) || (period.to && day > period.to)) continue;
    const isAccrual = document.kind === "employee-accrual";
    const direction = employeePaymentDirection(document);
    const movementCode = isAccrual ? "employee-accrual" : direction === "deposit" ? "employee-deposit" : "employee-withdrawal";
    const movementType = isAccrual ? "استحقاق عامل" : direction === "deposit" ? "إيداع من العامل" : "سحب العامل";
    debit += Math.max(delta, 0);
    credit += Math.max(-delta, 0);
    if (isAccrual) accrued += cents(document.total);
    else if (direction === "deposit") deposited += cents(document.total);
    else withdrawn += cents(document.total);
    const note = typeof document.note === "string" ? document.note.trim() : "";
    rows.push({
      id: String(document.id), documentId: String(document.id), partyId: employeeId, employeeId, partyType: "employee",
      occurredAt: String(document.occurredAt), movementType, movementCode,
      documentNumber: displayDocumentNumber(document), description: movementType + (note ? ` — ${note}` : ""),
      descriptionCode: movementCode, debit: Math.max(delta, 0) / 100, credit: Math.max(-delta, 0) / 100,
      balance: running / 100, runningBalance: running / 100, paymentMethod: String(document.paymentMethod ?? ""),
    });
  }
  const current = cents(employee.balance) ? -cents(employee.balance) : 0;
  return {
    rows: rows.reverse(),
    summary: {
      name: String(employee.name ?? ""), partyType: "employee", tradeTotal: 0,
      workersAccrued: accrued / 100, workersPaid: withdrawn / 100, workersDeposited: deposited / 100,
      debitTotal: debit / 100, creditTotal: credit / 100,
      openingBalance: opening / 100, closingBalance: closing / 100, currentBalance: current / 100,
      net: current / 100, receivable: Math.max(current, 0) / 100, payable: Math.max(-current, 0) / 100,
      reconciliationDifference: (current - running) / 100, transactionCount: rows.length,
    },
  };
}
