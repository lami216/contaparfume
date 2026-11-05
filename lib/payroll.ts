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
function money(value: unknown, allowZero = false) {
  if ((typeof value !== "number" && typeof value !== "string") || text(String(value)) === "" ||
      (typeof value === "string" && !/^\d+(?:\.\d{1,2})?$/.test(value.trim()))) throw fail("المبلغ يجب أن يكون رقمًا صالحًا بخانتين عشريتين على الأكثر");
  const number = Number(value), cents = Math.round(number * 100);
  if (!Number.isFinite(number) || !Number.isSafeInteger(cents) || (allowZero ? cents < 0 : cents <= 0) || Math.abs(number * 100 - cents) > 1e-7) throw fail("المبلغ يجب أن يكون رقمًا موجبًا صالحًا");
  return cents;
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
function priorDay(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
const agreements = (employee: Employee) => employee.agreements.filter(row => !row.canceledAt).slice().sort((a, b) => a.startDate.localeCompare(b.startDate));
function periods(employee: Employee, asOf: string) {
  const result: Period[] = [], schedule = agreements(employee);
  for (const [index, agreement] of schedule.entries()) {
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
  return employee;
}
async function changeBalance(db: SqliteDatabase, employee: Employee, delta: number, now: Date) {
  const before = money(employee.balance, true), after = before + delta;
  if (!Number.isSafeInteger(after) || after < 0) throw fail("المبلغ يتجاوز مستحق الموظف", 409);
  const changed = await db.collection("employees").updateOne({ id: employee.id, balance: employee.balance }, { $set: { balance: amount(after), updatedAt: now.toISOString() } });
  if (!changed.matchedCount) throw fail("تغير رصيد الموظف. حدّث الصفحة وأعد المحاولة", 409);
  employee.balance = amount(after);
}
async function state(db: SqliteDatabase, employee: Employee) {
  const documents = await db.collection("documents").find({ employeeId: employee.id, kind: { $in: ["employee-accrual", "employee-payment"] } }).toArray();
  const accruals = documents.filter(row => row.kind === "employee-accrual"), allocated = new Map<string, number>();
  for (const payment of documents.filter(row => row.kind === "employee-payment" && row.status === "posted")) {
    if (!Array.isArray(payment.allocations)) throw fail("روابط دفعة الموظف غير صالحة", 409);
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
    balance += remaining;
  }
  if (balance !== money(employee.balance, true)) throw fail("رصيد الموظف لا يطابق سجل استحقاقاته ودفعاته", 409);
  return { documents, accruals, allocated };
}
async function accrueEmployee(db: SqliteDatabase, employee: Employee, asOf: string, now: Date, context: string) {
  const saved = await state(db, employee), byId = new Map(saved.accruals.map(row => [row.id, row]));
  let created = 0, totalAccrued = 0;
  for (const period of periods(employee, asOf)) {
    const documentId = accrualId(employee.id, period.startDate), existing = byId.get(documentId);
    if (existing) continue;
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
    const employees = await db.collection("employees").find({ isArchived: { $ne: true } }).toArray() as Employee[];
    let created = 0, totalAccrued = 0;
    for (const employee of employees) {
      const result = await accrueEmployee(db, employee, asOf, now, options.context ?? "automatic");
      created += result.created; totalAccrued += result.totalAccrued;
    }
    return { created, totalAccrued: amount(totalAccrued), employeeCount: employees.length };
  });
}

function agreementFrom(input: Row, startDate: string, anchorDay: number): Agreement {
  return { id: id("agreement"), startDate, amount: amount(money(input.amount)), intervalMonths: interval(input.intervalMonths), entitlement: timing(input.entitlement), anchorDay };
}
function validateSchedule(schedule: Agreement[]) {
  const active = schedule.filter(row => !row.canceledAt).sort((a, b) => a.startDate.localeCompare(b.startDate));
  for (let index = 1; index < active.length; index++) {
    const previous = active[index - 1], current = active[index];
    if (previous.stopDate && previous.stopDate < current.startDate) continue;
    let at = previous.startDate;
    while (at < current.startDate) at = boundary(at, previous.intervalMonths, previous.anchorDay);
    if (at !== current.startDate || previous.startDate === current.startDate) throw fail("الاتفاق الجديد يجب أن يبدأ عند بداية فترة راتب تالية دون تداخل", 409);
  }
}
async function paymentDate(input: Row, employee: Employee, now: Date) {
  const date = day(input.occurredAt ?? today(now));
  if (date < employee.startDate || date > today(now)) throw fail("تاريخ الدفع يجب أن يكون بين بداية عمل الموظف واليوم");
  return date;
}
async function postPayment(db: SqliteDatabase, session: SqliteSession, employee: Employee, input: Row, now: Date, previous?: Row) {
  const cents = money(input.amount), date = await paymentDate(input, employee, now), ledger = await state(db, employee);
  const account = await db.collection("paymentAccounts").findOne({ $or: [{ id: text(input.paymentMethod) }, { code: text(input.paymentMethod) }], isActive: true, isArchived: { $ne: true } });
  // Other commerce may leave sub-cent cash. Salary amounts are cents, but the
  // existing bank balance must retain its precision rather than be rounded.
  const balance = typeof account?.balance === "number" ? account.balance : typeof account?.balance === "string" && /^\d+(?:\.\d+)?$/.test(account.balance.trim()) ? Number(account.balance) : NaN;
  const required = amount(cents), tolerance = Math.min(1e-7, Number.EPSILON * Math.max(1, Math.abs(balance), required));
  if (!account || !Number.isFinite(balance) || balance < 0 || balance + tolerance < required) throw fail("اختر حسابًا نشطًا برصيد يكفي مبلغ الصرف", 409);
  const allocations: Array<{ accrualId: string; amount: number }> = [];
  let remaining = cents;
  for (const accrual of ledger.accruals.filter(row => row.status === "posted" && row.dueDate <= date).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)) || String(a.periodStart).localeCompare(String(b.periodStart)))) {
    const available = money(accrual.total) - (ledger.allocated.get(accrual.id) ?? 0), paid = Math.min(remaining, available);
    if (paid > 0) allocations.push({ accrualId: accrual.id, amount: amount(paid) });
    remaining -= paid;
    if (!remaining) break;
  }
  if (remaining) throw fail("المبلغ يتجاوز المستحق للموظف في تاريخ الدفع", 409);
  const document = { ...(previous ?? {}), id: previous?.id ?? id("employee-payment"), number: previous?.number ?? `EMP-PAY-${randomUUID()}`,
    kind: "employee-payment", status: "posted", revision: Number(previous?.revision ?? -1) + 1, employeeId: employee.id, employeeName: employee.name,
    paymentMethod: account.id, total: amount(cents), amount: amount(cents), paidTotal: amount(cents), dueTotal: 0, balanceDelta: -amount(cents),
    businessDate: date, occurredAt: iso(date), allocations, note: text(input.note), lines: [], ...(previous ? { updatedAt: now.toISOString() } : { createdAt: now.toISOString() }) };
  const movement = await postFinancialMovement(db, session, document, "out", amount(cents), "employee-payment");
  await db.collection("financialMovements").updateOne({ id: movement!.id }, { $set: { employeeId: employee.id, employeeName: employee.name } });
  await changeBalance(db, employee, -cents, now);
  if (previous) await db.collection("documents").updateOne({ id: document.id }, { $set: document });
  else await db.collection("documents").insertOne(document);
  return document;
}
async function undoPayment(db: SqliteDatabase, session: SqliteSession, employee: Employee, document: Row, why: string, now: Date) {
  const movement = await findActiveFinancialMovement(db, session, { documentId: document.id, type: "employee-payment" });
  if (!movement || money(movement.amount) !== money(document.total)) throw fail("حركة صرف الموظف الأصلية غير متطابقة", 409);
  const reverseId = await reverseFinancialMovement(db, session, movement, why);
  await db.collection("financialMovements").updateOne({ id: reverseId }, { $set: { employeeId: employee.id, employeeName: document.employeeName } });
  await changeBalance(db, employee, money(document.total), now);
  await db.collection("documents").updateOne({ id: document.id }, { $set: { status: "voided" } });
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
      return employee.id;
    }
    if (type.startsWith("employee.")) {
      const employee = await employeeById(db, input.employeeId), before = structuredClone(employee);
      checkRevision(employee, input);
      await state(db, employee);
      if (type === "employee.archive") {
        if (employee.isArchived) throw fail("الموظف مؤرشف بالفعل", 409);
        await accrueEmployee(db, employee, asOf, now, "archive");
        employee.agreements = employee.agreements.map(row => ({ ...row, ...(row.startDate > asOf ? { canceledAt: now.toISOString() } : { stopDate: row.stopDate && row.stopDate < asOf ? row.stopDate : asOf }) }));
        employee.isArchived = true; employee.archivedAt = now.toISOString();
      } else if (type === "employee.restore") {
        if (!employee.isArchived) throw fail("الموظف غير مؤرشف", 409);
        const resumeDate = day(input.resumeDate);
        if (resumeDate < asOf) throw fail("استئناف الموظف يبدأ من اليوم أو تاريخ لاحق");
        const posted = await db.collection("documents").find({ employeeId: employee.id, kind: "employee-accrual", status: "posted" }).toArray();
        if (posted.some(row => row.periodEnd >= resumeDate)) throw fail("تاريخ الاستئناف يتداخل مع فترة راتب معتمدة", 409);
        const previous = agreements(employee).at(-1) ?? employee.agreements.at(-1)!;
        employee.agreements = employee.agreements.map(row => row.startDate === resumeDate ? { ...row, canceledAt: now.toISOString() } : row);
        employee.agreements.push(agreementFrom({ amount: input.amount ?? previous.amount, intervalMonths: input.intervalMonths ?? previous.intervalMonths, entitlement: input.entitlement ?? previous.entitlement }, resumeDate, Number(resumeDate.slice(-2))));
        employee.isArchived = false; employee.archivedAt = null;
      } else if (type === "employee.update") {
        const name = input.name === undefined ? employee.name : text(input.name), phone = input.phone === undefined ? employee.phone : text(input.phone);
        if (!name || name.length > 120 || phone.length > 40) throw fail("بيانات الموظف غير صالحة");
        employee.name = name; employee.phone = phone;
        if (["amount", "intervalMonths", "entitlement", "effectiveFrom"].some(key => Object.hasOwn(input, key))) {
          if (employee.isArchived) throw fail("استأنف الموظف قبل تعديل اتفاق راتبه", 409);
          const effective = day(input.effectiveFrom ?? nextPayrollAgreementStart(employee, asOf));
          if (effective <= asOf) throw fail("تعديل الاتفاق يطبق على فترة مستقبلية فقط", 409);
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
        await undoPayment(db, activeSession, employee, document, why, now);
        if (type.endsWith("update")) {
          const revised = await postPayment(db, activeSession, employee, { ...input, occurredAt: input.occurredAt ?? document.businessDate, paymentMethod: input.paymentMethod ?? document.paymentMethod, note: input.note ?? document.note }, now, document);
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
        if (revisedAmount < allocated) throw fail("الاستحقاق المعدل لا يمكن أن يقل عن المبلغ المصروف منه", 409);
        if (date < employee.startDate || date > asOf) throw fail("تاريخ الاستحقاق يجب أن يكون بين بداية الموظف واليوم");
        if (ledger.documents.some(row => row.kind === "employee-payment" && row.status === "posted" && row.allocations.some((allocation: Row) => allocation.accrualId === document.id) && row.businessDate < date)) throw fail("تاريخ الاستحقاق المعدل يتجاوز تاريخ دفعة مرتبطة", 409);
        await changeBalance(db, employee, revisedAmount - money(document.total), now);
        if (type.endsWith("update")) {
          const revised = { ...document, total: amount(revisedAmount), amount: amount(revisedAmount), balanceDelta: amount(revisedAmount), dueDate: date, businessDate: date, occurredAt: iso(date), revision: document.revision + 1, updatedAt: now.toISOString(), correctionReason: why };
          await db.collection("documents").updateOne({ id: document.id }, { $set: revised });
          await audit(db, type, before, revised, now); return document.id;
        }
      }
      const revised = { ...document, status: "voided", revision: document.revision + 1, updatedAt: now.toISOString(), voidedAt: now.toISOString(), voidReason: why };
      await db.collection("documents").updateOne({ id: document.id }, { $set: revised });
      await audit(db, type, before, revised, now); return document.id;
    }
    throw fail("عملية الموظفين غير مدعومة");
  });
}

