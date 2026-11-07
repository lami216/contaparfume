import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { SqliteDatabase, ensureDatabaseSchema } from '../lib/sqlite.ts';
import { accrueDueEmployees, handlePayrollCommand } from '../lib/payroll.ts';
import { buildReport, parseReportFilters } from '../lib/reports.ts';
import { buildEmployeeLedger } from '../lib/employee-ledger.ts';

const clock = day => new Date(`${day}T15:00:00.000Z`);
async function fixture(t) {
  const db = new SqliteDatabase(new Database(':memory:'));
  t.after(() => db.close());
  ensureDatabaseSchema(db);
  await db.dropDatabase();
  await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', balance: 10000, isActive: true });
  const run = (body, day = '2026-11-04') => handlePayrollCommand(db, {}, body, clock(day));
  const create = (extra = {}, day = '2026-11-01') => run({
    type: 'employee.create', name: 'Synthetic worker', amount: 1000, startDate: '2026-11-01',
    intervalMonths: 1, entitlement: 'beginning', ...extra,
  }, day);
  const sync = day => accrueDueEmployees(db, {}, { asOf: day, now: clock(day) });
  const report = (type, extra = {}) => buildReport(db, {
    ...parseReportFilters(new URL(`http://local/?type=${type}&allTime=true&unpaged=true`)), ...extra,
  });
  const state = () => Promise.all(['employees', 'documents', 'financialMovements', 'paymentAccounts', 'auditEvents'].map(name => db.collection(name).find().toArray()));
  return { db, run, create, sync, report, state };
}

test('worker account roles are allowlisted and explicit type disambiguates a party with the same id', async t => {
  const f = await fixture(t), employeeId = await f.create();
  await f.sync('2026-11-01');
  await f.db.collection('parties').insertOne({ id: employeeId, name: 'Synthetic customer', partyType: 'customer', receivable: 30, payable: 0 });
  const parsed = parseReportFilters(new URL(`http://local/?type=party-ledger&allTime=true&partyId=${employeeId}&partyType=employee`));
  assert.equal(parsed.partyType, 'employee');
  assert.throws(() => parseReportFilters(new URL('http://local/?type=debts&partyType=administrator')), /partyType/);
  const worker = await f.report('party-ledger', { partyId: employeeId, partyType: 'employee' });
  const party = await f.report('party-ledger', { partyId: employeeId });
  assert.deepEqual([worker.summary.name, worker.summary.net, worker.rows[0].employeeId], ['Synthetic worker', -1000, employeeId]);
  assert.deepEqual([party.summary.name, party.summary.net], ['Synthetic customer', 30]);
  await assert.rejects(f.report('party-ledger', { partyId: employeeId, partyType: 'supplier' }), /نوع الطرف/);
});

test('employee ledger period opening, running, closing and current balances retain the shop perspective', async t => {
  const f = await fixture(t), employeeId = await f.create();
  await f.sync('2026-11-01');
  const withdrawalId = await f.run({ type: 'employee-payment.post', employeeId, direction: 'withdraw', amount: 1200, paymentMethod: 'cash', occurredAt: '2026-11-02', note: 'Synthetic advance' });
  const depositId = await f.run({ type: 'employee-payment.post', employeeId, direction: 'deposit', amount: 50, paymentMethod: 'cash', occurredAt: '2026-11-03' });
  await f.run({ type: 'employee-payment.post', employeeId, direction: 'withdraw', amount: 20, paymentMethod: 'cash', occurredAt: '2026-11-04' });
  const before = await f.state();
  const result = await f.report('party-ledger', { partyId: employeeId, partyType: 'employee', allTime: false, from: '2026-11-02', to: '2026-11-03', pageSize: 1, unpaged: false });
  assert.deepEqual([result.summary.openingBalance, result.summary.closingBalance, result.summary.currentBalance], [-1000, 150, 170]);
  assert.deepEqual([result.summary.debitTotal, result.summary.creditTotal, result.summary.workersPaid, result.summary.workersDeposited], [1200, 50, 1200, 50]);
  assert.equal(result.summary.reconciliationDifference, 0);
  assert.equal(result.meta.totalRows, 2);
  assert.deepEqual(result.rows.map(row => [row.documentId, row.debit, row.credit, row.balance]), [[depositId, 0, 50, 150]]);
  const second = await f.report('party-ledger', { partyId: employeeId, partyType: 'employee', allTime: false, from: '2026-11-02', to: '2026-11-03', page: 2, pageSize: 1, unpaged: false });
  assert.deepEqual(second.rows.map(row => [row.documentId, row.debit, row.credit, row.balance]), [[withdrawalId, 1200, 0, 200]]);
  assert.deepEqual(await f.state(), before, 'Reading and paging a ledger never changes worker or cash records');
});

