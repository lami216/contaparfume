import assert from 'node:assert/strict';
import test, { after, before, beforeEach } from 'node:test';
import Database from 'better-sqlite3';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { handlePayrollCommand, accrueDueEmployees, payrollSummary, payrollExpenseEntries, validatePayrollSnapshot } from '../lib/payroll.ts';

let directory, sqlite, globalDb, POST, auth, backup;
const environment = new Map(), origin = 'http://127.0.0.1:3283', at = day => new Date(day + 'T15:00:00.000Z');
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'alkarna-worker-profile-correction-'));
  for (const [key, value] of Object.entries({ NODE_ENV: 'test', ALKARNA_DESKTOP: '1', ALKARNA_USER_DATA: join(directory, 'profile'), ALKARNA_DATABASE_PATH: join(directory, 'data.sqlite'), ALKARNA_LICENSE_STATE_PATH: join(directory, 'license-state.json'), ALKARNA_LICENSE_DISABLE_REGISTRY: '1', ALKARNA_TEST_LICENSE_BYPASS: '1' })) { environment.set(key, process.env[key]); process.env[key] = value; }
  sqlite = await import('../lib/sqlite.ts'); sqlite.closeDatabase(); globalDb = sqlite.initializeDatabase(); auth = await import('../lib/auth.ts'); backup = await import('../lib/backup.ts'); ({ POST } = await import('../app/api/command/route.ts'));
});
after(async () => { sqlite?.closeDatabase(); for (const [key, value] of environment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } if (directory) { const target = resolve(directory); assert(target.startsWith(resolve(tmpdir()) + sep) && target.split(sep).at(-1).startsWith('alkarna-worker-profile-correction-')); await rm(target, { recursive: true, force: true }); } });
beforeEach(async () => { await globalDb.dropDatabase(); await globalDb.collection('users').insertMany([{ id: 'owner', username: 'owner', isActive: true }, { id: 'reader', username: 'reader', isActive: true, permissions: ['employees.view'] }]); await globalDb.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic warehouse', isSalesDefault: true }); await globalDb.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', isActive: true, balance: 10000, openingBalance: 10000 }); });
async function fixture(t, amount = 100, more = {}) {
  const db = new sqlite.SqliteDatabase(new Database(':memory:')); sqlite.ensureDatabaseSchema(db); t.after(() => db.close()); await db.dropDatabase();
  await db.collection('warehouses').insertOne({ _id: 'w', name: 'Synthetic warehouse', isSalesDefault: true }); await db.collection('paymentAccounts').insertOne({ id: 'cash', code: 'cash', name: 'Synthetic cash', isActive: true, balance: 10000, openingBalance: 10000 });
  const run = (body, date = '2026-11-19') => handlePayrollCommand(db, {}, body, at(date));
  const id = await run({ type: 'employee.create', name: 'Synthetic worker', startDate: '2026-11-01', amount, intervalMonths: 1, entitlement: 'beginning', ...more }, '2026-11-01');
  const employee = () => db.collection('employees').findOne({ id });
  const docs = () => db.collection('documents').find({ employeeId: id }).toArray();
  const cash = async () => (await db.collection('paymentAccounts').findOne({ id: 'cash' })).balance;
  const funds = () => Promise.all(['paymentAccounts', 'financialMovements'].map(name => db.collection(name).find().toArray()));
  const all = () => Promise.all(['employees', 'documents', 'financialMovements', 'paymentAccounts', 'auditEvents', 'counters'].map(name => db.collection(name).find().toArray()));
  const sync = (date = '2026-11-19') => accrueDueEmployees(db, {}, { now: at(date), asOf: date });
  const edit = async (values, date = '2026-11-19') => run({ type: 'employee.update', employeeId: id, expectedRevision: (await employee()).revision, startDate: (await employee()).startDate, ...values }, date);
  const archive = async () => run({ type: 'employee.archive', employeeId: id, expectedRevision: (await employee()).revision });
  const remove = async () => run({ type: 'employee.delete', employeeId: id, expectedRevision: (await employee()).revision });
  const pay = (value, direction, date = '2026-11-05') => run({ type: 'employee-payment.post', employeeId: id, paymentMethod: 'cash', amount: value, occurredAt: date, ...(direction ? { direction } : {}) }, date);
  const validate = async () => validatePayrollSnapshot(await db.collection('employees').find().toArray(), await docs(), await db.collection('financialMovements').find().toArray(), await db.collection('auditEvents').find().toArray());
  return { db, run, id, employee, docs, cash, funds, all, sync, edit, archive, remove, pay, validate };
}