export function payrollSummary(employees: Row[], documents: Row[], period: { from?: string; to?: string } = {}) {
  const from = period.from ? day(period.from) : "", to = period.to ? day(period.to) : "";
  if (from && to && from > to) throw fail("بداية الفترة تتجاوز نهايتها");
  const rows = employees.map(employee => ({ employeeId: String(employee.id), name: String(employee.name), currentOwed: 0, closingBalance: 0, accrualPeriod: 0, paidPeriod: 0, reserveChange: 0 }));
  const byId = new Map(rows.map(row => [row.employeeId, row]));
  for (const document of documents) {
    if (document.status !== "posted" || !["employee-accrual", "employee-payment"].includes(document.kind)) continue;
    const row = byId.get(String(document.employeeId));
    if (!row) continue;
    const date = String(document.businessDate ?? document.occurredAt?.slice(0, 10)), cents = money(document.total), sign = document.kind === "employee-accrual" ? 1 : -1;
    row.currentOwed += sign * cents;
    if (!to || date <= to) row.closingBalance += sign * cents;
    if ((!from || date >= from) && (!to || date <= to)) {
      if (sign > 0) row.accrualPeriod += cents;
      else row.paidPeriod += cents;
    }
  }
  const totals = { currentOwed: 0, closingBalance: 0, accrualPeriod: 0, paidPeriod: 0, reserveChange: 0 };
  for (const row of rows) {
    row.reserveChange = row.accrualPeriod - row.paidPeriod;
    for (const key of Object.keys(totals) as Array<keyof typeof totals>) { totals[key] += row[key]; row[key] = amount(row[key]); }
  }
  return { ...Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, amount(value)])) as typeof totals, rows };
}