test('worker liability and advances appear separately in current account groups, including archived nonzero workers', async t => {
  const f = await fixture(t);
  await f.db.collection('employees').insertMany([
    { id: 'owed', name: 'Z Worker', balance: 50, isArchived: true },
    { id: 'advance', name: 'A Worker', balance: -40, isArchived: false },
    { id: 'closed', name: 'Closed worker', balance: 0, isArchived: true },
  ]);
  await f.db.collection('parties').insertMany([
    { id: 'customer', name: 'B Customer', partyType: 'customer', receivable: 100, payable: 0 },
    { id: 'supplier', name: 'A Supplier', partyType: 'supplier', receivable: 0, payable: 200 },
  ]);
  const overview = await f.report('overview');
  assert.deepEqual([overview.summary.currentReceivable, overview.summary.currentPayable], [140, 250]);
  assert.deepEqual(overview.parties.map(row => [row.partyType, row.name]), [
    ['employee', 'A Worker'], ['employee', 'Z Worker'], ['customer', 'B Customer'], ['supplier', 'A Supplier'],
  ]);
  const debts = await f.report('debts');
  assert.deepEqual([debts.summary.receivable, debts.summary.payable, debts.summary.net, debts.summary.count], [140, 250, -110, 4]);
  const receivable = await f.report('debts', { partyType: 'employee', debtSide: 'receivable' });
  assert.deepEqual(receivable.rows.map(row => [row.employeeId, row.receivable, row.payable]), [['advance', 40, 0]]);
  const archived = await f.report('debts', { search: 'Z Worker', debtSide: 'payable' });
  assert.deepEqual(archived.rows.map(row => row.employeeId), ['owed']);
});

test('salary refund reduces paid wage expense without becoming revenue, and bank filters retain the signed source', async t => {
  const f = await fixture(t), employeeId = await f.create({ amount: 6000 });
  await f.sync('2026-11-01');
  await f.run({ type: 'employee-payment.post', employeeId, direction: 'withdraw', amount: 2000, paymentMethod: 'cash', occurredAt: '2026-11-02' });
  const refundId = await f.run({ type: 'employee-payment.post', employeeId, direction: 'deposit', amount: 500, paymentMethod: 'cash', occurredAt: '2026-11-03' });
  const period = { allTime: false, from: '2026-11-03', to: '2026-11-03' };
  const overview = await f.report('overview', period);
  assert.deepEqual([overview.summary.sales, overview.summary.expenses, overview.summary.netOperatingResult, overview.summary.workersExpense], [0, -500, 500, -500]);
  assert.deepEqual([overview.summary.currentPayable, overview.summary.currentAccountsBalance], [4500, 8500]);
  assert.deepEqual(overview.overviewDetails.expenses.map(row => [row.documentId, row.value]), [[refundId, -500]]);
  const expense = await f.report('expenses', { ...period, paymentAccountId: 'cash' });
  assert.deepEqual([expense.summary.total, expense.rows[0].documentId, expense.rows[0].employeeId], [-500, refundId, employeeId]);
  assert.equal((await f.report('expenses', { ...period, expenseCategoryId: 'not-a-payroll-category' })).summary.total, 0);
  assert.equal((await f.report('expenses')).summary.total, 1500);
  const financial = await f.report('financial', period);
  assert.deepEqual([financial.summary.incoming, financial.summary.outgoing, financial.rows[0].employeeId], [500, 0, employeeId]);
});