test('zero-wage accounts produce no zero accruals but retain ordinary withdrawals, deposits and backup compatibility', async t => {
  const f = await fixture(t, 0); assert.equal((await f.sync()).created, 0); assert.deepEqual(await f.docs(), []);
  await f.pay(40, 'withdraw'); assert.equal((await f.employee()).balance, -40); await f.pay(40, 'deposit', '2026-11-06'); assert.equal((await f.employee()).balance, 0); assert.equal(await f.cash(), 10000); assert.deepEqual(payrollExpenseEntries(await f.docs()), []); await f.validate();
  const file = backup.parseAndValidateBackup(backup.stringifyBackup(await backup.createNativeBackup(f.db))); await f.db.transaction(session => backup.restoreNativeBackup(f.db, file, session)); await f.validate(); assert.equal((await f.employee()).agreements[0].amount, 0);
});

test('explicit profile correction recalculates beginning/end/start and zero amount, while identical profile saves retain manual accrual corrections', async t => {
  const f = await fixture(t); await f.sync(); const original = (await f.docs())[0];
  await f.run({ type: 'employee-accrual.update', documentId: original.id, expectedRevision: 0, amount: 75, reason: 'Synthetic manual correction' });
  const manual = await f.db.collection('documents').findOne({ id: original.id }); await f.edit({ name: 'Synthetic renamed', amount: 100, intervalMonths: 1, entitlement: 'beginning' }); assert.deepEqual(await f.db.collection('documents').findOne({ id: original.id }), manual); assert.equal((await f.employee()).balance, 75);
  await f.edit({ entitlement: 'end' }); assert.equal((await f.employee()).balance, 0); assert.equal((await f.docs()).filter(row => row.status === 'posted').length, 0);
  await f.edit({ amount: 0, entitlement: 'beginning' }); assert.equal((await f.employee()).balance, 0); assert.equal((await f.sync()).created, 0);
  await f.edit({ amount: 100, startDate: '2026-11-02' }); assert.equal((await f.employee()).balance, 100); assert.equal((await f.docs()).filter(row => row.status === 'posted' && row.kind === 'employee-accrual').length, 1); await f.validate();
  assert(await f.db.collection('auditEvents').findOne({ action: 'payroll.employee-accrual.schedule-void' })); assert(await f.db.collection('auditEvents').findOne({ action: 'payroll.employee.schedule-correction' }));
});