/** Restore validates the whole employee ledger before replacing the current dataset. */
export function validatePayrollSnapshot(employees: Row[], documents: Row[], financialMovements: Row[]) {
  const employeeMap = new Map<string, Row>(), agreementMaps = new Map<string, Map<string, Agreement>>();
  const invalid = () => fail("بيانات الموظفين أو روابط استحقاقاتهم ودفعاتهم غير صالحة");
  const validId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.trim() === value;
  const validRevision = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const validAgreement = (row: Agreement) => {
    if (!row || !validId(row.id) || typeof row.amount !== "number" || !validRevision(row.anchorDay) || row.anchorDay < 1 || row.anchorDay > 31 ||
        typeof row.intervalMonths !== "number" || interval(row.intervalMonths) !== row.intervalMonths) throw invalid();
    money(row.amount); day(row.startDate); timing(row.entitlement);
    if (row.stopDate !== undefined && day(row.stopDate) < row.startDate) throw invalid();
    if (row.canceledAt !== undefined && (typeof row.canceledAt !== "string" || !Number.isFinite(Date.parse(row.canceledAt)))) throw invalid();
  };
  for (const employee of employees) {
    if (!validId(employee.id) || employeeMap.has(employee.id) || typeof employee.name !== "string" || !employee.name.trim() || employee.name.length > 120 ||
        typeof employee.balance !== "number" || !validRevision(employee.revision) || typeof employee.isArchived !== "boolean" ||
        (employee.phone !== undefined && (typeof employee.phone !== "string" || employee.phone.length > 40)) || !Array.isArray(employee.agreements) || !employee.agreements.length) throw invalid();
    money(employee.balance, true); day(employee.startDate);
    const map = new Map<string, Agreement>();
    for (const agreement of employee.agreements) {
      validAgreement(agreement);
      if (map.has(agreement.id) || agreement.startDate < employee.startDate) throw invalid();
      map.set(agreement.id, agreement);
    }
    if (!employee.isArchived && !employee.agreements.some((row: Agreement) => !row.canceledAt)) throw invalid();
    validateSchedule(employee.agreements);
    employeeMap.set(employee.id, employee); agreementMaps.set(employee.id, map);
  }
  const payroll = documents.filter(row => ["employee-accrual", "employee-payment"].includes(row.kind));
  const documentMap = new Map<string, Row>(), accruals = new Map<string, Row>(), allocations = new Map<string, number>(), balances = new Map<string, number>();
  for (const document of payroll) {
    if (!validId(document.id) || documentMap.has(document.id) || !employeeMap.has(document.employeeId) || !validRevision(document.revision) ||
        !["posted", "voided"].includes(document.status) || typeof document.total !== "number" || document.amount !== document.total || !validId(document.number) ||
        !Array.isArray(document.lines) || document.lines.length !== 0) throw invalid();
    const date = day(document.businessDate), cents = money(document.total);
    if (typeof document.occurredAt !== "string" || !Number.isFinite(Date.parse(document.occurredAt)) || document.occurredAt.slice(0, 10) !== date || date < employeeMap.get(document.employeeId)!.startDate) throw invalid();
    const sign = document.kind === "employee-accrual" ? 1 : -1;
    if (document.balanceDelta !== amount(sign * cents)) throw invalid();
    if (document.status === "posted") balances.set(document.employeeId, (balances.get(document.employeeId) ?? 0) + sign * cents);
    documentMap.set(document.id, document);
    if (document.kind === "employee-accrual") {
      const start = day(document.periodStart), end = day(document.periodEnd), snapshot = document.agreementSnapshot as Agreement;
      validAgreement(snapshot);
      const saved = agreementMaps.get(document.employeeId)!.get(snapshot.id);
      if (!saved || ["startDate", "amount", "intervalMonths", "entitlement", "anchorDay"].some(key => saved[key as keyof Agreement] !== snapshot[key as keyof Agreement]) ||
          start < snapshot.startDate || end !== priorDay(boundary(start, snapshot.intervalMonths, snapshot.anchorDay)) || document.dueDate !== date ||
          document.id !== accrualId(document.employeeId, start)) throw invalid();
      const months = (Number(start.slice(0, 4)) - Number(snapshot.startDate.slice(0, 4))) * 12 + Number(start.slice(5, 7)) - Number(snapshot.startDate.slice(5, 7));
      if (months < 0 || months % snapshot.intervalMonths !== 0 || boundary(snapshot.startDate, months, snapshot.anchorDay) !== start) throw invalid();
      accruals.set(document.id, document);
    }
  }
  for (const employee of employees) {
    if ((balances.get(employee.id) ?? 0) !== money(employee.balance, true)) throw invalid();
    let previousEnd = "";
    for (const row of [...accruals.values()].filter(item => item.employeeId === employee.id && item.status === "posted").sort((a, b) => a.periodStart.localeCompare(b.periodStart))) {
      if (previousEnd && row.periodStart <= previousEnd) throw invalid();
      previousEnd = row.periodEnd;
    }
  }
  for (const payment of payroll.filter(row => row.kind === "employee-payment")) {
    if (!validId(payment.paymentMethod) || !Array.isArray(payment.allocations) || !payment.allocations.length) throw invalid();
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
      if (movement.type !== "employee-payment" || payment.status !== "posted" || movement.direction !== "out" || movement.amount !== payment.total ||
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
          original.paymentMethod !== movement.paymentMethod || original.amount !== movement.amount || movement.direction !== "in") throw invalid();
    } else if (movement.status === "reversed") {
      const reversal = movementMap.get(movement.reversalMovementId);
      if (!reversal || reversal.isReversal !== true || reversal.reversalOfMovementId !== movement.id) throw invalid();
    }
  }
}
