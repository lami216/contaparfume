import assert from 'node:assert/strict';
import test from 'node:test';
import { sqliteHarness } from './sqlite-harness.mjs';
import { accrueDueEmployees, handlePayrollCommand } from '../lib/payroll.ts';
import { buildReport, parseReportFilters } from '../lib/reports.ts';
import { buildEmployeeLedger } from '../lib/employee-ledger.ts';
import { createNativeBackup, parseAndValidateBackup, restoreNativeBackup, stringifyBackup } from '../lib/backup.ts';
import { canReadDocument, canReadDocumentKind, canReadOperationalDocument } from '../lib/document-read-model.ts';
import { GET as bootstrap } from '../app/api/bootstrap/route.ts';
import { createSession } from '../lib/auth.ts';

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
  const run = (body, day = '2026-11-04') => handlePayrollCommand(db, {}, body, clock(day));
  const employee = id => db.collection('employees').findOne({ id });
  const create = (extra = {}) => run({ type: 'employee.create', name: 'Synthetic deleted worker', amount: 1000,
    startDate: '2026-11-01', intervalMonths: 1, entitlement: 'beginning', ...extra }, '2026-11-01');
  const archive = async id => run({ type: 'employee.archive', employeeId: id, expectedRevision: (await employee(id)).revision, reason: 'Synthetic departure' }, '2026-11-03');
  const remove = async id => run({ type: 'employee.delete', employeeId: id, expectedRevision: (await employee(id)).revision, reason: 'Synthetic permanent deletion' });
  const report = (type, extra = {}) => buildReport(db, { ...parseReportFilters(new URL(`http://local/?type=${type}&allTime=true&unpaged=true`)), ...extra });
  const cash = async () => (await db.collection('paymentAccounts').findOne({ id: 'cash' })).balance;
  const snapshot = () => Promise.all(['employees', 'documents', 'financialMovements', 'paymentAccounts', 'auditEvents', 'products', 'stockMovements'].map(name => db.collection(name).find().toArray()));
  return { db, run, employee, create, archive, remove, report, cash, snapshot };
}