for (const version of ['legacy-v1', 'independent-v2']) test(`${version} historical paid cash survives a later corrected start, same-date edit/void and native backup restore`, async t => {
  const f = await fixture(t); await f.sync('2026-11-01'); const payment = await f.pay(20, version === 'legacy-v1' ? undefined : 'withdraw'), paid = await f.db.collection('documents').findOne({ id: payment }), funds = await f.funds();
  await f.edit({ startDate: '2026-12-01', amount: 100, intervalMonths: 1, entitlement: 'beginning' }); assert.equal((await f.employee()).balance, -20); assert.equal((await f.employee()).accountStartDate, '2026-11-05'); assert.deepEqual(await f.funds(), funds);
  const after = await f.db.collection('documents').findOne({ id: payment });
  if (version === 'independent-v2') assert.deepEqual(after, paid);
  else { assert.equal(after.employeePaymentVersion, 2); assert.deepEqual(after.allocations, []); for (const key of ['id', 'number', 'revision', 'total', 'businessDate', 'occurredAt', 'paymentMethod']) assert.equal(after[key], paid[key]); assert(await f.db.collection('auditEvents').findOne({ action: 'payroll.employee-payment.schedule-rebase' })); }
  await f.validate(); const file = backup.parseAndValidateBackup(backup.stringifyBackup(await backup.createNativeBackup(f.db))); await f.db.transaction(session => backup.restoreNativeBackup(f.db, file, session)); await f.validate();
  await f.run({ type: 'employee-payment.update', documentId: payment, expectedRevision: after.revision, amount: 20, direction: 'withdraw', occurredAt: '2026-11-05', paymentMethod: 'cash', reason: 'Synthetic same-date historical edit' }); assert.equal((await f.employee()).balance, -20); assert.equal(await f.cash(), 9980); await f.validate();
  const revised = await f.db.collection('documents').findOne({ id: payment }); await f.run({ type: 'employee-payment.void', documentId: payment, expectedRevision: revised.revision, reason: 'Synthetic historical void' }); assert.equal((await f.employee()).balance, 0); assert.equal(await f.cash(), 10000); await f.validate();
});

test('repeated start corrections later then earlier retain canceled snapshots, unique periods and audit-proven old payment dates', async t => {
  const f = await fixture(t); await f.sync(); await f.pay(20, 'withdraw');
  await f.edit({ startDate: '2026-12-01', amount: 100, entitlement: 'beginning' }); await f.edit({ startDate: '2026-11-10', amount: 200, entitlement: 'beginning' }); assert.equal((await f.employee()).balance, 180);
  await f.edit({ startDate: '2026-11-01', amount: 100, entitlement: 'beginning' }); assert.equal((await f.employee()).balance, 80); const posted = (await f.docs()).filter(row => row.kind === 'employee-accrual' && row.status === 'posted'); assert.equal(posted.length, 1); assert.equal(posted[0].periodStart, '2026-11-01');
  await f.validate(); const before = await f.docs(), parsed = backup.parseAndValidateBackup(backup.stringifyBackup(await backup.createNativeBackup(f.db))); await f.db.transaction(session => backup.restoreNativeBackup(f.db, parsed, session)); assert.deepEqual(await f.docs(), before); await f.validate();
});

test('later archive retains the original cancellation evidence for an already corrected future agreement', async t => {
  const f = await fixture(t, 0, { startDate: '2026-12-01' }); await f.edit({ startDate: '2027-01-01', amount: 0 });
  const canceled = (await f.employee()).agreements.find(row => row.startDate === '2026-12-01');
  await f.run({ type: 'employee.archive', employeeId: f.id, expectedRevision: (await f.employee()).revision }, '2026-11-20');
  assert.deepEqual((await f.employee()).agreements.find(row => row.id === canceled.id), canceled); await f.validate();
  backup.parseAndValidateBackup(backup.stringifyBackup(await backup.createNativeBackup(f.db)));
});

test('future-start account permits only audited repayment of its previous debt before start, then zero-balance permanent deletion', async t => {
  const f = await fixture(t, 0); await f.pay(40, 'withdraw'); await f.edit({ startDate: '2026-12-01', amount: 0 });
  await assert.rejects(f.pay(1, 'withdraw', '2026-11-19'), /تاريخ الدفع/); await assert.rejects(f.pay(41, 'deposit', '2026-11-19'), /تاريخ الدفع/);
  const repayment = await f.pay(40, 'deposit', '2026-11-19'); assert.equal((await f.employee()).balance, 0); assert.equal(await f.cash(), 10000); assert.equal((await f.db.collection('documents').findOne({ id: repayment })).employeeHistoricalRepayment.beforeBalance, -40); await f.validate();
  await f.archive(); await f.remove(); assert.equal((await f.employee()).isDeleted, true); assert.equal((await f.docs()).filter(row => row.kind === 'employee-closure').length, 0); await f.validate();
  const file = backup.parseAndValidateBackup(backup.stringifyBackup(await backup.createNativeBackup(f.db))); await f.db.transaction(session => backup.restoreNativeBackup(f.db, file, session)); await f.validate(); assert.equal(await f.cash(), 10000);
});

