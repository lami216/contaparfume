import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHarness } from './sqlite-harness.mjs';
import { accrueDueEmployees, handlePayrollCommand } from '../lib/payroll.ts';
import { buildReport, parseReportFilters } from '../lib/reports.ts';
import { buildEmployeeLedger } from '../lib/employee-ledger.ts';
import { createNativeBackup, parseAndValidateBackup, restoreNativeBackup, stringifyBackup } from '../lib/backup.ts';
import { canReadDocument, canReadDocumentKind, canReadOperationalDocument } from '../lib/document-read-model.ts';

const clock = day => new Date(`${day}T15:00:00.000Z`);
async function fixture(t) {
  const h = await sqliteHarness(), priorProfile = process.env.ALKARNA_USER_DATA;
  process.env.ALKARNA_USER_DATA = h.directory;
  t.after(async () => {
    await h.close();
    if (priorProfile === undefined) delete process.env.ALKARNA_USER_DATA;
    else process.env.ALKARNA_USER_DATA = priorProfile;
  });
  await h.reset();
  const db = h.db;
  await db.collection('warehouses').insertOne({ _id: 'synthetic-main', name: 'Synthetic default warehouse', isSalesDefault: true });
  await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', openingBalance: 10000, balance: 10000, isActive: true });
  const run = (body, at = '2026-11-15') => handlePayrollCommand(db, {}, body, clock(at));
  const create = (extra = {}) => run({ type: 'employee.create', name: 'Synthetic opening worker', amount: 0,
    startDate: '2026-11-10', intervalMonths: 1, entitlement: 'beginning', ...extra }, '2026-11-10');
  const employee = id => db.collection('employees').findOne({ id });
  const doc = id => db.collection('documents').findOne({ id });
  const opening = (employeeId, direction, amount = 100) => run({ type: 'employee-opening.post', employeeId, direction, amount, occurredAt: '2026-11-01', note: 'Synthetic old balance only' });
  const pay = (employeeId, amount, direction, occurredAt) => run({ type: 'employee-payment.post', employeeId, amount, direction, occurredAt, paymentMethod: 'cash' });
  const sync = at => accrueDueEmployees(db, {}, { asOf: at, now: clock(at), context: 'synthetic-opening-reports' });
  const report = (type, extra = {}) => buildReport(db, { ...parseReportFilters(new URL(`http://local/?type=${type}&allTime=true&unpaged=true`)), ...extra });
  const ledger = (employeeId, extra = {}) => report('party-ledger', { partyType: 'employee', partyId: employeeId, ...extra });
  const moneyState = () => Promise.all(['paymentAccounts', 'financialMovements', 'products', 'stockMovements'].map(name => db.collection(name).find().toArray()));
  const roundTrip = async () => {
    const backup = parseAndValidateBackup(stringifyBackup(await createNativeBackup(db)));
    assert.equal(backup.schemaVersion, 1);
    await db.transaction(session => restoreNativeBackup(db, backup, session));
    const after = await createNativeBackup(db);
    for (const name of ['employees', 'documents', 'financialMovements', 'paymentAccounts', 'auditEvents']) assert.deepEqual(after.collections[name], backup.collections[name], name);
    return backup;
  };
  return { db, run, create, employee, doc, opening, pay, sync, report, ledger, moneyState, roundTrip };
}