test('deleting an archived owed worker releases only the unpaid reserve and preserves recognized wages, cash and past-period reports', async t => {
  const f = await fixture(t), employeeId = await f.create();
  await accrueDueEmployees(f.db, {}, { asOf: '2026-11-01', now: clock('2026-11-01') });
  await f.run({ type: 'employee-payment.post', employeeId, amount: 400, direction: 'withdraw', paymentMethod: 'cash', occurredAt: '2026-11-02' }, '2026-11-02');
  await f.archive(employeeId);
  const oldDocuments = await f.db.collection('documents').find().toArray();
  const oldFinancial = await f.db.collection('financialMovements').find().toArray();
  const before = await f.report('overview');
  assert.deepEqual([before.summary.currentPayable, before.summary.currentWorkersUnpaidWages, before.summary.expenses], [600, 600, 400]);
  const pastPeriod = { allTime: false, from: '2026-11-01', to: '2026-11-03' };
  const historical = await f.report('overview', pastPeriod);
  await f.remove(employeeId);
  const deleted = await f.employee(employeeId), closure = await f.db.collection('documents').findOne({ employeeId, kind: 'employee-closure' });
  assert.equal(deleted.isDeleted, true); assert.equal(deleted.balance, 0);
  assert.deepEqual([closure.total, closure.balanceDelta, closure.salaryReserveReleased], [600, -600, 600]);
  for (const document of oldDocuments) assert.deepEqual(await f.db.collection('documents').findOne({ id: document.id }), document);
  assert.deepEqual(await f.db.collection('financialMovements').find().toArray(), oldFinancial);
  assert.equal(await f.cash(), 9600);

  const overview = await f.report('overview');
  assert.deepEqual([overview.summary.currentPayable, overview.summary.currentReceivable, overview.summary.currentWorkersUnpaidWages, overview.summary.employeeCount], [0, 0, 0, 0]);
  assert.deepEqual([overview.summary.expenses, overview.summary.workersPaid, overview.summary.workersAccrued, overview.summary.workersReserveChange, overview.summary.netOperatingResult, overview.summary.ownerAvailableProfit], [400, 400, 1000, 0, -400, -400]);
  assert.equal(overview.parties.some(row => row.employeeId === employeeId), false);
  assert.equal(overview.invoices.some(row => row.documentId === closure.id), false);
  assert.equal(overview.overviewDetails.expenses.some(row => row.documentId === closure.id), false);
  const debts = await f.report('debts', { partyType: 'employee' });
  assert.deepEqual([debts.summary.count, debts.summary.receivable, debts.summary.payable], [0, 0, 0]);
  assert.equal((await f.report('expenses')).summary.total, 400);
  const financial = await f.report('financial'); assert.equal(financial.summary.outgoing, 400);
  assert.equal(financial.rows.some(row => row.documentId === closure.id), false);
  const historicalAfter = await f.report('overview', pastPeriod);
  for (const key of ['expenses', 'workersPaid', 'workersAccrued', 'workersReserveChange', 'netOperatingResult', 'ownerAvailableProfit']) assert.equal(historicalAfter.summary[key], historical.summary[key], key);
  const closureDay = await f.report('overview', { allTime: false, from: '2026-11-04', to: '2026-11-04' });
  assert.deepEqual([closureDay.summary.expenses, closureDay.summary.sales, closureDay.summary.workersAccrued, closureDay.summary.workersPaid, closureDay.summary.workersReserveChange, closureDay.summary.ownerAvailableProfit], [0, 0, 0, 0, -600, 600]);

  const ledger = await f.report('party-ledger', { partyType: 'employee', partyId: employeeId });
  assert.deepEqual([ledger.summary.currentBalance, ledger.summary.closingBalance, ledger.summary.reconciliationDifference, ledger.summary.workersAccrued, ledger.summary.workersPaid, ledger.summary.workersReserveReleased], [0, 0, 0, 1000, 400, 600]);
  const closureRow = ledger.rows.find(row => row.documentId === closure.id);
  assert.deepEqual([closureRow.movementCode, closureRow.debit, closureRow.credit, closureRow.runningBalance, closureRow.noncash], ['employee-closure', 600, 0, 0, true]);
  const earlierLedger = await f.report('party-ledger', { partyType: 'employee', partyId: employeeId, ...pastPeriod });
  assert.deepEqual([earlierLedger.summary.closingBalance, earlierLedger.summary.currentBalance, earlierLedger.summary.workersReserveReleased], [-600, 0, 0]);
});

test('a deleted personal-deposit liability is noncash closure without wages, income, or phantom withdrawal', async t => {
  const f = await fixture(t), employeeId = await f.create({ entitlement: 'end' });
  await f.run({ type: 'employee-payment.post', employeeId, amount: 200, direction: 'deposit', paymentMethod: 'cash', occurredAt: '2026-11-02' }, '2026-11-02');
  await f.archive(employeeId); await f.remove(employeeId);
  const closure = await f.db.collection('documents').findOne({ kind: 'employee-closure', employeeId });
  assert.deepEqual([closure.total, closure.salaryReserveReleased], [200, 0]);
  const overview = await f.report('overview');
  assert.deepEqual([overview.summary.expenses, overview.summary.sales, overview.summary.netOperatingResult, overview.summary.currentWorkersUnpaidWages, overview.summary.currentPayable, overview.summary.ownerAvailableProfit], [0, 0, 0, 0, 0, 0]);
  assert.equal(await f.cash(), 10200);
  const ledger = await f.report('party-ledger', { partyType: 'employee', partyId: employeeId });
  assert.deepEqual([ledger.summary.workersPaid, ledger.summary.workersDeposited, ledger.summary.workersReserveReleased, ledger.summary.currentBalance, ledger.summary.reconciliationDifference], [0, 200, 0, 0, 0]);
  assert.equal((await f.report('expenses')).rows.length, 0);
});

test('a worker owing the shop cannot disappear from current receivables through permanent deletion', async t => {
  const f = await fixture(t), employeeId = await f.create({ entitlement: 'end' });
  await f.run({ type: 'employee-payment.post', employeeId, amount: 200, direction: 'withdraw', paymentMethod: 'cash', occurredAt: '2026-11-02' }, '2026-11-02');
  await f.archive(employeeId); const before = await f.snapshot();
  await assert.rejects(f.remove(employeeId), error => error.status === 409);
  assert.deepEqual(await f.snapshot(), before);
  const debts = await f.report('debts', { partyType: 'employee', debtSide: 'receivable' });
  assert.deepEqual(debts.rows.map(row => [row.employeeId, row.receivable]), [[employeeId, 200]]);
  assert.equal((await f.report('overview')).summary.currentWorkersReceivable, 200);
});

