import { createHash, randomUUID } from "node:crypto";
import type { DbDocument as Row, SqliteDatabase, SqliteSession } from "./sqlite.ts";
import { findActiveFinancialMovement, postFinancialMovement, reverseFinancialMovement } from "./transaction-lifecycle.ts";

export class PayrollError extends Error {
  constructor(message: string, public status = 400, public blockers: Array<{ documentId: string; number: string }> = []) {
    super(message);
  }
}

export type PayrollAgreement = { id: string; startDate: string; amount: number; intervalMonths: number; entitlement: "beginning" | "end"; anchorDay: number; stopDate?: string; canceledAt?: string };
export type PayrollEmployee = Row & { id: string; name: string; phone: string; startDate: string; balance: number; revision: number; isArchived: boolean; agreements: PayrollAgreement[] };
type Agreement = PayrollAgreement;
type Employee = PayrollEmployee;
type Period = { startDate: string; endDate: string; dueDate: string; agreement: Agreement };
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const fail = (message: string, status = 400) => new PayrollError(message, status);
const id = (prefix: string) => `${prefix}-${randomUUID()}`;
const amount = (cents: number) => cents / 100;
function signedMoney(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw fail("رصيد العامل غير صالح");
  return Math.sign(value) * money(Math.abs(value), true);
}
export function employeePaymentDirection(document: Row): "withdraw" | "deposit" {
  const value = document.employeePaymentDirection ?? "withdraw";
  if (value !== "withdraw" && value !== "deposit") throw fail("نوع حركة حساب العامل غير صالح");
  return value;
}
export function employeeOpeningDirection(document: Row): "payable" | "receivable" {
  const value = document.employeeOpeningDirection;
  if (value !== "payable" && value !== "receivable") throw fail("اتجاه رصيد بداية العامل غير صالح");
  return value;
}
const accountSign = (document: Row) => document.kind === "employee-opening" ? employeeOpeningDirection(document) === "payable" ? 1 : -1 : document.kind === "employee-closure" ? -1 : document.kind === "employee-accrual" || employeePaymentDirection(document) === "deposit" ? 1 : -1;
function money(value: unknown, allowZero = false) {
  if ((typeof value !== "number" && typeof value !== "string") || text(String(value)) === "" ||
      (typeof value === "string" && !/^\d+(?:\.\d{1,2})?$/.test(value.trim()))) throw fail("المبلغ يجب أن يكون رقمًا صالحًا بخانتين عشريتين على الأكثر");
  const number = Number(value), cents = Math.round(number * 100);
  if (!Number.isFinite(number) || !Number.isSafeInteger(cents) || (allowZero ? cents < 0 : cents <= 0) || Math.abs(number * 100 - cents) > 1e-7) throw fail("المبلغ يجب أن يكون رقمًا موجبًا صالحًا");
  return cents;
}
/** Match ordinary cash movements: balances may be negative and retain sub-cent precision. */
function assertPaymentAccountBalance(account: Row) {
  const raw = account.balance;
  const balance = typeof raw === "number" ? raw : typeof raw === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isFinite(balance)) throw fail("بيانات رصيد الحساب غير صالحة", 409);
}
function day(value: unknown) {
  const input = text(value), date = new Date(`${input}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input) || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== input || Number(input.slice(0, 4)) < 1900) throw fail("التاريخ غير صالح");
  return input;
}
const today = (now: Date) => day(now.toISOString().slice(0, 10));
const iso = (date: string) => `${date}T12:00:00.000Z`;
function interval(value: unknown) {
  const months = Number(value ?? 1);
  if (!Number.isSafeInteger(months) || months < 1 || months > 12) throw fail("فترة الراتب يجب أن تكون بين شهر واحد و12 شهرًا");
  return months;
}
function timing(value: unknown): Agreement["entitlement"] {
  if (value !== "beginning" && value !== "end") throw fail("اختر الاستحقاق في بداية الفترة أو نهايتها");
  return value;
}
function boundary(start: string, months: number, anchorDay: number) {
  const year = Number(start.slice(0, 4)), month = Number(start.slice(5, 7)) - 1;
  const target = new Date(Date.UTC(year, month + months, 1));
  const maximum = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(anchorDay, maximum));
  return target.toISOString().slice(0, 10);
}
const monthsBetween = (start: string, end: string) =>
  (Number(end.slice(0, 4)) - Number(start.slice(0, 4))) * 12 + Number(end.slice(5, 7)) - Number(start.slice(5, 7));
function shiftDay(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const priorDay = (value: string) => shiftDay(value, -1);
const agreements = (employee: Employee) => employee.agreements.filter(row => !row.canceledAt).slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
function periods(employee: Employee, asOf: string) {
  const result: Period[] = [], schedule = agreements(employee);
  for (const [index, agreement] of schedule.entries()) {
    if (money(agreement.amount, true) === 0) continue;
    if (agreement.startDate < employee.startDate) continue;
    const nextAgreement = schedule[index + 1]?.startDate;
    for (let startDate = agreement.startDate; startDate <= asOf && (!nextAgreement || startDate < nextAgreement);) {
      const next = boundary(startDate, agreement.intervalMonths, agreement.anchorDay), endDate = priorDay(next);
      const dueDate = agreement.entitlement === "beginning" ? startDate : endDate;
      if (dueDate > asOf || (agreement.stopDate && dueDate > agreement.stopDate)) break;
      result.push({ startDate, endDate, dueDate, agreement });
      startDate = next;
    }
  }
  return result;
}
export function nextPayrollAgreementStart(employee: Employee, asOf: string) {
  const date = day(asOf), schedule = agreements(employee);
  const agreement = schedule.filter(row => row.startDate <= date).at(-1) ?? schedule[0];
  if (!agreement) throw fail("اتفاق الراتب غير موجود", 409);
  if (agreement.startDate > date) return agreement.startDate;
  let next = agreement.startDate;
  while (next <= date) next = boundary(next, agreement.intervalMonths, agreement.anchorDay);
  return next;
}
const accrualId = (employeeId: string, periodStart: string) => `employee-accrual-${createHash("sha256").update(JSON.stringify([employeeId, periodStart])).digest("hex").slice(0, 32)}`;
function checkRevision(row: Row, input: Row) {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision !== Number(row.revision ?? 0)) throw fail("تغير السجل. حدّث الصفحة وأعد المحاولة", 409);
}
function reason(input: Row) {
  const value = text(input.reason);
  if (!value || value.length > 1000) throw fail("سبب التعديل أو الإلغاء مطلوب");
  return value;
}
async function atomic<T>(db: SqliteDatabase, session: SqliteSession, work: (session: SqliteSession) => Promise<T>): Promise<T> {
  if (!db.native.inTransaction) return db.transaction(work);
  const point = `payroll_${randomUUID().replaceAll("-", "")}`;
  db.native.exec(`SAVEPOINT ${point}`);
  try { const result = await work(session); db.native.exec(`RELEASE SAVEPOINT ${point}`); return result; }
  catch (error) { db.native.exec(`ROLLBACK TO SAVEPOINT ${point}`); db.native.exec(`RELEASE SAVEPOINT ${point}`); throw error; }
}
async function audit(db: SqliteDatabase, action: string, before: Row | null, after: Row, now: Date) {
  await db.collection("auditEvents").insertOne({ id: id("payroll-audit"), action: `payroll.${action}`, status: "committed", entityId: after.id, employeeId: after.employeeId ?? after.id, createdAt: now.toISOString(), before, after });
}
async function employeeById(db: SqliteDatabase, value: unknown) {
  const employee = await db.collection("employees").findOne({ id: text(value) }) as Employee | undefined;
  if (!employee || !Array.isArray(employee.agreements) || !employee.agreements.length) throw fail("الموظف غير موجود أو اتفاقه غير صالح", 404);
  if (employee.isDeleted === true) throw fail("العامل محذوف نهائيًا؛ لا يمكن تعديل سجله أو استعادته", 409);
  return employee;
}
async function changeBalance(db: SqliteDatabase, employee: Employee, delta: number, now: Date) {
  const before = signedMoney(employee.balance), after = before + delta;
  if (!Number.isSafeInteger(after)) throw fail("رصيد العامل غير صالح", 409);
  const changed = await db.collection("employees").updateOne({ id: employee.id, balance: employee.balance }, { $set: { balance: amount(after), updatedAt: now.toISOString() } });
  if (!changed.matchedCount) throw fail("تغير رصيد الموظف. حدّث الصفحة وأعد المحاولة", 409);
  employee.balance = amount(after);
}
async function state(db: SqliteDatabase, employee: Employee) {
  const documents = await db.collection("documents").find({ employeeId: employee.id, kind: { $in: ["employee-accrual", "employee-payment", "employee-closure", "employee-opening"] } }).toArray();
  const accruals = documents.filter(row => row.kind === "employee-accrual"), allocated = new Map<string, number>();
  for (const payment of documents.filter(row => row.kind === "employee-payment" && row.status === "posted")) {
    if (!Array.isArray(payment.allocations)) throw fail("روابط دفعة الموظف غير صالحة", 409);
    if (payment.employeePaymentVersion === 2) {
      if (payment.allocations.length) throw fail("روابط حركة حساب العامل غير صالحة", 409);
      continue;
    }
    let paid = 0;
    for (const allocation of payment.allocations) {
      const cents = money(allocation.amount), source = accruals.find(row => row.id === allocation.accrualId && row.status === "posted");
      if (!source || String(source.dueDate) > String(payment.businessDate)) throw fail("دفعة الموظف تشير إلى استحقاق غير صالح", 409);
      allocated.set(source.id, (allocated.get(source.id) ?? 0) + cents); paid += cents;
    }
    if (paid !== money(payment.total)) throw fail("مجموع توزيع دفعة الموظف غير مطابق", 409);
  }
  let balance = 0;
  let previousEnd = "";
  for (const accrual of accruals.filter(row => row.status === "posted").sort((a, b) => String(a.periodStart).localeCompare(String(b.periodStart)))) {
    const start = day(accrual.periodStart), end = day(accrual.periodEnd);
    if (end < start || (previousEnd && start <= previousEnd)) throw fail("فترات استحقاق الموظف متداخلة", 409);
    previousEnd = end;
  }
  for (const accrual of accruals) {
    if (accrual.id !== accrualId(employee.id, String(accrual.periodStart))) throw fail("معرف استحقاق الموظف غير صالح", 409);
    if (accrual.status !== "posted") continue;
    const remaining = money(accrual.total) - (allocated.get(accrual.id) ?? 0);
    if (remaining < 0) throw fail("دفعات الموظف تتجاوز الاستحقاق", 409);
    balance += money(accrual.total);
  }
  for (const payment of documents.filter(row => row.kind === "employee-payment" && row.status === "posted")) {
    balance += accountSign(payment) * money(payment.total);
  }
  for (const closure of documents.filter(row => row.kind === "employee-closure" && row.status === "posted")) balance -= money(closure.total);
  const openings = documents.filter(row => row.kind === "employee-opening" && row.status === "posted");
  if (openings.length > 1) throw fail("يوجد أكثر من رصيد بداية معتمد للعامل", 409);
  for (const opening of openings) balance += accountSign(opening) * money(opening.total);
  if (balance !== signedMoney(employee.balance)) throw fail("رصيد الموظف لا يطابق سجل استحقاقاته ودفعاته", 409);
  return { documents, accruals, allocated };
}
async function accrueEmployee(db: SqliteDatabase, employee: Employee, asOf: string, now: Date, context: string) {
  const saved = await state(db, employee), byId = new Map(saved.accruals.map(row => [row.id, row]));
  let created = 0, totalAccrued = 0;
  for (const period of periods(employee, asOf)) {
    const documentId = accrualId(employee.id, period.startDate), existing = byId.get(documentId);
    if (existing) continue;
    assertAfterOpening(saved.documents, period.dueDate);
    const cents = money(period.agreement.amount);
    const document = { id: documentId, number: `EMP-${period.startDate}-${documentId.slice("employee-accrual-".length)}`, kind: "employee-accrual", status: "posted", revision: 0,
      employeeId: employee.id, employeeName: employee.name, periodStart: period.startDate, periodEnd: period.endDate, dueDate: period.dueDate,
      businessDate: period.dueDate, occurredAt: iso(period.dueDate), total: amount(cents), amount: amount(cents), balanceDelta: amount(cents),
      agreementSnapshot: structuredClone(period.agreement), lines: [], createdAt: now.toISOString(), context };
    await db.collection("documents").insertOne(document);
    await changeBalance(db, employee, cents, now);
    await audit(db, "employee-accrual.automatic", null, document, now);
    byId.set(documentId, document); created++; totalAccrued += cents;
  }
  return { created, totalAccrued };
}

/** Call during bootstrap/restore in the same transaction, using local business day. */
export async function accrueDueEmployees(db: SqliteDatabase, session: SqliteSession, options: { asOf?: string; context?: string; now?: Date } = {}) {
  const now = options.now ?? new Date(), asOf = day(options.asOf ?? today(now));
  if (asOf > today(now)) throw fail("لا يمكن اعتماد استحقاق قبل حلول تاريخه");
  return atomic(db, session, async () => {
    const employees = await db.collection("employees").find({ isArchived: { $ne: true }, isDeleted: { $ne: true } }).toArray() as Employee[];
    let created = 0, totalAccrued = 0;
    for (let employee of employees) {
      if (hasLegacyResumeShape(employee)) {
        const [documents, events] = await Promise.all([
          db.collection("documents").find({ employeeId: employee.id, kind: "employee-accrual" }).toArray(),
          db.collection("auditEvents").find({ employeeId: employee.id, action: { $in: ["payroll.employee.restore", "payroll.employee.update"] } }).toArray(),
        ]);
        const repaired = repairLegacyPayrollResume(employee, documents, events);
        if (repaired !== employee) {
          repaired.updatedAt = now.toISOString();
          const changed = await db.collection("employees").updateOne({ id: employee.id, revision: employee.revision }, {
            $set: { agreements: repaired.agreements, revision: repaired.revision, updatedAt: repaired.updatedAt },
          });
          if (!changed.matchedCount) throw fail("تغير الموظف أثناء العملية، أعد المحاولة", 409);
          await audit(db, "employee.resume-repair", employee, repaired, now);
          employee = repaired;
        }
      }
      const result = await accrueEmployee(db, employee, asOf, now, options.context ?? "automatic");
      created += result.created; totalAccrued += result.totalAccrued;
    }
    return { created, totalAccrued: amount(totalAccrued), employeeCount: employees.length };
  });
}

function agreementFrom(input: Row, startDate: string, anchorDay: number): Agreement {
  return { id: id("agreement"), startDate, amount: amount(money(input.amount, true)), intervalMonths: interval(input.intervalMonths), entitlement: timing(input.entitlement), anchorDay };
}
function validateSchedule(schedule: Agreement[]) {
  const active = schedule.filter(row => !row.canceledAt).sort((a, b) => a.startDate.localeCompare(b.startDate));
  for (const agreement of active) {
    day(agreement.startDate);
    if (interval(agreement.intervalMonths) !== agreement.intervalMonths || !Number.isSafeInteger(agreement.anchorDay) ||
        agreement.anchorDay < 1 || agreement.anchorDay > 31) throw fail("اتفاق الراتب غير صالح");
  }
  for (let index = 1; index < active.length; index++) {
    const previous = active[index - 1], current = active[index];
    if (previous.stopDate && previous.stopDate < current.startDate) continue;
    let at = previous.startDate;
    while (at < current.startDate) at = boundary(at, previous.intervalMonths, previous.anchorDay);
    if (at !== current.startDate || previous.startDate === current.startDate) throw fail("الاتفاق الجديد يجب أن يبدأ عند بداية فترة راتب تالية دون تداخل", 409);
  }
}
function clipSameDayStop(schedule: Agreement[], previous: Agreement | undefined, resumeDate: string) {
  if (previous?.stopDate !== resumeDate || previous.startDate >= resumeDate) return schedule;
  return schedule.map(row => row.id === previous.id ? { ...row, stopDate: priorDay(resumeDate) } : row);
}
function hasLegacyResumeShape(employee: Employee) {
  const active = agreements(employee);
  return active.some((row, index) => row.startDate < employee.startDate || active[index - 1]?.stopDate === row.startDate);
}
const agreementTerms = ["id", "startDate", "amount", "intervalMonths", "entitlement", "anchorDay"] as const;
function scheduleCorrectionEvents(employee: Employee, events: Row[]) {
  return events.filter(event => event.action === "payroll.employee.schedule-correction" && event.status === "committed" && event.employeeId === employee.id &&
    typeof event.createdAt === "string" && Number.isFinite(Date.parse(event.createdAt)) &&
    event.before?.id === employee.id && event.after?.id === employee.id && Number.isSafeInteger(event.before.revision) &&
    event.after.revision === event.before.revision + 1 && event.after.revision <= employee.revision &&
    event.after.scheduleRecalculation?.version === 1 && Array.isArray(event.after.scheduleRecalculation.paymentIds));
}
function correctedHistoricalAgreement(employee: Employee, agreement: Agreement, events: Row[]) {
  return scheduleCorrectionEvents(employee, events).some(event =>
    Array.isArray(event.before.agreements) && Array.isArray(event.after.agreements) &&
    event.before.agreements.some((row: Agreement) => agreementTerms.every(key => row[key] === agreement[key])) &&
    event.after.agreements.some((row: Agreement) => agreementTerms.every(key => row[key] === agreement[key]) && row.canceledAt === agreement.canceledAt) &&
    typeof agreement.canceledAt === "string" && agreement.canceledAt <= event.createdAt);
}
function correctedHistoricalPayment(employee: Employee, document: Row, events: Row[]) {
  return scheduleCorrectionEvents(employee, events).some(event =>
    event.after.scheduleRecalculation.paymentIds.includes(document.id) && document.businessDate >= event.before.startDate &&
    typeof document.createdAt === "string" && document.createdAt <= event.createdAt);
}
function verifiedHistoricalRepayment(employee: Employee, document: Row, events: Row[]) {
  const proof = document.employeeHistoricalRepayment;
  if (!proof || proof.version !== 1 || employeePaymentDirection(document) !== "deposit" || typeof proof.beforeBalance !== "number" || proof.beforeBalance >= 0 ||
      money(document.total) > -signedMoney(proof.beforeBalance) || !text(proof.withdrawalDocumentId)) return false;
  const source = events.some(event => event.status === "committed" && event.employeeId === employee.id &&
    ["payroll.employee-payment.post", "payroll.employee-payment.update"].includes(event.action) && event.after?.id === proof.withdrawalDocumentId &&
    employeePaymentDirection(event.after) === "withdraw" && event.after.businessDate <= document.businessDate && event.createdAt <= document.createdAt);
  return source && events.some(event => event.status === "committed" && event.employeeId === employee.id &&
    ["payroll.employee-payment.post", "payroll.employee-payment.update"].includes(event.action) && event.after?.id === document.id &&
    (event.after.revision === document.revision || (document.status === "voided" && event.after.revision + 1 === document.revision)) && event.after.total === document.total && event.after.businessDate === document.businessDate &&
    event.after.employeeHistoricalRepayment?.version === 1 && event.after.employeeHistoricalRepayment.beforeBalance === proof.beforeBalance &&
    event.after.employeeHistoricalRepayment.withdrawalDocumentId === proof.withdrawalDocumentId);
}
/** A retained cash entry can outlive an edited/voided opening. Only server
 * posting audits prove that its early business date had a valid account anchor. */
function verifiedOpeningPayment(employee: Employee, document: Row, events: Row[]) {
  const openingId = text(document.employeeOpeningAnchor?.openingDocumentId);
  if (!openingId || document.employeePaymentVersion !== 2) return false;
  return events.some(event => event.status === "committed" && event.employeeId === employee.id &&
    ["payroll.employee-payment.post", "payroll.employee-payment.update"].includes(event.action) && event.after?.id === document.id &&
    (event.after.revision === document.revision || (document.status === "voided" && event.after.revision + 1 === document.revision)) &&
    event.after.total === document.total && event.after.businessDate === document.businessDate && event.after.employeePaymentDirection === document.employeePaymentDirection &&
    event.after.employeeOpeningAnchor?.openingDocumentId === openingId && typeof event.createdAt === "string" &&
    events.some(source => source.status === "committed" && source.employeeId === employee.id &&
      ["payroll.employee-opening.post", "payroll.employee-opening.update"].includes(source.action) && source.createdAt <= event.createdAt &&
      source.after?.id === openingId && source.after.employeeId === employee.id && source.after.kind === "employee-opening" && source.after.status === "posted" && source.after.businessDate <= document.businessDate));
}
const openingDateFailure = () => fail("تاريخ الحركة يسبق رصيد بداية العامل؛ عدّل تاريخ رصيد البداية أولًا ثم أعد المحاولة", 409);
function assertAfterOpening(documents: Row[], date: string) {
  const opening = documents.find(document => document.kind === "employee-opening" && document.status === "posted");
  if (opening && date < opening.businessDate) throw openingDateFailure();
}
async function saveEmployeeOpening(db: SqliteDatabase, employee: Employee, input: Row, now: Date, previous?: Row) {
  const ledger = await state(db, employee), cents = money(input.amount ?? previous?.total);
  const direction = input.direction ?? previous?.employeeOpeningDirection;
  if (direction !== "payable" && direction !== "receivable") throw fail("اختر لنا أو علينا لرصيد بداية العامل");
  if (ledger.documents.some(document => document.kind === "employee-opening" && document.status === "posted" && document.id !== previous?.id)) throw fail("يوجد رصيد بداية معتمد للعامل؛ عدّله أو ألغِه أولًا", 409);
  const date = day(input.occurredAt ?? previous?.businessDate ?? today(now));
  const bounds = [today(now), ...ledger.documents.filter(document => document.kind !== "employee-opening").map(document => day(document.businessDate)), ...periods(employee, today(now)).map(period => period.dueDate)];
  if (bounds.some(bound => date > bound)) throw fail("تاريخ رصيد البداية يجب ألا يتجاوز اليوم أو أول حركة أو استحقاق للعامل", 409);
  const note = input.note === undefined ? text(previous?.note) : text(input.note);
  if (note.length > 1000) throw fail("ملاحظة رصيد البداية طويلة جدًا");
  const delta = (direction === "payable" ? 1 : -1) * cents;
  const document = { id: previous?.id ?? id("employee-opening"), number: previous?.number ?? `EMP-OPEN-${randomUUID()}`, kind: "employee-opening", status: "posted", revision: Number(previous?.revision ?? -1) + 1,
    employeeId: employee.id, employeeName: employee.name, employeeOpeningDirection: direction,
    employeeAccountOrder: previous?.employeeAccountOrder ?? Math.max(0, ...ledger.documents.map(row => Number(row.employeeAccountOrder ?? 0))) + 1,
    total: amount(cents), amount: amount(cents), balanceDelta: amount(delta), businessDate: date, occurredAt: iso(date),
    paymentMethod: null, cashAmount: 0, paidTotal: 0, dueTotal: 0, lines: [], note, createdAt: previous?.createdAt ?? now.toISOString(), ...(previous ? { updatedAt: now.toISOString(), correctionReason: reason(input) } : {}) };
  await changeBalance(db, employee, delta - (previous ? accountSign(previous) * money(previous.total) : 0), now);
  if (previous) {
    const changed = await db.collection("documents").updateOne({ id: previous.id, status: "posted", revision: previous.revision }, { $set: document });
    if (!changed.matchedCount) throw fail("تغير رصيد البداية أثناء العملية؛ حدّث الصفحة وأعد المحاولة", 409);
  }
  else await db.collection("documents").insertOne(document);
  await audit(db, previous ? "employee-opening.update" : "employee-opening.post", previous ? structuredClone(previous) : null, document, now);
  await state(db, employee);
  return document;
}
function legacyAgreementEvent(employee: Employee, agreement: Agreement, events: Row[], action = "payroll.employee.restore", maxRevision = employee.revision) {
  return events.find(event => {
    if (!event) return false;
    const { before, after } = event;
    return event.action === action && event.status === "committed" && event.employeeId === employee.id &&
      typeof event.createdAt === "string" && Number.isFinite(Date.parse(event.createdAt)) &&
      before?.id === employee.id && after?.id === employee.id &&
      before.isArchived === (action === "payroll.employee.restore") && after.isArchived === false &&
      before.startDate === employee.startDate && after.startDate === employee.startDate &&
      Number.isSafeInteger(before.revision) && after.revision === before.revision + 1 && after.revision <= maxRevision &&
      Array.isArray(before.agreements) && Array.isArray(after.agreements) &&
      !before.agreements.some((row: Agreement) => row?.id === agreement.id) &&
      after.agreements.some((row: Agreement) => row && agreementTerms.every(key => row[key] === agreement[key]));
  });
}
function legacyEarlyAgreement(employee: Employee, agreement: Agreement, events: Row[]) {
  if (agreement.startDate >= employee.startDate) return;
  let candidate = agreement, revision = employee.revision;
  for (;;) {
    const resumed = legacyAgreementEvent(employee, candidate, events, "payroll.employee.restore", revision);
    if (resumed?.before.agreements.some((row: Agreement) => row?.startDate === employee.startDate && row.canceledAt)) return resumed;
    const edited = legacyAgreementEvent(employee, candidate, events, "payroll.employee.update", revision);
    if (!edited) return;
    const previous = edited.before.agreements.find((row: Agreement) => row?.startDate === candidate.startDate && !row.canceledAt);
    if (!previous) {
      if (edited.before.agreements.some((row: Agreement) => row?.startDate === employee.startDate && !row.canceledAt)) return edited;
      return;
    }
    candidate = previous;
    revision = edited.before.revision;
  }
}

/** Repair the schedule, retaining every historical accrual, allocation and cash entry. */
export function repairLegacyPayrollResume(employee: Employee, documents: Row[], events: Row[]) {
  if (!Array.isArray(employee?.agreements) || !employee.agreements.every(row => row && typeof row.startDate === "string") ||
      !hasLegacyResumeShape(employee)) return employee;
  let schedule = employee.agreements;
  const active = agreements(employee);
  const posted = documents.filter(row => row.employeeId === employee.id && row.kind === "employee-accrual" && row.status === "posted");
  for (const [index, agreement] of active.entries()) {
    const early = legacyEarlyAgreement(employee, agreement, events);
    if (early) {
      schedule = schedule.map(row => row.id === agreement.id ? { ...row, canceledAt: early.createdAt } : row);
      const successor = active[index + 1];
      if (!employee.isArchived && (!successor || successor.startDate >= employee.startDate)) {
        const lastEnd = posted.map(row => day(row.periodEnd)).sort().at(-1);
        const startDate = lastEnd && lastEnd >= employee.startDate ? shiftDay(lastEnd, 1) : employee.startDate;
        const replacement = { ...agreement, id: `${agreement.id}-after-start`, startDate, anchorDay: Number(startDate.slice(-2)) };
        delete replacement.stopDate;
        if (!successor) schedule = [...schedule, replacement];
        else if (startDate < successor.startDate) {
          const distance = monthsBetween(startDate, successor.startDate);
          if (distance > 0 && distance % replacement.intervalMonths === 0 && boundary(startDate, distance, replacement.anchorDay) === successor.startDate) {
            schedule = [...schedule, { ...replacement, stopDate: priorDay(successor.startDate) }];
          }
        }
      }
    }
    const previous = active[index - 1];
    if (previous?.stopDate !== agreement.startDate || previous.startDate >= agreement.startDate) continue;
    const event = legacyAgreementEvent(employee, agreement, events);
    if (!event?.before.agreements.some((row: Agreement) => row?.id === previous.id && row.stopDate === agreement.startDate) ||
        posted.some(row => row.agreementSnapshot?.id === previous.id && row.periodEnd >= agreement.startDate)) continue;
    schedule = clipSameDayStop(schedule, previous, agreement.startDate);
  }
  if (schedule === employee.agreements) return employee;
  validateSchedule(schedule);
  return { ...employee, agreements: schedule.sort((a, b) => a.startDate.localeCompare(b.startDate)), revision: employee.revision + 1 };
}
async function paymentDate(db: SqliteDatabase, input: Row, employee: Employee, now: Date, previous?: Row) {
  const date = day(input.occurredAt ?? today(now));
  assertAfterOpening(await db.collection("documents").find({ employeeId: employee.id, kind: "employee-opening", status: "posted" }).toArray(), date);
  let historical = false;
  if (previous && date === previous.businessDate && date < employee.startDate) {
    const events = await db.collection("auditEvents").find({ employeeId: employee.id }).toArray();
    historical = correctedHistoricalPayment(employee, previous, events) || verifiedHistoricalRepayment(employee, previous, events) || verifiedOpeningPayment(employee, previous, events);
  }
  if (!historical && date < employee.startDate) {
    const opening = await db.collection("documents").findOne({ employeeId: employee.id, kind: "employee-opening", status: "posted" });
    historical = Boolean(opening && opening.businessDate <= date);
  }
  if (!historical && date < employee.startDate && input.direction === "deposit" && signedMoney(employee.balance) < 0 && money(input.amount) <= -signedMoney(employee.balance)) {
    const events = await db.collection("auditEvents").find({ employeeId: employee.id, action: "payroll.employee.schedule-correction" }).toArray();
    const withdrawals = await db.collection("documents").find({ employeeId: employee.id, kind: "employee-payment", status: "posted" }).toArray();
    historical = withdrawals.some(document => employeePaymentDirection(document) === "withdraw" && document.businessDate <= date && correctedHistoricalPayment(employee, document, events));
  }
  if ((date < employee.startDate && !historical) || date > today(now)) throw fail("تاريخ الدفع يجب أن يكون بين بداية عمل الموظف واليوم");
  return date;
}
async function postPayment(db: SqliteDatabase, session: SqliteSession, employee: Employee, input: Row, now: Date, previous?: Row) {
  const cents = money(input.amount), date = await paymentDate(db, input, employee, now, previous), ledger = await state(db, employee);
  const direction = input.direction ?? previous?.employeePaymentDirection ?? "withdraw";
  if (direction !== "withdraw" && direction !== "deposit") throw fail("نوع حركة حساب العامل غير صالح");
  const opening = ledger.documents.find(document => document.kind === "employee-opening" && document.status === "posted");
  const allowAdvance = input.direction !== undefined || previous?.employeePaymentVersion === 2 || Boolean(opening);
  const accountKey = text(input.paymentMethod);
  if (!accountKey) throw fail("يجب اختيار وسيلة دفع صالحة", 409);
  const account = await db.collection("paymentAccounts").findOne({ $or: [{ id: accountKey }, { code: accountKey }] });
  const previousAccountKey = text(previous?.paymentMethod);
  const sameOriginalAccount = Boolean(previousAccountKey && account && [account.id, account.code].includes(previousAccountKey));
  if (!account || (!sameOriginalAccount && (account.isActive !== true || account.isArchived === true))) throw fail("يجب اختيار وسيلة دفع صالحة", 409);
  assertPaymentAccountBalance(account);
  // Historical corrections may retain their original stopped account, as other
  // cash edits do. New movements and a different target still require an active account.
  if (sameOriginalAccount && (account.isActive !== true || account.isArchived === true)) {
    await db.collection("paymentAccounts").updateOne({ id: account.id }, { $set: { isActive: true, isArchived: false, archivedAt: null, updatedAt: now.toISOString() } });
  }
  const allocations: Array<{ accrualId: string; amount: number }> = [];
  let remaining = cents;
  for (const accrual of ledger.accruals.filter(row => row.status === "posted" && row.dueDate <= date).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)) || String(a.periodStart).localeCompare(String(b.periodStart)))) {
    const available = money(accrual.total) - (ledger.allocated.get(accrual.id) ?? 0), paid = Math.min(remaining, available);
    if (paid > 0) allocations.push({ accrualId: accrual.id, amount: amount(paid) });
    remaining -= paid;
    if (!remaining) break;
  }
  if (direction === "withdraw" && remaining && !allowAdvance) throw fail("المبلغ يتجاوز المستحق للموظف في تاريخ الدفع", 409);
  const independent = input.direction !== undefined || direction === "deposit" || remaining > 0 || previous?.employeePaymentVersion === 2 || Boolean(opening);
  let openingAnchor: Row | undefined;
  if (date < employee.startDate) {
    if (opening && opening.businessDate <= date) openingAnchor = { openingDocumentId: opening.id };
    else if (previous && date === previous.businessDate && verifiedOpeningPayment(employee, previous, await db.collection("auditEvents").find({ employeeId: employee.id }).toArray())) openingAnchor = previous.employeeOpeningAnchor;
  }
  let historicalRepayment: Row | undefined;
  if (date < employee.startDate && direction === "deposit" && !openingAnchor) {
    const events = await db.collection("auditEvents").find({ employeeId: employee.id }).toArray();
    const existingHistorical = previous && date === previous.businessDate && correctedHistoricalPayment(employee, previous, events);
    const source = ledger.documents.find(document => document.kind === "employee-payment" && document.status === "posted" && employeePaymentDirection(document) === "withdraw" && document.businessDate <= date && correctedHistoricalPayment(employee, document, events));
    if (existingHistorical) historicalRepayment = previous.employeeHistoricalRepayment;
    else if (source && signedMoney(employee.balance) < 0 && cents <= -signedMoney(employee.balance)) historicalRepayment = { version: 1, beforeBalance: employee.balance, withdrawalDocumentId: source.id };
    else if (previous && verifiedHistoricalRepayment(employee, previous, events) && cents <= -signedMoney(previous.employeeHistoricalRepayment.beforeBalance)) historicalRepayment = previous.employeeHistoricalRepayment;
    else throw fail("تعذر إثبات سداد الدين السابق لتاريخ البداية المصحح", 409);
  }
  const document: Row = { ...(previous ?? {}), id: previous?.id ?? id("employee-payment"), number: previous?.number ?? `EMP-PAY-${randomUUID()}`,
    kind: "employee-payment", status: "posted", revision: Number(previous?.revision ?? -1) + 1, employeeId: employee.id, employeeName: employee.name,
    employeeAccountOrder: previous?.employeeAccountOrder ?? Math.max(0, ...ledger.documents.map(row => Number(row.employeeAccountOrder ?? 0))) + 1,
    paymentMethod: account.id, total: amount(cents), amount: amount(cents), paidTotal: amount(cents), dueTotal: 0,
    employeePaymentDirection: direction, ...(independent ? { employeePaymentVersion: 2 } : {}), ...(historicalRepayment ? { employeeHistoricalRepayment: historicalRepayment } : {}), ...(openingAnchor ? { employeeOpeningAnchor: openingAnchor } : {}), balanceDelta: (direction === "deposit" ? 1 : -1) * amount(cents),
    businessDate: date, occurredAt: iso(date), allocations: independent ? [] : allocations, note: text(input.note), lines: [], ...(previous ? { updatedAt: now.toISOString() } : { createdAt: now.toISOString() }) };
  if (!openingAnchor) delete document.employeeOpeningAnchor;
  const movement = await postFinancialMovement(db, session, document, direction === "deposit" ? "in" : "out", amount(cents), "employee-payment");
  await db.collection("financialMovements").updateOne({ id: movement!.id }, { $set: { employeeId: employee.id, employeeName: employee.name } });
  await changeBalance(db, employee, (direction === "deposit" ? 1 : -1) * cents, now);
  if (previous) await db.collection("documents").updateOne({ id: document.id }, { $set: document });
  else await db.collection("documents").insertOne(document);
  return document;
}
async function undoPayment(db: SqliteDatabase, session: SqliteSession, employee: Employee, document: Row, why: string, now: Date) {
  const movement = await findActiveFinancialMovement(db, session, { documentId: document.id, type: "employee-payment" });
  if (!movement || money(movement.amount) !== money(document.total) || movement.direction !== (employeePaymentDirection(document) === "deposit" ? "in" : "out")) throw fail("حركة صرف الموظف الأصلية غير متطابقة", 409);
  const account = await db.collection("paymentAccounts").findOne({ id: document.paymentMethod });
  if (!account) throw fail("يجب اختيار وسيلة دفع صالحة", 409);
  assertPaymentAccountBalance(account);
  const reverseId = await reverseFinancialMovement(db, session, movement, why);
  await db.collection("financialMovements").updateOne({ id: reverseId }, { $set: { employeeId: employee.id, employeeName: document.employeeName } });
  await changeBalance(db, employee, -accountSign(document) * money(document.total), now);
  await db.collection("documents").updateOne({ id: document.id }, { $set: { status: "voided" } });
}

/** Explicit profile correction changes entitlement, never the actual cash ledger.
 * Original agreements/accruals remain in audits and canceled source records. */
async function correctEmployeeSchedule(db: SqliteDatabase, employee: Employee, input: Row, asOf: string, now: Date) {
  const startDate = day(input.startDate), prior = agreements(employee).at(-1) ?? employee.agreements.at(-1)!;
  const next = agreementFrom({ amount: input.amount ?? prior.amount, intervalMonths: input.intervalMonths ?? prior.intervalMonths, entitlement: input.entitlement ?? prior.entitlement }, startDate, Number(startDate.slice(-2)));
  if (startDate === employee.startDate && next.amount === prior.amount && next.intervalMonths === prior.intervalMonths && next.entitlement === prior.entitlement) return undefined;
  if (employee.isArchived) throw fail("استأنف العامل قبل تصحيح تاريخ البداية أو اتفاق راتبه", 409);
  const ledger = await state(db, employee), payments = ledger.documents.filter(document => document.kind === "employee-payment");
  for (const period of periods({ ...employee, startDate, agreements: [next] }, asOf)) assertAfterOpening(ledger.documents, period.dueDate);
  if (payments.length) employee.accountStartDate = payments.map(document => day(document.businessDate)).sort()[0];
  let order = Math.max(0, ...ledger.documents.map(document => Number(document.employeeAccountOrder ?? 0)));
  for (const payment of payments) {
    if (payment.employeePaymentVersion === 2) continue;
    // Old allocation-bound cash becomes an independent account movement. Its
    // ID, date, amount, revision and every financial row remain byte-identical.
    const revised = { ...payment, employeePaymentVersion: 2, employeePaymentDirection: "withdraw", allocations: [], employeeAccountOrder: payment.employeeAccountOrder ?? ++order, updatedAt: now.toISOString() };
    await db.collection("documents").updateOne({ id: payment.id, revision: payment.revision }, { $set: revised });
    await audit(db, "employee-payment.schedule-rebase", payment, revised, now);
  }
  const originals = new Map(ledger.accruals.map(document => [String(document.id), document]));
  for (const document of ledger.accruals.filter(document => document.status === "posted")) {
    const revised = { ...document, status: "voided", revision: Number(document.revision) + 1, voidedAt: now.toISOString(), updatedAt: now.toISOString(), employeeScheduleRecomputed: true, voidReason: text(input.reason) || "تصحيح تاريخ البداية أو اتفاق العامل" };
    await db.collection("documents").updateOne({ id: document.id, status: "posted", revision: document.revision }, { $set: revised });
    await changeBalance(db, employee, -money(document.total), now);
    await audit(db, "employee-accrual.schedule-void", document, revised, now);
  }
  employee.startDate = startDate;
  employee.agreements = [...employee.agreements.map(agreement => agreement.canceledAt ? agreement : { ...agreement, canceledAt: now.toISOString() }), next];
  validateSchedule(employee.agreements);
  for (const period of periods(employee, asOf)) {
    const documentId = accrualId(employee.id, period.startDate), original = originals.get(documentId);
    // A manually canceled entitlement remains canceled. A period canceled by
    // this explicit correction may be recalculated under its stable ID.
    if (original?.status === "voided" && original.employeeScheduleRecomputed !== true) continue;
    const cents = money(period.agreement.amount);
    const current = await db.collection("documents").findOne({ id: documentId });
    const document: Row = { ...(current ?? {}), id: documentId, number: original?.number ?? `EMP-${period.startDate}-${documentId.slice("employee-accrual-".length)}`, kind: "employee-accrual", status: "posted", revision: current ? Number(current.revision) + 1 : 0,
      employeeId: employee.id, employeeName: employee.name, periodStart: period.startDate, periodEnd: period.endDate, dueDate: period.dueDate,
      businessDate: period.dueDate, occurredAt: iso(period.dueDate), total: amount(cents), amount: amount(cents), balanceDelta: amount(cents),
      agreementSnapshot: structuredClone(period.agreement), lines: [], createdAt: original?.createdAt ?? now.toISOString(), updatedAt: now.toISOString(), context: "profile-correction", employeeScheduleRecomputed: true };
    delete document.voidedAt; delete document.voidReason;
    if (current) await db.collection("documents").updateOne({ id: documentId }, { $set: document, $unset: { voidedAt: "", voidReason: "" } });
    else await db.collection("documents").insertOne(document);
    await changeBalance(db, employee, cents, now);
    await audit(db, "employee-accrual.schedule-recompute", original ?? null, document, now);
  }
  await state(db, employee);
  return { version: 1, asOf, paymentIds: payments.map(document => String(document.id)), reason: text(input.reason) || "تصحيح بيانات اتفاق العامل" };
}

export async function handlePayrollCommand(db: SqliteDatabase, session: SqliteSession, input: Row, now = new Date()): Promise<string | { created: number; totalAccrued: number; employeeCount: number }> {
  return atomic(db, session, async activeSession => {
    const type = text(input.type), asOf = today(now);
    if (type === "employee-accrual.sync") return accrueDueEmployees(db, activeSession, { asOf, now });
    if (type === "employee.create") {
      const name = text(input.name), startDate = day(input.startDate);
      if (!name || name.length > 120 || text(input.phone).length > 40) throw fail("اسم الموظف مطلوب وبياناته يجب أن تكون صالحة");
      const employee = { id: id("employee"), name, phone: text(input.phone), startDate, balance: 0, revision: 0, isArchived: false,
        agreements: [agreementFrom(input, startDate, Number(startDate.slice(-2)))], createdAt: now.toISOString() } as Employee;
      await db.collection("employees").insertOne(employee);
      await audit(db, type, null, employee, now);
      // Creating the card alone never materializes salary or bank movement.
      if (input.openingBalance !== undefined) {
        if (!input.openingBalance || typeof input.openingBalance !== "object" || Array.isArray(input.openingBalance)) throw fail("بيانات رصيد بداية العامل غير صالحة");
        await saveEmployeeOpening(db, employee, input.openingBalance, now);
      }
      return employee.id;
    }
    if (type === "employee-opening.post") {
      const employee = await employeeById(db, input.employeeId);
      return (await saveEmployeeOpening(db, employee, input, now)).id;
    }
    if (type === "employee-opening.update" || type === "employee-opening.void") {
      const document = await db.collection("documents").findOne({ id: text(input.documentId), kind: "employee-opening", status: "posted" });
      if (!document) throw fail("رصيد بداية العامل غير موجود أو ملغى", 404);
      checkRevision(document, input); const why = reason(input), employee = await employeeById(db, document.employeeId);
      if (type === "employee-opening.update") return (await saveEmployeeOpening(db, employee, input, now, document)).id;
      await state(db, employee);
      await changeBalance(db, employee, -accountSign(document) * money(document.total), now);
      const revised = { ...document, status: "voided", revision: document.revision + 1, updatedAt: now.toISOString(), voidedAt: now.toISOString(), voidReason: why };
      const changed = await db.collection("documents").updateOne({ id: document.id, status: "posted", revision: document.revision }, { $set: revised });
      if (!changed.matchedCount) throw fail("تغير رصيد البداية أثناء العملية؛ حدّث الصفحة وأعد المحاولة", 409);
      await audit(db, type, structuredClone(document), revised, now); await state(db, employee); return document.id;
    }
    if (type.startsWith("employee.")) {
      const employee = await employeeById(db, input.employeeId), before = structuredClone(employee);
      let scheduleRecalculation: Row | undefined;
      checkRevision(employee, input);
      await state(db, employee);
      if (type === "employee.delete") {
        if (!employee.isArchived) throw fail("الحذف النهائي متاح من أرشيف العمال فقط", 409);
        const balance = signedMoney(employee.balance);
        if (balance < 0) throw fail("لا يمكن حذف العامل نهائيًا لأن عليه دينًا للمحل؛ سوِّ حسابه أولًا", 409);
        let closureId: string | null = null;
        if (balance > 0) {
          const ledger = await state(db, employee), summary = payrollSummary([employee], ledger.documents).rows[0];
          const closure = { id: id("employee-closure"), number: `EMP-CLOSE-${randomUUID()}`, kind: "employee-closure", status: "posted", revision: 0,
            employeeId: employee.id, employeeName: employee.name, employeeAccountOrder: Math.max(0, ...ledger.documents.map(document => Number(document.employeeAccountOrder ?? 0))) + 1,
            total: amount(balance), amount: amount(balance), balanceDelta: -amount(balance), salaryReserveReleased: summary.currentUnpaidWages,
            businessDate: asOf, occurredAt: iso(asOf), createdAt: now.toISOString(), lines: [], paymentMethod: null, cashAmount: 0, paidTotal: 0, dueTotal: 0,
            note: text(input.reason) || "إغلاق حساب العامل عند الحذف النهائي من الأرشيف" };
          await db.collection("documents").insertOne(closure); await changeBalance(db, employee, -balance, now); await audit(db, "employee-closure.post", null, closure, now); closureId = closure.id;
        }
        employee.isDeleted = true; employee.deletedAt = now.toISOString(); employee.deletionDocumentId = closureId;
      } else if (type === "employee.archive") {
        if (employee.isArchived) throw fail("الموظف مؤرشف بالفعل", 409);
        await accrueEmployee(db, employee, asOf, now, "archive");
        employee.agreements = employee.agreements.map(row => row.canceledAt ? row : ({ ...row, ...(row.startDate > asOf ? { canceledAt: now.toISOString() } : { stopDate: row.stopDate && row.stopDate < asOf ? row.stopDate : asOf }) }));
        employee.isArchived = true; employee.archivedAt = now.toISOString();
      } else if (type === "employee.restore") {
        if (!employee.isArchived) throw fail("الموظف غير مؤرشف", 409);
        const resumeDate = day(input.resumeDate);
        if (resumeDate < asOf || resumeDate < employee.startDate) throw fail("تاريخ الاستئناف لا يمكن أن يسبق اليوم أو تاريخ بداية العامل");
        const posted = await db.collection("documents").find({ employeeId: employee.id, kind: "employee-accrual", status: "posted" }).toArray();
        if (posted.some(row => row.periodEnd >= resumeDate)) throw fail("تاريخ الاستئناف يتداخل مع فترة راتب معتمدة", 409);
        const previous = agreements(employee).at(-1) ?? employee.agreements.at(-1)!;
        employee.agreements = clipSameDayStop(employee.agreements, previous, resumeDate)
          .map(row => row.startDate === resumeDate && !row.canceledAt ? { ...row, canceledAt: now.toISOString() } : row);
        employee.agreements.push(agreementFrom({ amount: input.amount ?? previous.amount, intervalMonths: input.intervalMonths ?? previous.intervalMonths, entitlement: input.entitlement ?? previous.entitlement }, resumeDate, Number(resumeDate.slice(-2))));
        validateSchedule(employee.agreements);
        employee.isArchived = false; employee.archivedAt = null;
      } else if (type === "employee.update") {
        const name = input.name === undefined ? employee.name : text(input.name), phone = input.phone === undefined ? employee.phone : text(input.phone);
        if (!name || name.length > 120 || phone.length > 40) throw fail("بيانات الموظف غير صالحة");
        employee.name = name; employee.phone = phone;
        if (Object.hasOwn(input, "startDate")) scheduleRecalculation = await correctEmployeeSchedule(db, employee, input, asOf, now);
        else if (["amount", "intervalMonths", "entitlement", "effectiveFrom"].some(key => Object.hasOwn(input, key))) {
          if (employee.isArchived) throw fail("استأنف الموظف قبل تعديل اتفاق راتبه", 409);
          const effective = day(input.effectiveFrom ?? nextPayrollAgreementStart(employee, asOf));
          if (effective <= asOf || effective < employee.startDate) throw fail("تعديل الاتفاق يطبق على فترة مستقبلية تبدأ من تاريخ بداية العامل أو بعده", 409);
          const schedule = agreements(employee), previous = schedule.filter(row => row.startDate < effective).at(-1) ?? schedule[0];
          const agreement = agreementFrom({ amount: input.amount ?? previous.amount, intervalMonths: input.intervalMonths ?? previous.intervalMonths, entitlement: input.entitlement ?? previous.entitlement }, effective, previous.anchorDay);
          const rest = employee.agreements.filter(row => row.startDate !== effective);
          employee.agreements = [...rest, agreement].sort((a, b) => a.startDate.localeCompare(b.startDate));
          validateSchedule(employee.agreements);
          if (await db.collection("documents").findOne({ employeeId: employee.id, kind: "employee-accrual", periodStart: { $gte: effective } })) throw fail("الاتفاق يتداخل مع استحقاق مسجل", 409);
        }
      } else throw fail("عملية الموظفين غير مدعومة");
      employee.revision++; employee.updatedAt = now.toISOString();
      const changed = await db.collection("employees").updateOne({ id: employee.id, revision: before.revision }, { $set: employee });
      if (!changed.matchedCount) throw fail("تغير الموظف أثناء العملية", 409);
      await audit(db, type, before, employee, now);
      if (scheduleRecalculation) await audit(db, "employee.schedule-correction", before, { ...employee, scheduleRecalculation }, now);
      return employee.id;
    }
    if (type === "employee-payment.post") {
      const employee = await employeeById(db, input.employeeId);
      const document = await postPayment(db, activeSession, employee, input, now);
      await audit(db, type, null, document, now);
      return document.id;
    }
    if (["employee-payment.update", "employee-payment.void", "employee-accrual.update", "employee-accrual.void"].includes(type)) {
      const kind = type.startsWith("employee-payment") ? "employee-payment" : "employee-accrual";
      const document = await db.collection("documents").findOne({ id: text(input.documentId), kind, status: "posted" });
      if (!document) throw fail("سند الموظف غير موجود أو ملغى", 404);
      checkRevision(document, input); const why = reason(input), before = structuredClone(document);
      const employee = await employeeById(db, document.employeeId), ledger = await state(db, employee);
      if (kind === "employee-payment") {
        const originalAccount = type.endsWith("update") ? await db.collection("paymentAccounts").findOne({ id: document.paymentMethod }) : null;
        await undoPayment(db, activeSession, employee, document, why, now);
        if (type.endsWith("update")) {
          const revised = await postPayment(db, activeSession, employee, { ...input, occurredAt: input.occurredAt ?? document.businessDate, paymentMethod: input.paymentMethod ?? document.paymentMethod, note: input.note ?? document.note }, now, document);
          if (originalAccount?.isArchived === true && revised.paymentMethod === originalAccount.id) {
            await db.collection("paymentAccounts").updateOne({ id: originalAccount.id, balance: 0 }, {
              $set: { isArchived: true, isActive: originalAccount.isActive, archivedAt: originalAccount.archivedAt, updatedAt: originalAccount.updatedAt },
            });
          }
          await audit(db, type, before, { ...revised, reason: why }, now);
          return document.id;
        }
      } else {
        const allocated = ledger.allocated.get(document.id) ?? 0;
        if (type.endsWith("void") && allocated) {
          const blockers = ledger.documents.filter(row => row.kind === "employee-payment" && row.status === "posted" && row.allocations.some((allocation: Row) => allocation.accrualId === document.id));
          throw new PayrollError(`الاستحقاق مرتبط بدفعات ${blockers.map(row => String(row.number)).join("، ")}. عالج الدفعات المرتبطة أولًا`, 409, blockers.map(row => ({ documentId: row.id, number: row.number })));
        }
        const revisedAmount = type.endsWith("void") ? 0 : money(input.amount), date = input.occurredAt === undefined ? document.businessDate : day(input.occurredAt);
        if (type.endsWith("update")) assertAfterOpening(ledger.documents, date);
        if (revisedAmount < allocated) throw fail("الاستحقاق المعدل لا يمكن أن يقل عن المبلغ المصروف منه", 409);
        const recordedEarlyDate = date === document.businessDate && document.agreementSnapshot?.startDate < employee.startDate;
        if ((date < employee.startDate && !recordedEarlyDate) || date > asOf) throw fail("تاريخ الاستحقاق يجب أن يكون بين بداية الموظف واليوم");
        if (ledger.documents.some(row => row.kind === "employee-payment" && row.status === "posted" && row.allocations.some((allocation: Row) => allocation.accrualId === document.id) && row.businessDate < date)) throw fail("تاريخ الاستحقاق المعدل يتجاوز تاريخ دفعة مرتبطة", 409);
        await changeBalance(db, employee, revisedAmount - money(document.total), now);
        if (type.endsWith("update")) {
          const revised = { ...document, total: amount(revisedAmount), amount: amount(revisedAmount), balanceDelta: amount(revisedAmount), dueDate: date, businessDate: date, occurredAt: iso(date), revision: document.revision + 1, updatedAt: now.toISOString(), correctionReason: why };
          await db.collection("documents").updateOne({ id: document.id }, { $set: revised });
          await audit(db, type, before, revised, now); return document.id;
        }
      }
      const revised = { ...document, status: "voided", revision: document.revision + 1, updatedAt: now.toISOString(), voidedAt: now.toISOString(), voidReason: why, ...(kind === "employee-accrual" ? { employeeScheduleRecomputed: false } : {}) };
      await db.collection("documents").updateOne({ id: document.id }, { $set: revised });
      await audit(db, type, before, revised, now); return document.id;
    }
    throw fail("عملية الموظفين غير مدعومة");
  });
}

/** Match actual net drawings to earned salary. Deposits and advances alone are not income or expense. */
export function payrollExpenseEntries(documents: Row[]) {
  const states = new Map<string, { earned: number; drawn: number; recognized: number }>();
  const entries: Array<{ documentId: string; employeeId: string; employeeName: string; businessDate: string; occurredAt: string; total: number }> = [];
  const ordered = documents.filter(row => row.status === "posted" && ["employee-opening", "employee-accrual", "employee-payment"].includes(row.kind))
    .slice().sort((a, b) => String(a.businessDate).localeCompare(String(b.businessDate)) ||
      (a.kind === b.kind ? 0 : a.kind === "employee-opening" ? -1 : b.kind === "employee-opening" ? 1 : 0) ||
      (a.kind === b.kind ? 0 : a.kind === "employee-accrual" ? -1 : 1) ||
      Number(a.employeeAccountOrder ?? 0) - Number(b.employeeAccountOrder ?? 0) ||
      String(a.createdAt ?? a.occurredAt).localeCompare(String(b.createdAt ?? b.occurredAt)));
  for (const document of ordered) {
    const state = states.get(document.employeeId) ?? { earned: 0, drawn: 0, recognized: 0 }, cents = money(document.total);
    if (document.kind === "employee-opening") {
      state.drawn -= accountSign(document) * cents;
      if (!Number.isSafeInteger(state.drawn)) throw fail("مجموع حركات العامل يتجاوز النطاق المسموح");
      states.set(document.employeeId, state); continue;
    }
    if (document.kind === "employee-accrual") state.earned += cents;
    else state.drawn += employeePaymentDirection(document) === "deposit" ? -cents : cents;
    if (!Number.isSafeInteger(state.earned) || !Number.isSafeInteger(state.drawn)) throw fail("مجموع حركات العامل يتجاوز النطاق المسموح");
    const recognized = Math.min(Math.max(state.drawn, 0), state.earned), delta = recognized - state.recognized;
    if (delta) entries.push({ documentId: document.id, employeeId: document.employeeId, employeeName: document.employeeName,
      businessDate: document.businessDate, occurredAt: document.occurredAt, total: amount(delta) });
    state.recognized = recognized;
    states.set(document.employeeId, state);
  }
  return entries;
}

export function payrollSummary(employees: Row[], documents: Row[], period: { from?: string; to?: string } = {}) {
  const from = period.from ? day(period.from) : "", to = period.to ? day(period.to) : "";
  if (from && to && from > to) throw fail("بداية الفترة تتجاوز نهايتها");
  const rows = employees.map(employee => ({ employeeId: String(employee.id), name: String(employee.name), currentOwed: 0, currentReceivable: 0, currentUnpaidWages: 0, closingBalance: 0, accrualPeriod: 0, paidPeriod: 0, reserveChange: 0 }));
  const byId = new Map(rows.map(row => [row.employeeId, row]));
  const released = new Map<string, number>();
  for (const document of documents) {
    if (document.status !== "posted" || !["employee-accrual", "employee-payment", "employee-closure", "employee-opening"].includes(document.kind)) continue;
    const row = byId.get(String(document.employeeId));
    if (!row) continue;
    const date = String(document.businessDate ?? document.occurredAt?.slice(0, 10)), cents = money(document.total), sign = accountSign(document);
    row.currentOwed += sign * cents;
    if (document.kind === "employee-accrual") row.currentUnpaidWages += cents;
    if (document.kind === "employee-closure") row.currentUnpaidWages -= money(document.salaryReserveReleased, true);
    if (!to || date <= to) row.closingBalance += sign * cents;
    if ((!from || date >= from) && (!to || date <= to)) {
      if (document.kind === "employee-accrual") row.accrualPeriod += cents;
      if (document.kind === "employee-closure") released.set(row.employeeId, (released.get(row.employeeId) ?? 0) + money(document.salaryReserveReleased, true));
    }
  }
  for (const entry of payrollExpenseEntries(documents)) {
    const row = byId.get(entry.employeeId);
    if (!row) continue;
    row.currentUnpaidWages -= signedMoney(entry.total);
    if ((!from || entry.businessDate >= from) && (!to || entry.businessDate <= to)) {
      row.paidPeriod += signedMoney(entry.total);
    }
  }
  const totals = { currentOwed: 0, currentReceivable: 0, currentUnpaidWages: 0, closingBalance: 0, accrualPeriod: 0, paidPeriod: 0, reserveChange: 0 };
  for (const row of rows) {
    row.currentReceivable = Math.max(-row.currentOwed, 0);
    row.currentOwed = Math.max(row.currentOwed, 0);
    row.reserveChange = row.accrualPeriod - row.paidPeriod - (released.get(row.employeeId) ?? 0);
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) { totals[key] += row[key]; row[key] = amount(row[key]); }
  }
  return { ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, amount(value)])) as typeof totals, rows };
}

/** Restore validates the whole employee ledger before replacing the current dataset. */
export function validatePayrollSnapshot(employees: Row[], documents: Row[], financialMovements: Row[], events: Row[] = []) {
  const employeeMap = new Map<string, Row>(), agreementMaps = new Map<string, Map<string, Agreement>>();
  const verifiedEarlyAgreements = new Set<string>();
  const invalid = () => fail("بيانات الموظفين أو روابط استحقاقاتهم ودفعاتهم غير صالحة");
  const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value;
  const validRevision = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const validAgreement = (row: Agreement) => {
    if (!row || !validId(row.id) || typeof row.amount !== "number" || !validRevision(row.anchorDay) || row.anchorDay < 1 || row.anchorDay > 31 ||
        typeof row.intervalMonths !== "number" || interval(row.intervalMonths) !== row.intervalMonths) throw invalid();
    money(row.amount, true); day(row.startDate); timing(row.entitlement);
    if (row.stopDate !== undefined && day(row.stopDate) < row.startDate) throw invalid();
    if (row.canceledAt !== undefined && (typeof row.canceledAt !== "string" || !Number.isFinite(Date.parse(row.canceledAt)))) throw invalid();
  };
  for (const employee of employees) {
    if (!validId(employee.id) || employeeMap.has(employee.id) || typeof employee.name !== "string" || !employee.name.trim() || employee.name.length > 120 ||
        typeof employee.balance !== "number" || !validRevision(employee.revision) || typeof employee.isArchived !== "boolean" ||
        (employee.phone !== undefined && (typeof employee.phone !== "string" || employee.phone.length > 40)) || !Array.isArray(employee.agreements) || !employee.agreements.length) throw invalid();
    signedMoney(employee.balance); day(employee.startDate);
    if (employee.accountStartDate !== undefined) day(employee.accountStartDate);
    if (employee.isDeleted !== undefined && typeof employee.isDeleted !== "boolean") throw invalid();
    if (employee.isDeleted === true && (employee.isArchived !== true || employee.balance !== 0 || typeof employee.deletedAt !== "string" || !Number.isFinite(Date.parse(employee.deletedAt)))) throw invalid();
    const map = new Map<string, Agreement>();
    for (const agreement of employee.agreements) {
      validAgreement(agreement);
      if (map.has(agreement.id)) throw invalid();
      if (agreement.startDate < employee.startDate) {
        if (!agreement.canceledAt || (!legacyEarlyAgreement(employee as Employee, agreement, events) && !correctedHistoricalAgreement(employee as Employee, agreement, events))) throw invalid();
        verifiedEarlyAgreements.add(JSON.stringify([employee.id, agreement.id]));
      }
      map.set(agreement.id, agreement);
    }
    if (!employee.isArchived && !employee.agreements.some((row: Agreement) => !row.canceledAt)) throw invalid();
    validateSchedule(employee.agreements);
    employeeMap.set(employee.id, employee); agreementMaps.set(employee.id, map);
  }
  const payroll = documents.filter(row => ["employee-accrual", "employee-payment", "employee-closure", "employee-opening"].includes(row.kind));
  const documentMap = new Map<string, Row>(), accruals = new Map<string, Row>(), allocations = new Map<string, number>(), balances = new Map<string, number>();
  const movementOrders = new Set<string>();
  for (const document of payroll) {
    if (!validId(document.id) || documentMap.has(document.id) || !employeeMap.has(document.employeeId) || !validRevision(document.revision) ||
        !["posted", "voided"].includes(document.status) || typeof document.total !== "number" || document.amount !== document.total || !validId(document.number) ||
        !Array.isArray(document.lines) || document.lines.length !== 0) throw invalid();
    const date = day(document.businessDate), cents = money(document.total);
    if (document.employeeAccountOrder !== undefined && (!Number.isSafeInteger(document.employeeAccountOrder) || document.employeeAccountOrder < 1)) throw invalid();
    if (document.employeeAccountOrder !== undefined) {
      const key = JSON.stringify([document.employeeId, document.employeeAccountOrder]);
      if (movementOrders.has(key)) throw invalid();
      movementOrders.add(key);
    }
    const legacyEarlyAccrual = document.kind === "employee-accrual" && verifiedEarlyAgreements.has(JSON.stringify([document.employeeId, document.agreementSnapshot?.id]));
    const historicalPayment = document.kind === "employee-payment" && (correctedHistoricalPayment(employeeMap.get(document.employeeId)! as Employee, document, events) || verifiedHistoricalRepayment(employeeMap.get(document.employeeId)! as Employee, document, events) || verifiedOpeningPayment(employeeMap.get(document.employeeId)! as Employee, document, events));
    if (typeof document.occurredAt !== "string" || !Number.isFinite(Date.parse(document.occurredAt)) || document.occurredAt.slice(0, 10) !== date ||
        (date < employeeMap.get(document.employeeId)!.startDate && !legacyEarlyAccrual && !historicalPayment && !["employee-closure", "employee-opening"].includes(document.kind))) throw invalid();
    const sign = accountSign(document);
    if (document.balanceDelta !== amount(sign * cents)) throw invalid();
    if (document.status === "posted") balances.set(document.employeeId, (balances.get(document.employeeId) ?? 0) + sign * cents);
    documentMap.set(document.id, document);
    if (document.kind === "employee-opening") {
      if (document.paymentMethod != null || document.cashAmount !== 0 || document.paidTotal !== 0 || document.dueTotal !== 0 || typeof document.note !== "string" || document.note.length > 1000 ||
          financialMovements.some(movement => movement.documentId === document.id)) throw invalid();
      const proof = events.some(event => event.status === "committed" && event.employeeId === document.employeeId &&
        ["payroll.employee-opening.post", "payroll.employee-opening.update", "payroll.employee-opening.void"].includes(event.action) &&
        event.after?.id === document.id && event.after.kind === "employee-opening" && event.after.status === document.status && event.after.revision === document.revision &&
        event.after.businessDate === date && event.after.total === document.total && event.after.balanceDelta === document.balanceDelta && event.after.employeeOpeningDirection === document.employeeOpeningDirection);
      if (!proof) throw invalid();
    }
    if (document.kind === "employee-accrual") {
      const start = day(document.periodStart), end = day(document.periodEnd), snapshot = document.agreementSnapshot as Agreement;
      validAgreement(snapshot);
      const saved = agreementMaps.get(document.employeeId)!.get(snapshot.id);
      if (!saved || ["startDate", "amount", "intervalMonths", "entitlement", "anchorDay"].some(key => saved[key as keyof Agreement] !== snapshot[key as keyof Agreement]) ||
          start < snapshot.startDate || end !== priorDay(boundary(start, snapshot.intervalMonths, snapshot.anchorDay)) || document.dueDate !== date ||
          document.id !== accrualId(document.employeeId, start)) throw invalid();
      const months = monthsBetween(snapshot.startDate, start);
      if (months < 0 || months % snapshot.intervalMonths !== 0 || boundary(snapshot.startDate, months, snapshot.anchorDay) !== start) throw invalid();
      accruals.set(document.id, document);
    }
    if (document.kind === "employee-closure") {
      const employee = employeeMap.get(document.employeeId)!;
      if (document.status !== "posted" || document.revision !== 0 || employee.isDeleted !== true || employee.deletionDocumentId !== document.id ||
          document.paymentMethod != null || document.cashAmount !== 0 || document.paidTotal !== 0 || document.dueTotal !== 0 || money(document.salaryReserveReleased, true) > cents) throw invalid();
    }
  }
  for (const employee of employees) {
    if ((balances.get(employee.id) ?? 0) !== signedMoney(employee.balance)) throw invalid();
    const opening = payroll.filter(document => document.employeeId === employee.id && document.kind === "employee-opening" && document.status === "posted");
    if (opening.length > 1 || (opening.length && payroll.some(document => document.employeeId === employee.id && document.kind !== "employee-opening" && document.businessDate < opening[0].businessDate))) throw invalid();
    if (opening.length && periods(employee as Employee, opening[0].businessDate).some(period => period.dueDate < opening[0].businessDate)) throw invalid();
    const closures = payroll.filter(document => document.employeeId === employee.id && document.kind === "employee-closure");
    if (closures.length > 1 || (employee.deletionDocumentId != null && !closures.some(document => document.id === employee.deletionDocumentId))) throw invalid();
    if (closures.length) {
      const summary = payrollSummary([employee], payroll.filter(document => document.kind !== "employee-closure")).rows[0];
      if (closures[0].total !== summary.currentOwed || closures[0].salaryReserveReleased !== summary.currentUnpaidWages) throw invalid();
      const proof = events.find(event => event.action === "payroll.employee.delete" && event.status === "committed" && event.employeeId === employee.id && event.before?.id === employee.id && event.before.isArchived === true && event.before.balance === closures[0].total && event.after?.isDeleted === true && event.after.balance === 0 && event.after.deletionDocumentId === closures[0].id);
      if (!proof) throw invalid();
    }
    if (employee.isDeleted === true && !closures.length && !events.some(event => event.action === "payroll.employee.delete" && event.status === "committed" && event.employeeId === employee.id &&
        event.before?.id === employee.id && event.before.isArchived === true && event.before.balance === 0 && event.after?.id === employee.id && event.after.isDeleted === true && event.after.balance === 0 && event.after.deletionDocumentId === null)) throw invalid();
    let previousEnd = "";
    for (const row of [...accruals.values()].filter(item => item.employeeId === employee.id && item.status === "posted").sort((a, b) => a.periodStart.localeCompare(b.periodStart))) {
      if (previousEnd && row.periodStart <= previousEnd) throw invalid();
      previousEnd = row.periodEnd;
    }
  }
  for (const payment of payroll.filter(row => row.kind === "employee-payment")) {
    if (!validId(payment.paymentMethod) || !Array.isArray(payment.allocations)) throw invalid();
    if (payment.employeeOpeningAnchor !== undefined) {
      const source = documentMap.get(text(payment.employeeOpeningAnchor?.openingDocumentId));
      if (!source || source.kind !== "employee-opening" || source.employeeId !== payment.employeeId || !verifiedOpeningPayment(employeeMap.get(payment.employeeId)! as Employee, payment, events)) throw invalid();
    }
    if (payment.employeePaymentVersion === 2) {
      if (payment.allocations.length || payment.employeeAccountOrder === undefined || !["withdraw", "deposit"].includes(payment.employeePaymentDirection)) throw invalid();
      continue;
    }
    if (payment.employeePaymentVersion !== undefined || employeePaymentDirection(payment) !== "withdraw" || !payment.allocations.length) throw invalid();
    let total = 0; const seen = new Set<string>();
    for (const allocation of payment.allocations) {
      const source = accruals.get(allocation.accrualId);
      if (!source || source.employeeId !== payment.employeeId || seen.has(source.id) || typeof allocation.amount !== "number") throw invalid();
      const cents = money(allocation.amount); total += cents; seen.add(source.id);
      if (payment.status === "posted") {
        if (source.status !== "posted" || source.dueDate > payment.businessDate) throw invalid();
        const allocated = (allocations.get(source.id) ?? 0) + cents;
        if (allocated > money(source.total)) throw invalid();
        allocations.set(source.id, allocated);
      }
    }
    if (total !== money(payment.total)) throw invalid();
  }
  const movementMap = new Map<string, Row>(), active = new Map<string, number>();
  for (const movement of financialMovements) {
    if (movement.employeeId && !employeeMap.has(movement.employeeId)) throw invalid();
    if (!String(movement.type).startsWith("employee-payment")) continue;
    if (!validId(movement.id) || movementMap.has(movement.id) || !employeeMap.has(movement.employeeId) || !documentMap.has(movement.documentId) ||
        documentMap.get(movement.documentId)!.kind !== "employee-payment" || documentMap.get(movement.documentId)!.employeeId !== movement.employeeId ||
        !["posted", "reversed"].includes(movement.status) || typeof movement.amount !== "number") throw invalid();
    money(movement.amount); movementMap.set(movement.id, movement);
    if (movement.status !== "reversed" && movement.isReversal !== true) {
      const payment = documentMap.get(movement.documentId)!;
      if (movement.type !== "employee-payment" || payment.status !== "posted" || movement.direction !== (employeePaymentDirection(payment) === "deposit" ? "in" : "out") || movement.amount !== payment.total ||
          movement.paymentMethod !== payment.paymentMethod || movement.occurredAt !== payment.occurredAt || movement.revision !== payment.revision) throw invalid();
      active.set(payment.id, (active.get(payment.id) ?? 0) + 1);
    }
  }
  for (const payment of payroll.filter(row => row.kind === "employee-payment")) {
    if ((active.get(payment.id) ?? 0) !== (payment.status === "posted" ? 1 : 0)) throw invalid();
  }
  for (const movement of movementMap.values()) {
    if (movement.isReversal === true) {
      const original = movementMap.get(movement.reversalOfMovementId);
      if (!original || original.status !== "reversed" || original.reversalMovementId !== movement.id || original.documentId !== movement.documentId ||
          original.paymentMethod !== movement.paymentMethod || original.amount !== movement.amount || movement.direction !== (original.direction === "out" ? "in" : "out")) throw invalid();
    } else if (movement.status === "reversed") {
      const reversal = movementMap.get(movement.reversalMovementId);
      if (!reversal || reversal.isReversal !== true || reversal.reversalOfMovementId !== movement.id) throw invalid();
    }
  }
}