test('both opening directions affect current debt and period ledger positions without cash, salary, earned reserve or income', async t => {
  for (const direction of ['payable', 'receivable']) await t.test(direction, async t => {
    const f = await fixture(t), employeeId = await f.create(), before = await f.moneyState();
    const openingId = await f.opening(employeeId, direction), document = await f.doc(openingId), sign = direction === 'payable' ? 1 : -1;
    assert.deepEqual([document.kind, document.total, document.balanceDelta, document.lines, document.paymentMethod, document.cashAmount], ['employee-opening', 100, sign * 100, [], null, 0]);
    assert.deepEqual(await f.moneyState(), before);
    const overview = await f.report('overview');
    assert.deepEqual([overview.summary.currentReceivable, overview.summary.currentPayable, overview.summary.currentWorkersUnpaidWages], [direction === 'receivable' ? 100 : 0, direction === 'payable' ? 100 : 0, 0]);
    for (const key of ['sales', 'purchases', 'expenses', 'workersPaid', 'workersAccrued', 'workersReserveChange', 'netOperatingResult', 'ownerAvailableProfit']) assert.equal(overview.summary[key], 0, key);
    assert.equal(overview.invoices.some(row => row.documentId === openingId), false);
    assert.equal(overview.overviewDetails.expenses.some(row => row.documentId === openingId), false);
    const current = overview.parties.find(row => row.employeeId === employeeId);
    assert.deepEqual([current.receivable, current.payable], [direction === 'receivable' ? 100 : 0, direction === 'payable' ? 100 : 0]);
    const debt = await f.report('debts', { partyType: 'employee', debtSide: direction });
    assert.deepEqual(debt.rows.map(row => row.employeeId), [employeeId]);
    assert.equal((await f.report('expenses')).rows.length, 0);
    assert.equal((await f.report('financial')).rows.length, 0);
    const account = await f.ledger(employeeId), row = account.rows[0];
    assert.deepEqual([row.documentId, row.movementCode, row.noncash, row.debit, row.credit], [openingId, 'employee-opening', true, sign < 0 ? 100 : 0, sign > 0 ? 100 : 0]);
    assert.deepEqual([account.summary.workersAccrued, account.summary.workersPaid, account.summary.workersDeposited, account.summary.workersReserveReleased], [0, 0, 0, 0]);
    assert.deepEqual([account.summary.currentBalance, account.summary.closingBalance, account.summary.reconciliationDifference], [-sign * 100, -sign * 100, 0]);
    const period = await f.ledger(employeeId, { allTime: false, from: '2026-11-02', to: '2026-11-05' });
    assert.equal(period.rows.length, 0);
    assert.deepEqual([period.summary.openingBalance, period.summary.closingBalance, period.summary.currentBalance], [-sign * 100, -sign * 100, -sign * 100]);
    const earlier = await f.ledger(employeeId, { allTime: false, from: '2026-10-01', to: '2026-10-31' });
    assert.deepEqual([earlier.summary.openingBalance, earlier.summary.closingBalance, earlier.summary.currentBalance], [0, 0, -sign * 100]);
    await f.roundTrip();
    assert.deepEqual(await f.ledger(employeeId), account);
    assert.deepEqual(await f.moneyState(), before);
  });
});

test('old payable consumes withdrawals before current earned salary and keeps cash-ledger paid totals distinct from recognized wage expense', async t => {
  const f = await fixture(t), employeeId = await f.create({ amount: 100 });
  const openingId = await f.opening(employeeId, 'payable');
  await f.sync('2026-11-10');
  const firstPayment = await f.pay(employeeId, 100, 'withdraw', '2026-11-11');
  const first = await f.report('overview');
  assert.deepEqual([first.summary.currentPayable, first.summary.currentWorkersUnpaidWages, first.summary.expenses, first.summary.workersAccrued, first.summary.workersPaid], [100, 100, 0, 100, 0]);
  assert.deepEqual([(await f.ledger(employeeId)).summary.workersPaid, (await f.report('financial')).summary.outgoing], [100, 100]);
  assert.equal((await f.report('expenses')).rows.length, 0);
  const wagePayment = await f.pay(employeeId, 40, 'withdraw', '2026-11-12');
  const paid = await f.report('overview');
  assert.deepEqual([paid.summary.currentPayable, paid.summary.currentWorkersUnpaidWages, paid.summary.expenses, paid.summary.workersPaid, paid.summary.currentAccountsBalance], [60, 60, 40, 40, 9860]);
  const expenses = await f.report('expenses');
  assert.deepEqual(expenses.rows.map(row => [row.documentId, row.total]), [[wagePayment, 40]]);
  assert.equal(expenses.rows.some(row => row.documentId === openingId || row.documentId === firstPayment), false);
  const day11 = await f.report('overview', { allTime: false, from: '2026-11-11', to: '2026-11-11' });
  assert.deepEqual([day11.summary.expenses, day11.summary.workersPaid, day11.summary.workersAccrued], [0, 0, 0]);
  const refund = await f.pay(employeeId, 20, 'deposit', '2026-11-13');
  const after = await f.report('overview');
  assert.deepEqual([after.summary.currentPayable, after.summary.currentWorkersUnpaidWages, after.summary.expenses, after.summary.sales, after.summary.currentAccountsBalance], [80, 80, 20, 0, 9880]);
  const day13 = await f.report('expenses', { allTime: false, from: '2026-11-13', to: '2026-11-13' });
  assert.deepEqual(day13.rows.map(row => [row.documentId, row.total]), [[refund, -20]]);
  assert.equal((await f.ledger(employeeId)).summary.reconciliationDifference, 0);
});