test('archived positive balance closes liability/reserve once without cash, wage expense or rewriting paid/accrual history', async t => {
  const f = await fixture(t); await f.sync(); const payment = await f.pay(20, 'withdraw'); await f.archive(); const paid = await f.db.collection('documents').findOne({ id: payment }), beforeDocs = await f.docs(), funds = await f.funds(), expense = payrollExpenseEntries(beforeDocs);
  await f.remove(); const employee = await f.employee(), closure = (await f.docs()).find(row => row.kind === 'employee-closure');
  assert.equal(employee.isDeleted, true); assert.equal(employee.isArchived, true); assert.equal(employee.balance, 0); assert.equal(employee.deletionDocumentId, closure.id); assert.deepEqual([closure.total, closure.balanceDelta, closure.salaryReserveReleased, closure.cashAmount], [80, -80, 80, 0]);
  assert.deepEqual(await f.funds(), funds); assert.deepEqual(await f.db.collection('documents').findOne({ id: payment }), paid); assert.deepEqual((await f.docs()).filter(row => row.kind !== 'employee-closure'), beforeDocs); assert.deepEqual(payrollExpenseEntries(await f.docs()), expense);
  const summary = payrollSummary([employee], await f.docs()); assert.deepEqual([summary.currentOwed, summary.currentUnpaidWages, summary.paidPeriod, summary.reserveChange], [0, 0, 20, 0]); await f.validate();
  await assert.rejects(f.run({ type: 'employee.restore', employeeId: f.id, expectedRevision: employee.revision, resumeDate: '2026-12-01' }), /محذوف نهائي/); await assert.rejects(f.remove(), /محذوف نهائي/);
  const parsed = backup.parseAndValidateBackup(backup.stringifyBackup(await backup.createNativeBackup(f.db))); await f.db.transaction(session => backup.restoreNativeBackup(f.db, parsed, session)); await f.validate();
});

test('personal deposits close with zero salary reserve and no fabricated wage/income; negative and active deletion attempts roll back', async t => {
  const f = await fixture(t, 0); await f.pay(30, 'withdraw'); const active = await f.all(); await assert.rejects(f.remove(), /أرشيف/); assert.deepEqual(await f.all(), active); await f.archive(); const debt = await f.all(); await assert.rejects(f.remove(), error => error.status === 409 && /دين.*للمحل/.test(error.message)); assert.deepEqual(await f.all(), debt);
  const g = await fixture(t, 0); await g.pay(100, 'deposit'); await g.archive(); const funds = await g.funds(); await g.remove(); const closure = (await g.docs()).find(row => row.kind === 'employee-closure'); assert.equal(closure.salaryReserveReleased, 0); assert.equal(closure.total, 100); assert.deepEqual(payrollExpenseEntries(await g.docs()), []); assert.deepEqual(await g.funds(), funds); assert.equal(payrollSummary([await g.employee()], await g.docs()).reserveChange, 0); await g.validate();
});

test('recalculation failure is atomic and a healthy no-change save does not replace existing manual entitlement or payment snapshots', async t => {
  const f = await fixture(t); await f.sync(); await f.pay(20, 'withdraw'); const before = await f.all();
  f.db.native.exec("CREATE TRIGGER synthetic_worker_recompute_failure BEFORE INSERT ON documents WHEN json_extract(NEW.data_json,'$.context')='profile-correction' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_WORKER_RECOMPUTE_FAILURE'); END");
  try { await assert.rejects(f.edit({ startDate: '2026-11-02', amount: 200 }), /SYNTHETIC_WORKER_RECOMPUTE_FAILURE/); assert.deepEqual(await f.all(), before); } finally { f.db.native.exec('DROP TRIGGER synthetic_worker_recompute_failure'); }
  await f.edit({ startDate: '2026-11-02', amount: 200 }); assert.equal((await f.employee()).balance, 180); await f.validate();
});