test('an advance becomes expense on the later earned accrual and keeps its real source rather than a new cash movement', async t => {
  const f = await fixture(t), employeeId = await f.create({ amount: 6000, entitlement: 'end' });
  const advanceId = await f.run({ type: 'employee-payment.post', employeeId, direction: 'withdraw', amount: 1000, paymentMethod: 'cash', occurredAt: '2026-11-05' }, '2026-11-05');
  const november5 = { allTime: false, from: '2026-11-05', to: '2026-11-05' };
  assert.equal((await f.report('expenses', november5)).summary.total, 0);
  const advancePosition = await f.report('overview', november5);
  assert.deepEqual([advancePosition.summary.currentReceivable, advancePosition.summary.currentPayable], [1000, 0]);
  await f.sync('2026-11-30');
  const period = { allTime: false, from: '2026-11-30', to: '2026-11-30' };
  const result = await f.report('overview', period);
  assert.deepEqual([result.summary.expenses, result.summary.currentPayable, result.summary.currentAccountsBalance], [1000, 5000, 9000]);
  const accrual = await f.db.collection('documents').findOne({ kind: 'employee-accrual', employeeId });
  assert.deepEqual(result.overviewDetails.expenses.map(row => [row.documentId, row.kind, row.value]), [[accrual.id, 'employee-accrual', 1000]]);
  assert.equal(result.invoices.find(row => row.documentId === accrual.id).invoiceValue, 1000);
  assert.equal(result.invoices.some(row => row.documentId === advanceId), false);
  assert.equal((await f.report('expenses', { ...period, paymentAccountId: 'cash' })).summary.total, 0);
  assert.equal((await f.report('financial', period)).summary.outgoing, 0);
});

test('a personal worker deposit is a payable balance without creating wages, sales or expense', async t => {
  const f = await fixture(t), employeeId = await f.create({ entitlement: 'end' });
  await f.run({ type: 'employee-payment.post', employeeId, direction: 'deposit', amount: 200, paymentMethod: 'cash', occurredAt: '2026-11-02' });
  const overview = await f.report('overview');
  assert.deepEqual([overview.summary.currentPayable, overview.summary.currentWorkersOwed, overview.summary.currentWorkersUnpaidWages], [200, 200, 0]);
  assert.deepEqual([overview.summary.sales, overview.summary.expenses, overview.summary.currentAccountsBalance], [0, 0, 10200]);
  assert.equal((await f.report('expenses')).rows.length, 0);
  const ledger = await f.report('party-ledger', { partyType: 'employee', partyId: employeeId });
  assert.deepEqual([ledger.rows[0].debit, ledger.rows[0].credit, ledger.summary.currentBalance], [0, 200, -200]);
});

test('legacy missing cash direction remains withdrawal and saved signed deltas retain running balances after input reordering', () => {
  const employee = { id: 'worker', name: 'Synthetic legacy worker', balance: 50 };
  const documents = [
    { id: 'deposit', kind: 'employee-payment', employeeId: 'worker', status: 'posted', businessDate: '2026-11-01', occurredAt: '2026-11-01T12:00:00.000Z', employeeAccountOrder: 2, employeePaymentDirection: 'deposit', total: 100, balanceDelta: 100 },
    { id: 'withdraw', kind: 'employee-payment', employeeId: 'worker', status: 'posted', businessDate: '2026-11-01', occurredAt: '2026-11-01T12:00:00.000Z', employeeAccountOrder: 1, total: 150, balanceDelta: -150, allocations: [] },
    { id: 'accrual', kind: 'employee-accrual', employeeId: 'worker', status: 'posted', businessDate: '2026-11-01', occurredAt: '2026-11-01T12:00:00.000Z', total: 100, balanceDelta: 100 },
    { id: 'void', kind: 'employee-payment', employeeId: 'worker', status: 'voided', businessDate: '2026-11-01', occurredAt: '2026-11-01T12:00:00.000Z', total: 999, balanceDelta: -999 },
  ];
  const before = structuredClone(documents);
  const result = buildEmployeeLedger(employee, documents);
  assert.deepEqual(result.rows.map(row => [row.id, row.balance, row.movementCode]), [
    ['deposit', -50, 'employee-deposit'], ['withdraw', 50, 'employee-withdrawal'], ['accrual', -100, 'employee-accrual'],
  ]);
  assert.equal(result.summary.reconciliationDifference, 0);
  assert.deepEqual(documents, before);
});