test('an old receivable is recognized only against subsequently earned salary, without creating cash or revenue from the opening', async t => {
  const f = await fixture(t), employeeId = await f.create({ amount: 150 });
  const openingId = await f.opening(employeeId, 'receivable'), money = await f.moneyState();
  await f.sync('2026-11-10');
  const accrual = await f.db.collection('documents').findOne({ employeeId, kind: 'employee-accrual', status: 'posted' });
  const result = await f.report('overview');
  assert.deepEqual([result.summary.currentPayable, result.summary.currentReceivable, result.summary.currentWorkersUnpaidWages, result.summary.workersAccrued, result.summary.workersPaid, result.summary.expenses, result.summary.sales], [50, 0, 50, 150, 100, 100, 0]);
  assert.deepEqual(await f.moneyState(), money);
  const expenses = await f.report('expenses');
  assert.deepEqual(expenses.rows.map(row => [row.documentId, row.total]), [[accrual.id, 100]]);
  assert.equal(expenses.rows.some(row => row.documentId === openingId), false);
  assert.deepEqual([(await f.ledger(employeeId)).summary.workersPaid, (await f.ledger(employeeId)).summary.currentBalance], [0, -50]);
  const paymentId = await f.pay(employeeId, 50, 'withdraw', '2026-11-11');
  assert.deepEqual([(await f.report('overview')).summary.expenses, (await f.report('overview')).summary.currentPayable], [150, 0]);
  assert.deepEqual([(await f.report('financial')).summary.outgoing, (await f.ledger(employeeId)).summary.workersPaid], [50, 50]);
  assert.equal((await f.report('expenses')).rows.some(row => row.documentId === paymentId && row.total === 50), true);
  await f.roundTrip();
  assert.equal((await f.ledger(employeeId)).summary.reconciliationDifference, 0);
});

test('early repayment anchored to a native opening remains nonincome through opening edit, void and native restore', async t => {
  const f = await fixture(t), employeeId = await f.create({ openingBalance: { direction: 'receivable', amount: 100, occurredAt: '2026-11-01', note: 'Synthetic imported-in-time debt' } });
  const opening = await f.db.collection('documents').findOne({ employeeId, kind: 'employee-opening', status: 'posted' });
  assert(opening);
  const repaymentId = await f.pay(employeeId, 100, 'deposit', '2026-11-05'), repayment = await f.doc(repaymentId), finance = await f.moneyState();
  assert.equal(repayment.employeeOpeningAnchor.openingDocumentId, opening.id);
  assert.deepEqual([(await f.employee(employeeId)).balance, (await f.report('overview')).summary.currentAccountsBalance], [0, 10100]);
  await f.run({ type: 'employee-opening.update', documentId: opening.id, expectedRevision: opening.revision, amount: 80, reason: 'Synthetic correction of old debt' });
  assert.deepEqual([(await f.employee(employeeId)).balance, (await f.report('overview')).summary.currentPayable], [20, 20]);
  const revised = await f.doc(opening.id);
  await f.run({ type: 'employee-opening.void', documentId: opening.id, expectedRevision: revised.revision, reason: 'Synthetic cancellation of opening only' });
  const report = await f.report('overview');
  assert.deepEqual([report.summary.currentPayable, report.summary.currentReceivable, report.summary.expenses, report.summary.sales, report.summary.workersAccrued, report.summary.currentWorkersUnpaidWages], [100, 0, 0, 0, 0, 0]);
  assert.deepEqual(await f.moneyState(), finance);
  assert.deepEqual(await f.doc(repaymentId), repayment);
  const ledger = await f.ledger(employeeId);
  assert.equal(ledger.rows.some(row => row.documentId === opening.id), false);
  assert.deepEqual([ledger.summary.workersPaid, ledger.summary.workersDeposited, ledger.summary.currentBalance, ledger.summary.reconciliationDifference], [0, 100, -100, 0]);
  await f.roundTrip();
  assert.deepEqual(await f.ledger(employeeId), ledger);
});