test('backup rejects forged tombstones, closure amounts and unaudited historical dates without loosening old worker backups', async t => {
  const f = await fixture(t); await f.sync(); await f.archive(); await f.remove(); const file = await backup.createNativeBackup(f.db); backup.parseAndValidateBackup(backup.stringifyBackup(file));
  for (const mutate of [b => { b.collections.auditEvents = b.collections.auditEvents.filter(event => event.action !== 'payroll.employee.delete'); }, b => { b.collections.documents.find(row => row.kind === 'employee-closure').salaryReserveReleased = 1; }, b => { b.collections.employees[0].balance = 1; }, b => { b.collections.employees[0].accountStartDate = 'not-a-date'; }]) { const invalid = structuredClone(file); mutate(invalid); assert.throws(() => backup.parseAndValidateBackup(backup.stringifyBackup(invalid)), /الموظفين|العامل|استحقاق|التاريخ/); }
  const z = await fixture(t, 0); await z.archive(); await z.remove(); const zero = await backup.createNativeBackup(z.db); zero.collections.auditEvents = zero.collections.auditEvents.filter(event => event.action !== 'payroll.employee.delete'); assert.throws(() => backup.parseAndValidateBackup(backup.stringifyBackup(zero)), /الموظفين/);
  const old = await fixture(t); await old.sync(); const legacy = await backup.createNativeBackup(old.db); assert.equal(backup.parseAndValidateBackup(backup.stringifyBackup(legacy)).collections.employees.length, 1);
});

const post = async (body, key = randomUUID(), principal = { principalType: 'owner' }) => { const response = await POST(new Request(origin + '/api/command', { method: 'POST', headers: { Origin: origin, Host: '127.0.0.1:3283', 'Content-Type': 'application/json', 'Idempotency-Key': key, Cookie: `conta_session=${auth.createSession(principal)}` }, body: JSON.stringify(body) })); return { status: response.status, body: await response.json() }; };
const posted = async body => { const response = await post(body); assert.equal(response.status, 200, JSON.stringify(response)); return response.body.id; };
test('actual POST capability, permanent-delete idempotency and failed same-key retry preserve the real bank ledger', async () => {
  const startDate = new Date().toISOString().slice(0, 10), id = await posted({ type: 'employee.create', name: 'Synthetic POST worker', startDate, amount: 0, intervalMonths: 1, entitlement: 'beginning' });
  const body = { type: 'employee.delete', employeeId: id, expectedRevision: 0 }, key = randomUUID(); assert.equal((await post(body, key, { principalType: 'user', userId: 'reader' })).status, 403); assert.equal((await post(body, key)).status, 409); assert.equal(await globalDb.collection('commandReceipts').findOne({ _id: key }), null);
  await posted({ type: 'employee.archive', employeeId: id, expectedRevision: 0 }); const request = { ...body, expectedRevision: 1 }, response = await post(request, key); assert.equal(response.status, 200, JSON.stringify(response));
  const snapshot = () => Promise.all(['employees', 'documents', 'financialMovements', 'paymentAccounts', 'auditEvents', 'commandReceipts'].map(name => globalDb.collection(name).find().toArray())); const stable = await snapshot(); assert.deepEqual(await post(request, key), response); assert.deepEqual(await snapshot(), stable); assert.equal((await globalDb.collection('paymentAccounts').findOne({ id: 'cash' })).balance, 10000);
  assert.equal((await post({ type: 'employee.restore', employeeId: id, expectedRevision: 2, resumeDate: startDate })).status, 409); assert.equal(await globalDb.collection('documents').countDocuments({ kind: 'employee-closure' }), 0);
});