test('native restore retains deleted-worker closure provenance and paid expenses without resurrecting current debt', async t => {
  const f = await fixture(t), employeeId = await f.create();
  await f.run({ type: 'employee-payment.post', employeeId, amount: 400, direction: 'withdraw', paymentMethod: 'cash', occurredAt: '2026-11-02' }, '2026-11-02');
  await f.archive(employeeId); await f.remove(employeeId);
  const backup = parseAndValidateBackup(stringifyBackup(await createNativeBackup(f.db)));
  const overview = await f.report('overview'), ledger = await f.report('party-ledger', { partyType: 'employee', partyId: employeeId });
  await f.db.transaction(session => restoreNativeBackup(f.db, backup, session));
  const restored = await createNativeBackup(f.db);
  for (const name of ['employees', 'documents', 'financialMovements', 'paymentAccounts', 'auditEvents']) assert.deepEqual(restored.collections[name], backup.collections[name], name);
  assert.deepEqual(await f.report('overview'), overview);
  assert.deepEqual(await f.report('party-ledger', { partyType: 'employee', partyId: employeeId }), ledger);
  assert.equal(await f.cash(), 9600);
});

test('bootstrap hides tombstones from active/archive selectors but preserves authorized historical worker documents', async t => {
  const f = await fixture(t), employeeId = await f.create();
  await f.archive(employeeId); await f.remove(employeeId);
  const visibleId = await f.create({ name: 'Synthetic visible worker', startDate: '2030-01-01' });
  await f.db.collection('users').insertOne({ id: 'worker-reader', name: 'Synthetic reader', username: 'reader', isActive: true, permissions: ['employees.view'] });
  const response = await bootstrap(new Request('http://127.0.0.1:3237/api/bootstrap', { headers: { cookie: 'conta_session=' + createSession({ principalType: 'user', userId: 'worker-reader' }) } }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.employees.map(row => row.id), [visibleId]);
  assert(body.documents.some(row => row.employeeId === employeeId && row.kind === 'employee-accrual'));
  assert(body.documents.some(row => row.employeeId === employeeId && row.kind === 'employee-closure'));
});

test('noncash closure ledger ordering is deterministic and employee-only read guards precede broad records access', () => {
  const worker = { id: 'worker', name: 'Synthetic worker', balance: 0, isDeleted: true };
  const docs = [
    { id: 'closure', kind: 'employee-closure', employeeId: 'worker', status: 'posted', total: 600, balanceDelta: -600, salaryReserveReleased: 600, businessDate: '2026-11-01', occurredAt: '2026-11-01T12:00:00.000Z', employeeAccountOrder: 2 },
    { id: 'payment', kind: 'employee-payment', employeeId: 'worker', status: 'posted', total: 400, balanceDelta: -400, businessDate: '2026-11-01', occurredAt: '2026-11-01T12:00:00.000Z', employeeAccountOrder: 1 },
    { id: 'accrual', kind: 'employee-accrual', employeeId: 'worker', status: 'posted', total: 1000, balanceDelta: 1000, businessDate: '2026-11-01', occurredAt: '2026-11-01T12:00:00.000Z' },
  ];
  const ledger = buildEmployeeLedger(worker, docs);
  assert.deepEqual(ledger.rows.map(row => [row.id, row.runningBalance]), [['closure', 0], ['payment', -600], ['accrual', -1000]]);
  assert.deepEqual([ledger.summary.workersPaid, ledger.summary.workersReserveReleased, ledger.summary.reconciliationDifference], [400, 600, 0]);
  for (const capabilities of [[], ['records.view'], ['expenses.view'], ['employees.view']]) {
    const access = { can: capability => capabilities.includes(capability), customerPartyIds: new Set(), supplierPartyIds: new Set() };
    const allowed = capabilities.includes('employees.view');
    assert.equal(canReadDocumentKind('employee-closure', access), allowed);
    assert.equal(canReadDocument(docs[0], access), allowed);
    assert.equal(canReadOperationalDocument(docs[0], access), allowed);
    assert.equal(canReadOperationalDocument({ ...docs[0], status: 'voided' }, access), false);
  }
});