test('closure after an opening and mixed salary payment releases only earned unpaid reserve while preserving every cash and old-balance source', async t => {
  const f = await fixture(t), employeeId = await f.create({ amount: 100 });
  const openingId = await f.opening(employeeId, 'payable'); await f.sync('2026-11-10');
  const paymentId = await f.pay(employeeId, 130, 'withdraw', '2026-11-11');
  const opening = await f.doc(openingId), payment = await f.doc(paymentId), finance = await f.moneyState();
  assert.deepEqual([(await f.report('overview')).summary.expenses, (await f.employee(employeeId)).balance], [30, 70]);
  await f.run({ type: 'employee.archive', employeeId, expectedRevision: (await f.employee(employeeId)).revision }, '2026-11-14');
  await f.run({ type: 'employee.delete', employeeId, expectedRevision: (await f.employee(employeeId)).revision, reason: 'Synthetic final departure' });
  const closure = await f.db.collection('documents').findOne({ employeeId, kind: 'employee-closure' });
  assert.deepEqual([closure.total, closure.salaryReserveReleased], [70, 70]);
  const result = await f.report('overview');
  assert.deepEqual([result.summary.currentPayable, result.summary.currentReceivable, result.summary.currentWorkersUnpaidWages, result.summary.expenses, result.summary.workersAccrued, result.summary.workersPaid], [0, 0, 0, 30, 100, 30]);
  assert.equal(result.parties.some(row => row.employeeId === employeeId), false);
  assert.deepEqual(await f.moneyState(), finance);
  assert.deepEqual(await f.doc(openingId), opening); assert.deepEqual(await f.doc(paymentId), payment);
  const ledger = await f.ledger(employeeId);
  assert.deepEqual([ledger.summary.workersPaid, ledger.summary.workersReserveReleased, ledger.summary.currentBalance, ledger.summary.reconciliationDifference], [130, 70, 0, 0]);
  await f.roundTrip();
  assert.deepEqual(await f.ledger(employeeId), ledger);
});

test('native backup accepts the old no-opening ledger and rejects fabricated opening cash or contradictory opening directions', async t => {
  const f = await fixture(t), employeeId = await f.create({ amount: 100 });
  await f.sync('2026-11-10'); await f.pay(employeeId, 40, 'withdraw', '2026-11-11');
  const legacy = await f.roundTrip();
  assert.equal(legacy.collections.documents.some(row => row.kind === 'employee-opening'), false);
  assert.deepEqual([(await f.report('overview')).summary.expenses, (await f.employee(employeeId)).balance], [40, 60]);
  const second = await f.create({ name: 'Synthetic backup opening only' });
  const openingId = await f.opening(second, 'payable'), valid = parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));
  const wrongSign = structuredClone(valid);
  wrongSign.collections.documents.find(row => row.id === openingId).balanceDelta = -100;
  assert.throws(() => parseAndValidateBackup(stringifyBackup(wrongSign)), /العامل|الموظفين/);
  const withCash = structuredClone(valid), source = withCash.collections.documents.find(row => row.id === openingId);
  withCash.collections.financialMovements.push({ id: 'fabricated-opening-cash', documentId: openingId, documentNumber: source.number, employeeId: second,
    type: 'manual-deposit', status: 'posted', revision: 0, paymentMethod: 'cash', direction: 'in', amount: 100, delta: 100,
    balanceBefore: 9960, balanceAfter: 10060, occurredAt: source.occurredAt });
  assert.throws(() => parseAndValidateBackup(stringifyBackup(withCash)), /العامل|الموظفين/);
});

test('opening rank precedes same-day accrual and payment and broad records authority cannot bypass worker opening ACL', () => {
  const documents = [
    { id: 'cash', employeeId: 'worker', kind: 'employee-payment', status: 'posted', total: 100, balanceDelta: -100, businessDate: '2026-11-10', occurredAt: '2026-11-10T12:00:00.000Z', employeeAccountOrder: 2 },
    { id: 'earned', employeeId: 'worker', kind: 'employee-accrual', status: 'posted', total: 100, balanceDelta: 100, businessDate: '2026-11-10', occurredAt: '2026-11-10T12:00:00.000Z' },
    { id: 'opening', employeeId: 'worker', kind: 'employee-opening', status: 'posted', employeeOpeningDirection: 'payable', total: 100, balanceDelta: 100, businessDate: '2026-11-10', occurredAt: '2026-11-10T12:00:00.000Z', employeeAccountOrder: 1 },
  ];
  const result = buildEmployeeLedger({ id: 'worker', name: 'Synthetic same-day worker', balance: 100 }, documents);
  assert.deepEqual(result.rows.map(row => [row.id, row.runningBalance]), [['cash', -100], ['earned', -200], ['opening', -100]]);
  assert.deepEqual([result.summary.workersAccrued, result.summary.workersPaid, result.summary.reconciliationDifference], [100, 100, 0]);
  for (const capabilities of [[], ['records.view'], ['reports.view'], ['employees.view']]) {
    const access = { can: capability => capabilities.includes(capability), customerPartyIds: new Set(), supplierPartyIds: new Set() };
    const allowed = capabilities.includes('employees.view');
    assert.equal(canReadDocumentKind('employee-opening', access), allowed);
    assert.equal(canReadDocument(documents[2], access), allowed);
    assert.equal(canReadOperationalDocument(documents[2], access), allowed);
    assert.equal(canReadOperationalDocument({ ...documents[2], status: 'voided' }, access), false);
  }
});
